//! [`pocket_drivers::Renderer`] over an EPIC executor.
//!
//! Targets are device-owned RGB565 framebuffers named by display handles.
//! A frame's commands stay in flight after `render` returns and complete at
//! the next `render`, `wait` or `retire`; frames that read a portable
//! registration complete before `render` returns, because the core storage
//! they read is borrowed for the call only.

use alloc::vec::Vec;
use core::sync::atomic::{AtomicUsize, Ordering};

use pocket_drivers::{
    DeviceTarget, FrameInput, PixelFormat, Rect as Region, RenderError, RenderResources, Renderer,
    RendererDescriptor, Synchronization, Target, TargetOwnership,
};
use pocket_raster::MAX_RENDER_SCALE;
use pocket_spec as spec;

use crate::emit::Context;
use crate::executor::{ExecError, Executor};
use crate::geom::{covering_clip, Clip, Rect};
use crate::native::NativeTable;
use crate::plan::{self, PlanItem};
use crate::textures::Textures;

/// Renderer configuration. Executor capabilities come from the executor.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RendererConfig {
    /// Physical pixels per logical pixel, 1 through 4.
    pub scale: u32,
    /// Textures registered with the executor at once.
    pub max_textures: usize,
}

impl Default for RendererConfig {
    fn default() -> Self {
        Self {
            scale: 1,
            max_textures: 32,
        }
    }
}

/// Accounting for the last rendered frame.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RenderStats {
    /// Opaque and translucent solid fills submitted to hardware.
    pub epic_fills: u32,
    pub epic_gradients: u32,
    /// A8 coverage blends.
    pub epic_blends: u32,
    /// Texture blits and four-point quads.
    pub epic_copies: u32,
    /// DrawList operations rendered by the CPU.
    pub software_ops: u32,
    pub software_words: u32,
    /// Fences issued before CPU work or plane reuse.
    pub fences: u32,
    /// CPU fallback tile round-trips and the physical pixels they copied.
    pub cpu_tiles: u32,
    pub cpu_tile_pixels: u32,
    /// Bands of A8 runs split across more than one plane.
    pub mask_bands: u32,
    /// Damage rectangles of the frame and their physical area.
    pub damage_regions: u32,
    pub damage_pixels: u32,
}

/// Distinguishes the submissions of renderer instances.
static OWNERS: AtomicUsize = AtomicUsize::new(1);

#[derive(Debug, PartialEq, Eq)]
pub struct Submission {
    owner: usize,
    id: u64,
}

struct Pending {
    id: u64,
    /// The wait result once the frame's commands completed or stopped.
    completion: Option<Result<(), RenderError>>,
}

pub struct EpicRenderer<E: Executor> {
    executor: E,
    owner: usize,
    config: RendererConfig,
    textures: Textures,
    plan: Vec<PlanItem>,
    fallback: Vec<u32>,
    regions: Vec<Clip>,
    mask_index: u8,
    next: u64,
    in_flight: Option<u64>,
    pending: Vec<Pending>,
    stats: RenderStats,
}

impl<E: Executor> EpicRenderer<E> {
    /// `native` is the `.epic` table, 64-byte aligned. Fails for a scale
    /// outside 1 through 4, an executor whose tiles or planes cannot hold
    /// one logical pixel, or a malformed table.
    pub fn new(
        config: RendererConfig,
        native: Option<&'static [u8]>,
        executor: E,
    ) -> Result<Self, RenderError> {
        let caps = executor.caps();
        let pixel = config.scale * config.scale;
        if !(1..=MAX_RENDER_SCALE).contains(&config.scale)
            || caps.tile_pixels < pixel
            || (caps.a8_blend && caps.mask_bytes < pixel)
            || caps.coordinate_limit < config.scale
        {
            return Err(RenderError::Unsupported);
        }
        let native = match native {
            Some(bytes) => Some(NativeTable::parse(bytes).ok_or(RenderError::Unsupported)?),
            None => None,
        };
        Ok(Self {
            executor,
            owner: OWNERS.fetch_add(1, Ordering::Relaxed),
            config,
            textures: Textures::new(native, config.max_textures),
            plan: Vec::new(),
            fallback: Vec::new(),
            regions: Vec::new(),
            mask_index: 0,
            next: 1,
            in_flight: None,
            pending: Vec::new(),
            stats: RenderStats::default(),
        })
    }

    pub fn config(&self) -> RendererConfig {
        self.config
    }

    pub fn stats(&self) -> RenderStats {
        self.stats
    }

    /// Complete the in-flight frame and record its result.
    fn complete(&mut self) {
        let Some(id) = self.in_flight.take() else {
            return;
        };
        let result = self.executor.end().map_err(|_| RenderError::Failed);
        if let Some(pending) = self.pending.iter_mut().find(|pending| pending.id == id) {
            pending.completion = Some(result);
        }
    }

    fn render_frame(
        &mut self,
        words: &[u32],
        res: &dyn RenderResources,
        damage: &[Region],
        target: &DeviceTarget,
        id: u64,
    ) -> Result<bool, RenderError> {
        if target.format != PixelFormat::Rgb565 {
            return Err(RenderError::Unsupported);
        }
        let (viewport_w, viewport_h) = res.viewport();
        let (logical_w, logical_h) = (viewport_w as u32, viewport_h as u32);
        let scale = self.config.scale;
        let width = logical_w
            .checked_mul(scale)
            .ok_or(RenderError::InvalidFrame)?;
        let height = logical_h
            .checked_mul(scale)
            .ok_or(RenderError::InvalidFrame)?;
        let region = Rect {
            x: target.region.x,
            y: target.region.y,
            w: target.region.width,
            h: target.region.height,
        };
        if width == 0
            || height == 0
            || logical_w as f32 != viewport_w
            || logical_h as f32 != viewport_h
            || region.x.checked_add(region.w).is_none_or(|x1| x1 > width)
            || region.y.checked_add(region.h).is_none_or(|y1| y1 > height)
        {
            return Err(RenderError::InvalidFrame);
        }
        let surface = Clip::new(0, 0, logical_w as i32, logical_h as i32);
        self.regions.clear();
        self.stats = RenderStats::default();
        for damage in damage {
            let damage = Rect {
                x: damage.x,
                y: damage.y,
                w: damage.width,
                h: damage.height,
            }
            .intersect(region);
            if damage.is_empty() {
                continue;
            }
            self.regions
                .push(covering_clip(damage, scale).intersect(surface));
            self.stats.damage_regions += 1;
            self.stats.damage_pixels = self.stats.damage_pixels.saturating_add(damage.area());
        }
        if self.regions.is_empty() {
            return Ok(false);
        }
        plan::build(res, &mut self.textures, words, surface, &mut self.plan)
            .ok_or(RenderError::InvalidFrame)?;
        self.executor
            .begin(target.handle, width, height)
            .map_err(|error| match error {
                ExecError::Unsupported => RenderError::InvalidFrame,
                ExecError::Failed => RenderError::Failed,
            })?;
        let mut context = Context::new(
            &mut self.executor,
            &mut self.textures,
            res,
            scale,
            surface,
            id,
            &mut self.stats,
            &mut self.fallback,
            &mut self.mask_index,
        );
        for &region in &self.regions {
            context
                .clear_region(region)
                .and_then(|()| context.emit_region(words, &self.plan, region))
                .ok_or(RenderError::Failed)?;
        }
        Ok(context.portable_used)
    }
}

impl<E: Executor> EpicRenderer<E> {
    /// [`Renderer::render`] over borrowed DrawList words, for callers that
    /// hold no [`pocket_drivers::DrawList`].
    pub fn render_parts(
        &mut self,
        words: &[u32],
        res: &dyn RenderResources,
        damage: &[Region],
        target: &DeviceTarget,
    ) -> Result<Submission, RenderError> {
        let id = self.next;
        self.next = id.checked_add(1).ok_or(RenderError::Failed)?;
        self.pending
            .try_reserve(1)
            .map_err(|_| RenderError::Failed)?;
        // The previous frame completes before this one binds a target.
        self.complete();
        match self.render_frame(words, res, damage, target, id) {
            Ok(synchronous) => {
                let completion = if synchronous {
                    Some(self.executor.end().map_err(|_| RenderError::Failed))
                } else if self.regions.is_empty() {
                    Some(Ok(()))
                } else {
                    self.in_flight = Some(id);
                    None
                };
                self.pending.push(Pending { id, completion });
                Ok(Submission {
                    owner: self.owner,
                    id,
                })
            }
            Err(error) => {
                // Errors leave no work in flight and no references behind.
                let _ = self.executor.end();
                self.textures.retire(&mut self.executor, id);
                Err(error)
            }
        }
    }
}

impl<E: Executor> Renderer for EpicRenderer<E> {
    type Submission = Submission;

    fn descriptor(&self) -> RendererDescriptor {
        RendererDescriptor::new(
            &[PixelFormat::Rgb565],
            TargetOwnership::DeviceOwned,
            Synchronization::Deferred,
            spec::DRAW_LIST_VERSION,
            false,
        )
        .unwrap()
    }

    fn render(&mut self, frame: &mut FrameInput<'_>) -> Result<Submission, RenderError> {
        let Target::DeviceOwned(target) = &frame.target else {
            return Err(RenderError::Unsupported);
        };
        self.render_parts(&frame.list.words, frame.resources, frame.damage, target)
    }

    fn wait(&mut self, submission: &Submission) -> Result<(), RenderError> {
        if submission.owner != self.owner {
            return Err(RenderError::InvalidFrame);
        }
        if self.in_flight == Some(submission.id) {
            self.complete();
        }
        self.pending
            .iter()
            .find(|pending| pending.id == submission.id)
            .and_then(|pending| pending.completion)
            .unwrap_or(Err(RenderError::InvalidFrame))
    }

    fn retire(&mut self, submission: Submission) {
        if submission.owner != self.owner {
            return;
        }
        let Some(index) = self
            .pending
            .iter()
            .position(|pending| pending.id == submission.id)
        else {
            return;
        };
        if self.in_flight == Some(submission.id) {
            self.complete();
        }
        self.pending.swap_remove(index);
        self.textures.retire(&mut self.executor, submission.id);
    }
}

impl<E: Executor> Drop for EpicRenderer<E> {
    fn drop(&mut self) {
        self.complete();
        for pending in self.pending.drain(..) {
            self.textures.retire(&mut self.executor, pending.id);
        }
        self.textures.clear(&mut self.executor);
    }
}
