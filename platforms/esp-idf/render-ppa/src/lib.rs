//! ESP PPA rendering with ordered software fallback and bounded A8 storage.
//! Hardware operations finish before returning, including error paths.
#![no_std]
extern crate alloc;
use alloc::vec::Vec;
use pocket_draw_ops::{DrawOps, Operation};
use pocket_drivers::{
    DamageRect as Clip, PixelFormat, RenderError, RenderResources, Surface, TexView,
};
use pocket_glyph_pages::composite_mask;
use pocket_raster::{linear_sample_coordinates, pack_rgb565, render_operation, OperationResources};
use pocket_spec as spec;
const MASK_ALIGNMENT: usize = 128;
const TEXTURE_CLASS_CACHE_LEN: usize = 64;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PpaError {
    Unsupported,
    Failed,
}
fn accelerated(result: Result<(), PpaError>) -> Result<bool, RenderError> {
    match result {
        Ok(()) => Ok(true),
        Err(PpaError::Unsupported) => Ok(false),
        Err(PpaError::Failed) => Err(RenderError::Failed),
    }
}
/// Integer pixel rectangle, using half-open bounds.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Rect {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

impl Rect {
    #[inline]
    pub const fn area(self) -> u32 {
        self.w.saturating_mul(self.h)
    }

    #[inline]
    pub const fn is_empty(self) -> bool {
        self.w == 0 || self.h == 0
    }
}

/// Quarter-turn transform supported by the PPA SRM engine.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum QuarterTurn {
    #[default]
    None,
    Ccw90,
    Ccw180,
    Ccw270,
}

/// Scale/rotate/mirror controls passed to the host's PPA SRM implementation.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SrmTransform {
    pub rotation: QuarterTurn,
    pub mirror_x: bool,
    pub mirror_y: bool,
}

/// Narrow hardware surface implemented by an ESP-IDF host.
///
/// All calls are synchronous from the DrawList interpreter's perspective:
/// on every return, the destination pixels must be visible to
/// subsequent CPU or PPA operations. `Unsupported` is allowed only before any write and requests ordered
/// software fallback. `Failed` is terminal and prevents display flush.
#[allow(clippy::too_many_arguments)]
pub trait PpaOps {
    /// Fill `rect` in the full RGB565 destination.
    fn fill_rgb565(
        &mut self,
        destination: &mut [u16],
        width: u32,
        height: u32,
        rect: Rect,
        color: u16,
    ) -> Result<(), PpaError>;

    /// Blend an A8 plane over the full RGB565 destination with one fixed RGB
    /// color. `global_alpha` scales every coverage byte.
    fn blend_a8_rgb565(
        &mut self,
        destination: &mut [u16],
        width: u32,
        height: u32,
        mask: &[u8],
        rect: Rect,
        color: [u8; 3],
        global_alpha: u8,
    ) -> Result<(), PpaError>;

    /// Copy an opaque PSP PSM 5650 texture into the RGB565 destination with
    /// PPA SRM. PSM 5650 stores R and B opposite to ESP RGB565, so the host
    /// must enable the PPA input RGB swap.
    fn srm_psm5650_to_rgb565(
        &mut self,
        destination: &mut [u16],
        width: u32,
        height: u32,
        source: &[u8],
        source_width: u32,
        source_height: u32,
        source_rect: Rect,
        destination_rect: Rect,
        transform: SrmTransform,
    ) -> Result<(), PpaError>;
}

/// Heuristics controlling when transaction overhead is worth paying.
#[derive(Clone, Copy, Debug)]
pub struct RendererConfig {
    pub scale: u32,
    pub min_fill_pixels: u32,
    pub min_blend_pixels: u32,
    pub min_srm_pixels: u32,
}

impl Default for RendererConfig {
    fn default() -> Self {
        Self {
            scale: 1,
            min_fill_pixels: 1024,
            min_blend_pixels: 256,
            min_srm_pixels: 256,
        }
    }
}

/// Per-frame backend accounting for profiling and regression logs.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RenderStats {
    pub ppa_fills: u32,
    pub ppa_blends: u32,
    pub ppa_srm: u32,
    pub software_ops: u32,
    pub software_words: u32,
    /// Number of disjoint physical framebuffer regions repainted.
    pub damage_regions: u32,
    /// Total physical pixels repainted across all damage regions.
    pub damage_pixels: u32,
    /// Bounding rectangle of every repainted physical region.
    pub damage_bounds: Rect,
    /// True for an initial, invalidated, or heuristically promoted full frame.
    pub full_redraw: bool,
}

/// Per-instance painter state. Presentation and persistent-buffer history are
/// owned by pocket-present, never by this driver.
pub struct Painter {
    config: RendererConfig,
    mask_storage: Vec<u128>,
    mask_offset: usize,
    mask_capacity: usize,
    mask_len: usize,
    mask_budget: usize,
    alpha_texture_cache: Vec<(i32, u64, bool)>,
    raster_revision: u64,
}
impl Painter {
    /// mask_budget bounds the A8 payload; alignment storage adds at most 143
    /// bytes. Zero disables A8 acceleration without disabling fill or SRM.
    pub fn new(config: RendererConfig, mask_budget: usize) -> Result<Self, RenderError> {
        if !(1..=pocket_raster::MAX_RENDER_SCALE).contains(&config.scale) {
            return Err(RenderError::Unsupported);
        }
        Ok(Self {
            config,
            mask_storage: Vec::new(),
            mask_offset: 0,
            mask_capacity: 0,
            mask_len: 0,
            mask_budget,
            alpha_texture_cache: Vec::new(),
            raster_revision: 0,
        })
    }
    pub fn config(&self) -> RendererConfig {
        self.config
    }
    /// Active A8 payload bytes for the most recent accelerated strip. This is
    /// bounded by mask_budget; allocation includes at most 143 alignment bytes.
    pub fn scratch_bytes(&self) -> usize {
        self.mask_len
    }
    /// Retained allocation, including alignment and previous larger strips.
    pub fn allocated_scratch_bytes(&self) -> usize {
        self.mask_storage.capacity() * core::mem::size_of::<u128>()
    }
    pub fn invalidate_resources(&mut self) {
        self.alpha_texture_cache.clear();
        self.raster_revision = 0;
    }
    fn sync_resources(&mut self, resources: &(impl RenderResources + ?Sized)) {
        if self.raster_revision != resources.raster_revision() {
            self.alpha_texture_cache.clear();
            self.raster_revision = resources.raster_revision();
        }
    }
    fn ensure_mask(&mut self, len: usize) -> bool {
        if len > self.mask_budget {
            return false;
        }
        if self.mask_capacity < len {
            let Some(bytes) = len.checked_add(MASK_ALIGNMENT - 1) else {
                return false;
            };
            let count = bytes.div_ceil(16);
            let mut storage = Vec::new();
            if storage.try_reserve_exact(count).is_err() {
                return false;
            }
            storage.resize(count, 0u128);
            self.mask_storage = storage;
            let base = self.mask_storage.as_ptr() as usize;
            self.mask_offset = (MASK_ALIGNMENT - base % MASK_ALIGNMENT) % MASK_ALIGNMENT;
            self.mask_capacity = len;
        }
        self.mask_len = len;
        true
    }
    /// Every device call is synchronous. Unsupported surfaces retain the
    /// software byte path; unaligned RGB565 never becomes a u16 slice.
    pub fn render<O: PpaOps>(
        &mut self,
        resources: &(impl RenderResources + ?Sized),
        words: &[u32],
        target: &mut Surface<'_>,
        ppa: &mut O,
    ) -> Result<RenderStats, RenderError> {
        self.render_clipped(resources, words, target, None, ppa)
    }
    /// Compatibility entry for callers retaining a full strip while repainting
    /// a logical subrectangle. New presenters acquire the required region.
    pub fn render_clipped<O: PpaOps>(
        &mut self,
        resources: &(impl RenderResources + ?Sized),
        words: &[u32],
        target: &mut Surface<'_>,
        requested: Option<Clip>,
        ppa: &mut O,
    ) -> Result<RenderStats, RenderError> {
        if target.format() != PixelFormat::Rgb565 {
            return Err(RenderError::Unsupported);
        }
        let (vw, vh) = resources.viewport();
        if !vw.is_finite()
            || !vh.is_finite()
            || vw < 1.0
            || vh < 1.0
            || vw >= i32::MAX as f32
            || vh >= i32::MAX as f32
        {
            return Err(RenderError::InvalidFrame);
        }
        let viewport = Clip::new(0, 0, vw as i32, vh as i32);
        pocket_draw_ops::validate(words, viewport).map_err(|_| RenderError::InvalidFrame)?;
        // A no-draw operation applies raster's checked surface/viewport bounds.
        let noop = Operation {
            opcode: spec::draw_op::SCISSOR_POP,
            words: &[spec::draw_op::SCISSOR_POP],
            clip: viewport,
        };
        render_operation(resources, &noop, target, self.config.scale)?;
        self.sync_resources(resources);
        let region = target.region();
        let stride = target.stride_bytes();
        let scale = self.config.scale;
        let mut stats = RenderStats {
            damage_regions: 1,
            damage_pixels: region.width.saturating_mul(region.height),
            damage_bounds: Rect {
                x: region.x,
                y: region.y,
                w: region.width,
                h: region.height,
            },
            full_redraw: true,
            ..RenderStats::default()
        };
        let hardware = region.x % scale == 0
            && region.y % scale == 0
            && region.width % scale == 0
            && region.height % scale == 0
            && stride == region.width as usize * 2
            && target.pixels().as_ptr().align_offset(2) == 0;
        let surface = Clip::new(
            (region.x / scale) as i32,
            (region.y / scale) as i32,
            ((region.x + region.width).div_ceil(scale)) as i32,
            ((region.y + region.height).div_ceil(scale)) as i32,
        );
        let draw_clip = requested
            .unwrap_or(surface)
            .intersect(surface)
            .intersect(viewport);
        let physical = physical_rect(draw_clip, scale);
        let x0 = physical.x.max(region.x);
        let y0 = physical.y.max(region.y);
        let x1 = (physical.x + physical.w).min(region.x + region.width);
        let y1 = (physical.y + physical.h).min(region.y + region.height);
        let physical = Rect {
            x: x0,
            y: y0,
            w: x1.saturating_sub(x0),
            h: y1.saturating_sub(y0),
        };
        if requested.is_some() {
            stats.damage_pixels = physical.area();
            stats.damage_bounds = physical;
        }
        if draw_clip.is_empty() || physical.is_empty() {
            return Ok(stats);
        }
        let clear = Rect {
            x: physical.x - region.x,
            y: physical.y - region.y,
            w: physical.w,
            h: physical.h,
        };
        let count = region.width as usize * region.height as usize;
        let mut cleared = false;
        if hardware && clear.area() >= self.config.min_fill_pixels {
            // Checked alignment, exact RGB565 packed length, and exclusive borrow.
            let pixels = unsafe {
                core::slice::from_raw_parts_mut(
                    target.pixels_mut().as_mut_ptr().cast::<u16>(),
                    count,
                )
            };
            cleared = accelerated(ppa.fill_rgb565(pixels, region.width, region.height, clear, 0))?;
            if cleared {
                stats.ppa_fills += 1;
            }
        }
        if !cleared {
            if requested.is_none() && !hardware {
                // Physical acquisitions need not begin on a logical-pixel edge.
                for row in 0..region.height as usize {
                    target.pixels_mut()[row * stride..row * stride + region.width as usize * 2]
                        .fill(0);
                }
            } else {
                for row in clear.y as usize..(clear.y + clear.h) as usize {
                    let start = row * stride + clear.x as usize * 2;
                    target.pixels_mut()[start..start + clear.w as usize * 2].fill(0);
                }
            }
        }
        let mut offset = 0usize;
        let mut skip_until = 0usize;
        for decoded in DrawOps::new(words, viewport) {
            let mut operation = decoded.map_err(|_| RenderError::InvalidFrame)?;
            if let Some(requested) = requested {
                operation.clip = operation.clip.intersect(requested);
            }
            let start = offset;
            offset += operation.words.len();
            if start < skip_until {
                continue;
            }
            let clip = operation.clip.intersect(draw_clip);
            if clip.is_empty() {
                continue;
            }
            let bounds = match operation.opcode {
                spec::draw_op::RECT | spec::draw_op::GRAD_RECT => {
                    Some(logical_rect(operation.words[1], operation.words[2]))
                }
                spec::draw_op::TEX_QUAD | spec::draw_op::SURFACE_QUAD => {
                    Some(logical_rect(operation.words[2], operation.words[3]))
                }
                _ => None,
            };
            if bounds.is_some_and(|bounds| bounds.intersect(clip).is_empty()) {
                continue;
            }
            let cached = OperationResources::new(resources, &operation, scale)?;
            let mut drawn = false;
            if hardware && !clip.is_empty() {
                let mask_ready = self.ensure_mask(count);
                let pixels = unsafe {
                    core::slice::from_raw_parts_mut(
                        target.pixels_mut().as_mut_ptr().cast::<u16>(),
                        count,
                    )
                };
                match operation.opcode {
                    spec::draw_op::RECT if operation.words[3] >> 24 == 255 || mask_ready => {
                        let logical =
                            logical_rect(operation.words[1], operation.words[2]).intersect(clip);
                        if !logical.is_empty() {
                            drawn = self.try_rect(
                                pixels,
                                region.width,
                                region.height,
                                surface,
                                logical,
                                operation.words[3],
                                ppa,
                                &mut stats,
                            )?;
                        }
                    }
                    spec::draw_op::GLYPH_RUN if mask_ready => {
                        if !glyph_run_bounds(&cached, operation.words, clip).is_empty() {
                            drawn = self.try_glyph_run(
                                &cached,
                                pixels,
                                region.width,
                                region.height,
                                surface,
                                clip,
                                operation.words,
                                ppa,
                                &mut stats,
                            )?;
                        }
                    }
                    spec::draw_op::TEX_QUAD
                        if mask_ready
                            || cached
                                .texture(operation.words[1] as i32)
                                .is_some_and(|v| v.psm == spec::psm::PSM_5650) =>
                    {
                        if let Some(end) = self.try_tex_quad_run(
                            &cached,
                            words,
                            start,
                            pixels,
                            region.width,
                            region.height,
                            surface,
                            clip,
                            ppa,
                            &mut stats,
                        )? {
                            skip_until = end;
                            drawn = true;
                        }
                    }
                    _ => {}
                }
            }
            if !drawn {
                render_operation(&cached, &operation, target, scale)?;
                if !matches!(
                    operation.opcode,
                    spec::draw_op::SCISSOR
                        | spec::draw_op::SCISSOR_POP
                        | spec::draw_op::TEXT_RUN
                        | spec::draw_op::SURFACE_QUAD
                ) {
                    stats.software_ops += 1;
                    stats.software_words += operation.words.len() as u32;
                }
            }
        }
        Ok(stats)
    }
    #[allow(clippy::too_many_arguments)]
    fn try_rect<O: PpaOps>(
        &mut self,
        destination: &mut [u16],
        width: u32,
        height: u32,
        surface: Clip,
        logical: Clip,
        color: u32,
        ppa: &mut O,
        stats: &mut RenderStats,
    ) -> Result<bool, RenderError> {
        let (r, g, b, a) = channels(color);
        if a == 0 {
            return Ok(true);
        }
        let rect = local_physical_rect(logical, surface, self.config.scale);
        if a == 255 && rect.area() >= self.config.min_fill_pixels {
            if accelerated(ppa.fill_rgb565(destination, width, height, rect, pack_rgb565(r, g, b)))?
            {
                stats.ppa_fills += 1;
                return Ok(true);
            }
        } else if rect.area() >= self.config.min_blend_pixels {
            let mask = self.mask_mut();
            fill_mask_rect(mask, width, rect, a as u8);
            if accelerated(ppa.blend_a8_rgb565(
                destination,
                width,
                height,
                mask,
                rect,
                [r as u8, g as u8, b as u8],
                255,
            ))? {
                stats.ppa_blends += 1;
                return Ok(true);
            }
        }
        Ok(false)
    }

    #[allow(clippy::too_many_arguments)]
    fn try_glyph_run<O: PpaOps>(
        &mut self,
        ui: &(impl RenderResources + ?Sized),
        destination: &mut [u16],
        width: u32,
        height: u32,
        surface: Clip,
        clip: Clip,
        op: &[u32],
        ppa: &mut O,
        stats: &mut RenderStats,
    ) -> Result<bool, RenderError> {
        let slot = (op[1] & 0xff) as u8;
        let color = op[2];
        let (r, g, b, a) = channels(color);
        if a == 0 {
            return Ok(true);
        }
        let Some(atlas) = ui.font_atlas(slot) else {
            return Ok(true);
        };
        let scale = self.config.scale as i32;
        let cell_w = atlas.cell_w as i32;
        let cell_h = atlas.cell_h as i32;
        let mut bounds = Clip::empty();
        for glyph in op[3..].as_chunks::<2>().0.iter() {
            let (x, y) = xy(glyph[0]);
            let gid = (glyph[1] & 0xffff) as u16;
            if gid < atlas.glyph_count {
                bounds = bounds.union(Clip {
                    x0: x,
                    y0: y,
                    x1: x + cell_w,
                    y1: y + cell_h,
                });
            }
        }
        bounds = bounds.intersect(clip);
        let global_rect = physical_rect(bounds, self.config.scale);
        let rect = local_physical_rect(bounds, surface, self.config.scale);
        if rect.is_empty() || rect.area() < self.config.min_blend_pixels {
            return Ok(false);
        }
        let mask = self.mask_mut();
        fill_mask_rect(mask, width, rect, 0);
        if !pocket_glyph_pages::blend_glyph_run(
            atlas,
            &op[3..],
            mask,
            width as usize,
            [surface.x0 * scale, surface.y0 * scale],
            Clip::new(
                global_rect.x as i32,
                global_rect.y as i32,
                (global_rect.x + global_rect.w) as i32,
                (global_rect.y + global_rect.h) as i32,
            ),
            scale as u32,
            a as u8,
        ) {
            return Ok(false);
        }
        if accelerated(ppa.blend_a8_rgb565(
            destination,
            width,
            height,
            mask,
            rect,
            [r as u8, g as u8, b as u8],
            255,
        ))? {
            stats.ppa_blends += 1;
            Ok(true)
        } else {
            Ok(false)
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn try_tex_quad_run<O: PpaOps>(
        &mut self,
        ui: &(impl RenderResources + ?Sized),
        words: &[u32],
        start: usize,
        destination: &mut [u16],
        width: u32,
        height: u32,
        surface: Clip,
        clip: Clip,
        ppa: &mut O,
        stats: &mut RenderStats,
    ) -> Result<Option<usize>, RenderError> {
        let op = &words[start..start + 9];
        let handle = op[1] as i32;
        let Some(view) = ui.texture(handle) else {
            return Ok(None);
        };

        if view.psm == spec::psm::PSM_5650 {
            let logical = logical_rect(op[2], op[3]).intersect(clip);
            let destination_rect = local_physical_rect(logical, surface, self.config.scale);
            if destination_rect.area() >= self.config.min_srm_pixels {
                let Some((source_rect, mirror_x, mirror_y)) =
                    texture_source_rect(&view, op, logical)
                else {
                    return Ok(None);
                };
                let one_to_one =
                    source_rect.w == destination_rect.w && source_rect.h == destination_rect.h;
                if (one_to_one || view.linear) && op[8] == 0xffff_ffff {
                    let transform = SrmTransform {
                        mirror_x,
                        mirror_y,
                        ..SrmTransform::default()
                    };
                    if accelerated(ppa.srm_psm5650_to_rgb565(
                        destination,
                        width,
                        height,
                        view.pixels,
                        view.w,
                        view.h,
                        source_rect,
                        destination_rect,
                        transform,
                    ))? {
                        stats.ppa_srm += 1;
                        return Ok(Some(start + 9));
                    }
                }
            }
            return Ok(None);
        }

        if !self.is_white_alpha_texture(handle, ui.texture_revision(handle), &view) {
            return Ok(None);
        }
        let modulate = op[8];
        let mut end = start;
        let mut bounds = Clip::empty();
        while end + 9 <= words.len()
            && words[end] == spec::draw_op::TEX_QUAD
            && words[end + 1] == handle as u32
            && words[end + 8] == modulate
        {
            let next = Operation {
                opcode: spec::draw_op::TEX_QUAD,
                words: &words[end..end + 9],
                clip,
            };
            let _validated = OperationResources::new(ui, &next, self.config.scale)?;
            bounds = bounds.union(logical_rect(words[end + 2], words[end + 3]).intersect(clip));
            end += 9;
        }
        let (r, g, b, a) = channels(modulate);
        if a == 0 {
            return Ok(Some(end));
        }
        let rect = local_physical_rect(bounds, surface, self.config.scale);
        if rect.is_empty() || rect.area() < self.config.min_blend_pixels {
            return Ok(None);
        }
        let scale = self.config.scale;
        let mask = self.mask_mut();
        fill_mask_rect(mask, width, rect, 0);
        let mut cursor = start;
        while cursor < end {
            alpha_quad_into_mask(
                &view,
                &words[cursor..cursor + 9],
                surface,
                clip,
                scale,
                mask,
                width,
                a as u8,
            );
            cursor += 9;
        }
        if accelerated(ppa.blend_a8_rgb565(
            destination,
            width,
            height,
            mask,
            rect,
            [r as u8, g as u8, b as u8],
            255,
        ))? {
            stats.ppa_blends += 1;
            Ok(Some(end))
        } else {
            Ok(None)
        }
    }

    fn mask_mut(&mut self) -> &mut [u8] {
        unsafe {
            core::slice::from_raw_parts_mut(
                (self.mask_storage.as_mut_ptr() as *mut u8).add(self.mask_offset),
                self.mask_len,
            )
        }
    }

    fn is_white_alpha_texture(
        &mut self,
        handle: i32,
        revision: Option<u64>,
        view: &TexView<'_>,
    ) -> bool {
        // T8 video planes can replace their palette and indices in place, so
        // their classification is intentionally never cached.
        if view.psm == spec::psm::PSM_T8 || revision.is_none() {
            return is_white_alpha_texture(view);
        }
        if let Some((_, _, result)) = self
            .alpha_texture_cache
            .iter()
            .find(|(cached, version, _)| *cached == handle && Some(*version) == revision)
        {
            return *result;
        }
        let result = is_white_alpha_texture(view);
        if self.alpha_texture_cache.len() == TEXTURE_CLASS_CACHE_LEN {
            self.alpha_texture_cache.remove(0);
        }
        self.alpha_texture_cache
            .retain(|(cached, _, _)| *cached != handle);
        self.alpha_texture_cache
            .push((handle, revision.unwrap(), result));
        result
    }
}

fn glyph_run_bounds(ui: &(impl RenderResources + ?Sized), words: &[u32], clip: Clip) -> Clip {
    if words.len() < 3 || words[2] >> 24 == 0 {
        return Clip::empty();
    }
    let slot = (words[1] & 0xff) as u8;
    let Some(atlas) = ui.font_atlas(slot) else {
        return Clip::empty();
    };
    let mut bounds = Clip::empty();
    for glyph in words[3..].as_chunks::<2>().0.iter() {
        let gid = (glyph[1] & 0xffff) as u16;
        if gid >= atlas.glyph_count {
            continue;
        }
        let (x, y) = xy(glyph[0]);
        bounds = bounds.union(Clip {
            x0: x,
            y0: y,
            x1: x + atlas.cell_w as i32,
            y1: y + atlas.cell_h as i32,
        });
    }
    bounds.intersect(clip)
}

#[inline]
fn xy(word: u32) -> (i32, i32) {
    (
        (word & 0xffff) as u16 as i16 as i32,
        (word >> 16) as u16 as i16 as i32,
    )
}

#[inline]
fn wh(word: u32) -> (i32, i32) {
    ((word & 0xffff) as i32, (word >> 16) as i32)
}

#[inline]
fn logical_rect(xy_word: u32, wh_word: u32) -> Clip {
    let (x, y) = xy(xy_word);
    let (w, h) = wh(wh_word);
    Clip {
        x0: x,
        y0: y,
        x1: x + w,
        y1: y + h,
    }
}

#[inline]
fn physical_rect(clip: Clip, scale: u32) -> Rect {
    if clip.is_empty() {
        return Rect::default();
    }
    Rect {
        x: clip.x0 as u32 * scale,
        y: clip.y0 as u32 * scale,
        w: (clip.x1 - clip.x0) as u32 * scale,
        h: (clip.y1 - clip.y0) as u32 * scale,
    }
}

#[inline]
fn local_physical_rect(clip: Clip, surface: Clip, scale: u32) -> Rect {
    let clip = clip.intersect(surface);
    if clip.is_empty() {
        return Rect::default();
    }
    Rect {
        x: (clip.x0 - surface.x0) as u32 * scale,
        y: (clip.y0 - surface.y0) as u32 * scale,
        w: (clip.x1 - clip.x0) as u32 * scale,
        h: (clip.y1 - clip.y0) as u32 * scale,
    }
}

#[inline]
fn channels(color: u32) -> (u32, u32, u32, u32) {
    (
        color & 0xff,
        (color >> 8) & 0xff,
        (color >> 16) & 0xff,
        color >> 24,
    )
}

#[inline]
fn fill_mask_rect(mask: &mut [u8], stride: u32, rect: Rect, value: u8) {
    assert!(pocket_glyph_pages::fill_mask_rect(
        mask,
        stride as usize,
        rect.x,
        rect.y,
        rect.w,
        rect.h,
        value
    ));
}

fn texture_source_rect(
    view: &TexView<'_>,
    op: &[u32],
    clipped_destination: Clip,
) -> Option<(Rect, bool, bool)> {
    let destination = logical_rect(op[2], op[3]);
    if destination.is_empty() || clipped_destination.is_empty() {
        return None;
    }
    let u0 = f32::from_bits(op[4]);
    let v0 = f32::from_bits(op[5]);
    let u1 = f32::from_bits(op[6]);
    let v1 = f32::from_bits(op[7]);
    if !u0.is_finite() || !v0.is_finite() || !u1.is_finite() || !v1.is_finite() {
        return None;
    }
    let destination_w = (destination.x1 - destination.x0) as f32;
    let destination_h = (destination.y1 - destination.y0) as f32;
    let map_u = |x: i32| u0 + (u1 - u0) * (x - destination.x0) as f32 / destination_w;
    let map_v = |y: i32| v0 + (v1 - v0) * (y - destination.y0) as f32 / destination_h;
    let source_u0 = exact_texel_edge(map_u(clipped_destination.x0), view.w)?;
    let source_v0 = exact_texel_edge(map_v(clipped_destination.y0), view.h)?;
    let source_u1 = exact_texel_edge(map_u(clipped_destination.x1), view.w)?;
    let source_v1 = exact_texel_edge(map_v(clipped_destination.y1), view.h)?;
    let x0 = source_u0.min(source_u1);
    let y0 = source_v0.min(source_v1);
    let x1 = source_u0.max(source_u1);
    let y1 = source_v0.max(source_v1);
    (x1 > x0 && y1 > y0).then_some((
        Rect {
            x: x0,
            y: y0,
            w: x1 - x0,
            h: y1 - y0,
        },
        source_u0 > source_u1,
        source_v0 > source_v1,
    ))
}

/// PPA source block offsets are integral texels. Refuse fractional UV edges
/// instead of expanding them and changing the sampling transform. The small
/// tolerance only absorbs normal f32 interpolation error for exact atlas
/// boundaries.
#[inline]
fn exact_texel_edge(uv: f32, extent: u32) -> Option<u32> {
    let value = uv * extent as f32;
    if !value.is_finite() || value < 0.0 || value > extent as f32 {
        return None;
    }
    let rounded = (value + 0.5) as u32;
    let rounded_value = rounded as f32;
    let difference = if value >= rounded_value {
        value - rounded_value
    } else {
        rounded_value - value
    };
    (rounded <= extent && difference <= 0.0001).then_some(rounded)
}

fn is_white_alpha_texture(view: &TexView<'_>) -> bool {
    let count = view.w as usize * view.h as usize;
    match view.psm {
        spec::psm::PSM_8888 => view.pixels[..count * 4].as_chunks::<4>().0.iter().all(|p| {
            let white = p[0] == 255 && p[1] == 255 && p[2] == 255;
            white || (!view.linear && p[3] == 0)
        }),
        spec::psm::PSM_4444 => view.pixels[..count * 2].as_chunks::<2>().0.iter().all(|p| {
            let pixel = u16::from_le_bytes([p[0], p[1]]);
            pixel & 0x0fff == 0x0fff || (!view.linear && pixel >> 12 == 0)
        }),
        spec::psm::PSM_T8 => {
            let Some(palette) = view.palette else {
                return false;
            };
            view.pixels[..count].iter().all(|&index| {
                let p = index as usize * 4;
                let white = palette[p] == 255 && palette[p + 1] == 255 && palette[p + 2] == 255;
                white || (!view.linear && palette[p + 3] == 0)
            })
        }
        _ => false,
    }
}

#[inline]
fn texel_alpha(view: &TexView<'_>, x: i32, y: i32) -> u32 {
    let x = x.clamp(0, view.w as i32 - 1) as usize;
    let y = y.clamp(0, view.h as i32 - 1) as usize;
    let index = y * view.w as usize + x;
    match view.psm {
        spec::psm::PSM_8888 => view.pixels[index * 4 + 3] as u32,
        spec::psm::PSM_4444 => {
            let o = index * 2;
            ((u16::from_le_bytes([view.pixels[o], view.pixels[o + 1]]) >> 12) as u32) * 17
        }
        spec::psm::PSM_T8 => {
            let palette = view.palette.unwrap();
            palette[view.pixels[index] as usize * 4 + 3] as u32
        }
        _ => 0,
    }
}

fn sample_alpha(view: &TexView<'_>, u: f32, v: f32) -> u8 {
    if !view.linear {
        return texel_alpha(view, (u * view.w as f32) as i32, (v * view.h as f32) as i32) as u8;
    }
    let Some(sample) = linear_sample_coordinates(view.w, view.h, u, v) else {
        return 0;
    };
    let lerp = |a: u32, b: u32, f: u32| (a * (256 - f) + b * f) >> 8;
    let top = lerp(
        texel_alpha(view, sample.x0 as i32, sample.y0 as i32),
        texel_alpha(view, sample.x1 as i32, sample.y0 as i32),
        sample.fx,
    );
    let bottom = lerp(
        texel_alpha(view, sample.x0 as i32, sample.y1 as i32),
        texel_alpha(view, sample.x1 as i32, sample.y1 as i32),
        sample.fx,
    );
    lerp(top, bottom, sample.fy) as u8
}

#[allow(clippy::too_many_arguments)]
fn alpha_quad_into_mask(
    view: &TexView<'_>,
    op: &[u32],
    surface: Clip,
    clip: Clip,
    scale: u32,
    mask: &mut [u8],
    stride: u32,
    global_alpha: u8,
) {
    let logical = logical_rect(op[2], op[3]).intersect(clip);
    if logical.is_empty() {
        return;
    }
    let (x, y) = xy(op[2]);
    let (w, h) = wh(op[3]);
    let scale_i = scale as i32;
    let physical = physical_rect(logical, scale);
    let u0 = f32::from_bits(op[4]);
    let v0 = f32::from_bits(op[5]);
    let u1 = f32::from_bits(op[6]);
    let v1 = f32::from_bits(op[7]);
    for py in physical.y..physical.y + physical.h {
        let v = v0 + (v1 - v0) * ((py as i32 - y * scale_i) as f32 + 0.5) / (h * scale_i) as f32;
        for px in physical.x..physical.x + physical.w {
            let u =
                u0 + (u1 - u0) * ((px as i32 - x * scale_i) as f32 + 0.5) / (w * scale_i) as f32;
            let alpha = (sample_alpha(view, u, v) as u32 * global_alpha as u32 + 127) / 255;
            let local_x = px as i32 - surface.x0 * scale_i;
            let local_y = py as i32 - surface.y0 * scale_i;
            composite_mask(
                &mut mask[local_y as usize * stride as usize + local_x as usize],
                alpha as u8,
            );
        }
    }
}

/// A registered PPA renderer owns one hardware device and its bounded scratch.
/// Each render call completes its CPU-visible writes, so submissions carry no
/// borrowed frame resources and multiple displays may share the instance.
pub struct PpaRenderer<O> {
    painter: Painter,
    device: O,
    last_stats: RenderStats,
}
impl<O: PpaOps> PpaRenderer<O> {
    pub fn new(config: RendererConfig, mask_budget: usize, device: O) -> Result<Self, RenderError> {
        Ok(Self {
            painter: Painter::new(config, mask_budget)?,
            device,
            last_stats: RenderStats::default(),
        })
    }
    pub fn stats(&self) -> RenderStats {
        self.last_stats
    }
    pub fn device(&self) -> &O {
        &self.device
    }
    pub fn device_mut(&mut self) -> &mut O {
        &mut self.device
    }
    /// Active A8 payload size, excluding alignment and retained capacity.
    pub fn scratch_bytes(&self) -> usize {
        self.painter.scratch_bytes()
    }
    pub fn allocated_scratch_bytes(&self) -> usize {
        self.painter.allocated_scratch_bytes()
    }
}
impl<O: PpaOps> pocket_drivers::Renderer for PpaRenderer<O> {
    type Submission = ();
    fn descriptor(&self) -> pocket_drivers::RendererDescriptor {
        pocket_drivers::RendererDescriptor::new(
            &[PixelFormat::Rgb565],
            pocket_drivers::TargetOwnership::CpuVisible,
            pocket_drivers::Synchronization::Immediate,
            spec::DRAW_LIST_VERSION,
            false,
        )
        .unwrap()
    }
    fn render(&mut self, frame: &mut pocket_drivers::FrameInput<'_>) -> Result<(), RenderError> {
        let pocket_drivers::Target::CpuVisible(surface) = &mut frame.target else {
            return Err(RenderError::Unsupported);
        };
        self.last_stats = self.painter.render(
            frame.resources,
            &frame.list.words,
            surface,
            &mut self.device,
        )?;
        Ok(())
    }
    fn wait(&mut self, _: &()) -> Result<(), RenderError> {
        Ok(())
    }
    fn retire(&mut self, _: ()) {}
}

#[cfg(test)]
mod cache_tests {
    use super::*;
    use pocketjs_core::Ui;
    #[test]
    fn core_resource_revision_invalidates_texture_classifications() {
        let mut ui = Ui::new();
        let mut renderer = Painter::new(RendererConfig::default(), 1024).unwrap();
        renderer.sync_resources(&ui);
        renderer.alpha_texture_cache.push((7, 0, true));

        assert_eq!(
            ui.upload_texture(&[0xff, 0xff], 1, 1, spec::psm::PSM_5650),
            0
        );
        renderer.sync_resources(&ui);
        assert!(renderer.alpha_texture_cache.is_empty());
        assert_eq!(renderer.raster_revision, ui.raster_revision());
    }
}
