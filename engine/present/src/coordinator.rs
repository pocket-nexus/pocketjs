//! Register drivers and complete a frame's rendering and display transfers.
//!
//! Drivers can identify retained output buffers for incremental damage. GRAM
//! displays can overlap two CPU staging buffers when they declare that acquire
//! does not reuse storage read by a pending transfer. A Deferred renderer's
//! frame stays in flight until the next present, so its device work overlaps
//! the caller's next guest turn.

use crate::damage::{DamagePolicy, DamageTarget, DamageTracker};
use alloc::{boxed::Box, collections::VecDeque, vec::Vec};
use core::{any::Any, cell::RefCell};

use pocket_drivers::{
    BufferIdentity, DamageRect, DisplayDescriptor, DisplayError, DisplayOutput, DisplayRole,
    DrawList, FontView, FrameInput, Rect, RenderError, RenderResources, Renderer,
    RendererDescriptor, Synchronization, Target, TargetOwnership, TexView,
};
use pocket_raster::RasterRenderer;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RendererId(u32);

impl RendererId {
    pub const SOFTWARE: Self = Self(0);
    pub const fn from_raw(value: u32) -> Self {
        Self(value)
    }
    pub const fn as_raw(self) -> u32 {
        self.0
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DisplayId(usize);

impl DisplayId {
    pub const fn from_raw(value: usize) -> Self {
        Self(value)
    }
    pub const fn as_raw(self) -> usize {
        self.0
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum PresentError {
    InvalidRenderer,
    InvalidRendererDescriptor,
    InvalidDisplayDescriptor,
    IncompatibleRenderer,
    BudgetExceeded,
    InvalidFrame,
    MissingAuxiliary,
    InvalidTarget(DisplayId),
    Acquire(DisplayId, DisplayError),
    Render(DisplayId, RenderError),
    RenderWait(DisplayId, RenderError),
    Flush(DisplayId, DisplayError),
    DisplayWait(DisplayId, DisplayError),
}

type ErasedValue = Box<dyn Any>;

trait ErasedRenderer {
    fn render(
        &mut self,
        frame: &mut FrameInput<'_>,
        zero_copy: bool,
    ) -> Result<ErasedValue, RenderError>;
    fn wait(&mut self, submission: &dyn Any) -> Result<(), RenderError>;
    fn retire(&mut self, submission: ErasedValue);
}

struct RendererAdapter<R>(R);

impl<R: Renderer> ErasedRenderer for RendererAdapter<R>
where
    R::Submission: 'static,
{
    fn render(
        &mut self,
        frame: &mut FrameInput<'_>,
        zero_copy: bool,
    ) -> Result<ErasedValue, RenderError> {
        let submission = if zero_copy {
            // SAFETY: this adapter is private to Coordinator. For Immediate
            // renderers its frame guard waits before the caller's
            // DrawLists/resources or the per-display resource wrappers/damage
            // arrays can be changed or released. Deferred renderers take this
            // path only after `enable_deferred_zero_copy`, whose caller keeps
            // the storage `borrowed_textures` reports until retirement.
            unsafe { self.0.render_zero_copy(frame) }
        } else {
            self.0.render(frame)
        }?;
        Ok(Box::new(submission))
    }
    fn wait(&mut self, submission: &dyn Any) -> Result<(), RenderError> {
        self.0.wait(
            submission
                .downcast_ref()
                .expect("matching renderer submission"),
        )
    }
    fn retire(&mut self, submission: ErasedValue) {
        self.0
            .retire(*submission.downcast().expect("matching renderer submission"));
    }
}

trait ErasedDisplay {
    fn descriptor(&self) -> DisplayDescriptor;
    fn frame_identity(&mut self) -> Result<Option<BufferIdentity>, DisplayError>;
    fn acquire(&mut self, region: Rect) -> Result<Target<'_>, DisplayError>;
    fn flush(&mut self, regions: &[Rect]) -> Result<ErasedValue, DisplayError>;
    fn wait(&mut self, token: ErasedValue) -> Result<(), DisplayError>;
}

struct DisplayAdapter<D>(D);

impl<D: DisplayOutput> ErasedDisplay for DisplayAdapter<D>
where
    D::Token: 'static,
{
    fn descriptor(&self) -> DisplayDescriptor {
        self.0.descriptor()
    }
    fn frame_identity(&mut self) -> Result<Option<BufferIdentity>, DisplayError> {
        self.0.frame_identity()
    }
    fn acquire(&mut self, region: Rect) -> Result<Target<'_>, DisplayError> {
        self.0.acquire(region)
    }
    fn flush(&mut self, regions: &[Rect]) -> Result<ErasedValue, DisplayError> {
        self.0
            .flush(regions)
            .map(|token| Box::new(token) as ErasedValue)
    }
    fn wait(&mut self, token: ErasedValue) -> Result<(), DisplayError> {
        self.0
            .wait(*token.downcast().expect("matching display token"))
    }
}

struct RegisteredRenderer {
    descriptor: RendererDescriptor,
    driver: Option<Box<dyn ErasedRenderer>>,
}

struct Pending {
    submission: ErasedValue,
    render_waited: bool,
    display_in_call: bool,
    damage: Box<[Rect]>,
    token: Option<ErasedValue>,
    /// Completion waits for the next present: the renderer is Deferred.
    defer: bool,
    /// Rendered through `render_zero_copy`; texture storage stays borrowed.
    zero_copy: bool,
}

/// A Deferred renderer's submission for one display, completed by the next
/// present. `pending.token` is set when a queued flush already ran.
struct Deferred {
    frame: u64,
    pending: Pending,
}

struct RegisteredDisplay {
    descriptor: DisplayDescriptor,
    driver: Option<Box<dyn ErasedDisplay>>,
    renderer: RendererId,
    strip_height: u32,
    reserved_bytes: usize,
    next_y: u32,
    damage: Vec<Rect>,
    pending: Option<Pending>,
    deferred: Option<Deferred>,
    acquired_damage: Option<Box<[Rect]>>,
    transfers: VecDeque<Pending>,
    histories: Vec<(BufferIdentity, DamageTracker)>,
    history_slot: Option<usize>,
    history_valid: bool,
}

impl RegisteredDisplay {
    fn invalidate(&mut self) {
        self.history_valid = false;
        for (_, tracker) in &mut self.histories {
            tracker.invalidate();
        }
    }
}

/// A frame boundary over drivers which may submit asynchronous work. It owns
/// the registered drivers and erases their token types.
///
/// Immediate renderers complete each frame inside `present`. A display bound
/// to a Deferred renderer keeps its submission in flight after `present`
/// returns; the next `present`, `complete`, display refresh or destruction
/// completes it before the display is acquired again.
///
/// The budget accounts for host CPU framebuffer storage across all displays;
/// device-owned targets consume no host framebuffer reservation. Double-buffer
/// descriptors reserve two buffers. Pipelined strips retain both transfers
/// until their terminal waits before reusing storage. Drivers own the actual allocation and must honor the
/// requested region/stride; the coordinator allocates no pixel staging buffer.
pub struct Coordinator {
    scale: u32,
    frame_buffer_budget: usize,
    renderers: Vec<RegisteredRenderer>,
    displays: Vec<RegisteredDisplay>,
    /// Sequence number of the latest `present` call.
    frame: u64,
    /// Texture handles read by in-flight zero-copy Deferred submissions.
    borrowed: Vec<i32>,
    /// The caller keeps borrowed texture storage until retirement
    /// (`enable_deferred_zero_copy`).
    deferred_zero_copy: bool,
}

impl Coordinator {
    pub fn new(scale: u32, frame_buffer_budget: usize) -> Result<Self, PresentError> {
        let software =
            RasterRenderer::new(scale).map_err(|_| PresentError::InvalidRendererDescriptor)?;
        let mut result = Self {
            scale,
            frame_buffer_budget,
            renderers: Vec::new(),
            displays: Vec::new(),
            frame: 0,
            borrowed: Vec::new(),
            deferred_zero_copy: false,
        };
        result.add_renderer(software)?;
        Ok(result)
    }

    /// Change the logical-to-physical scale after package admission. This
    /// replaces only the built-in software renderer; custom renderers retain
    /// their own configuration. Call before the next presentation begins.
    pub fn set_scale(&mut self, scale: u32) -> Result<(), PresentError> {
        self.complete()?;
        if self
            .displays
            .iter()
            .any(|display| display.pending.is_some())
        {
            return Err(PresentError::InvalidFrame);
        }
        let software =
            RasterRenderer::new(scale).map_err(|_| PresentError::InvalidRendererDescriptor)?;
        for display in &self.displays {
            validate_display(&display.descriptor, scale)?;
        }
        self.renderers[RendererId::SOFTWARE.0 as usize] = RegisteredRenderer {
            descriptor: software.descriptor(),
            driver: Some(Box::new(RendererAdapter(software))),
        };
        self.scale = scale;
        self.invalidate();
        Ok(())
    }

    /// Re-read program-owned output descriptors at a terminal frame boundary.
    /// In-flight Deferred frames complete first; a failed completion returns
    /// its error before registration changes. Validation and budget planning
    /// finish before registration changes. A primary display must have the
    /// requested physical viewport.
    pub fn refresh_displays(&mut self, scale: u32, primary: [u32; 2]) -> Result<(), PresentError> {
        self.complete()?;
        let software =
            RasterRenderer::new(scale).map_err(|_| PresentError::InvalidRendererDescriptor)?;
        if self
            .displays
            .iter()
            .any(|d| d.pending.is_some() || !d.transfers.is_empty())
        {
            return Err(PresentError::InvalidFrame);
        }
        let mut descriptors = Vec::with_capacity(self.displays.len());
        for (i, display) in self.displays.iter().enumerate() {
            let descriptor = display
                .driver
                .as_ref()
                .ok_or(PresentError::InvalidTarget(DisplayId(i)))?
                .descriptor();
            validate_display(&descriptor, scale)?;
            let renderer = &self.renderers[display.renderer.0 as usize];
            if renderer.driver.is_none()
                || descriptor.target_ownership != renderer.descriptor.target_ownership()
                || !renderer.descriptor.formats().contains(&descriptor.format)
            {
                return Err(PresentError::IncompatibleRenderer);
            }
            if descriptor.role != display.descriptor.role
                || descriptor.role == DisplayRole::Primary
                    && [descriptor.width, descriptor.height] != primary
            {
                return Err(PresentError::InvalidDisplayDescriptor);
            }
            descriptors.push(descriptor);
        }
        let plans = budget_plans(&descriptors, self.frame_buffer_budget)?;
        self.renderers[0] = RegisteredRenderer {
            descriptor: software.descriptor(),
            driver: Some(Box::new(RendererAdapter(software))),
        };
        for ((display, descriptor), plan) in self.displays.iter_mut().zip(descriptors).zip(plans) {
            display.descriptor = descriptor;
            display.strip_height = plan.rows;
            display.reserved_bytes = plan.bytes;
            display.acquired_damage = None;
        }
        self.scale = scale;
        self.invalidate();
        Ok(())
    }

    pub fn scale(&self) -> u32 {
        self.scale
    }

    pub fn add_renderer<R: Renderer + 'static>(
        &mut self,
        renderer: R,
    ) -> Result<RendererId, PresentError>
    where
        R::Submission: 'static,
    {
        let descriptor = renderer.descriptor();
        if descriptor.draw_list_version() != pocket_spec::DRAW_LIST_VERSION
            || descriptor.formats().is_empty()
            || (descriptor.target_ownership() == TargetOwnership::CpuVisible
                && descriptor.synchronization() != Synchronization::Immediate)
        {
            return Err(PresentError::InvalidRendererDescriptor);
        }
        let id = u32::try_from(self.renderers.len()).map_err(|_| PresentError::InvalidRenderer)?;
        if id == u32::MAX {
            return Err(PresentError::InvalidRenderer);
        }
        self.renderers.push(RegisteredRenderer {
            descriptor,
            driver: Some(Box::new(RendererAdapter(renderer))),
        });
        Ok(RendererId(id))
    }

    pub fn add_display<D: DisplayOutput + 'static>(
        &mut self,
        display: D,
        renderer: RendererId,
    ) -> Result<DisplayId, PresentError>
    where
        D::Token: 'static,
    {
        let registered = self
            .renderers
            .get(renderer.0 as usize)
            .ok_or(PresentError::InvalidRenderer)?;
        if registered.driver.is_none() {
            return Err(PresentError::InvalidRenderer);
        }
        let renderer_descriptor = registered.descriptor;
        let descriptor = display.descriptor();
        validate_display(&descriptor, self.scale)?;
        if descriptor.target_ownership != renderer_descriptor.target_ownership()
            || !renderer_descriptor.formats().contains(&descriptor.format)
        {
            return Err(PresentError::IncompatibleRenderer);
        }
        if renderer == RendererId::SOFTWARE
            && descriptor
                .width
                .checked_mul(descriptor.height)
                .is_none_or(|pixels| pixels > i32::MAX as u32)
        {
            return Err(PresentError::InvalidDisplayDescriptor);
        }
        let descriptors = self
            .displays
            .iter()
            .map(|display| display.descriptor)
            .chain(core::iter::once(descriptor))
            .collect::<Vec<_>>();
        let plans = budget_plans(&descriptors, self.frame_buffer_budget)?;
        let id = DisplayId(self.displays.len());
        self.displays.push(RegisteredDisplay {
            descriptor,
            driver: Some(Box::new(DisplayAdapter(display))),
            renderer,
            strip_height: 0,
            reserved_bytes: 0,
            next_y: 0,
            damage: Vec::new(),
            pending: None,
            deferred: None,
            acquired_damage: None,
            transfers: VecDeque::new(),
            histories: Vec::new(),
            history_slot: None,
            history_valid: false,
        });
        for (display, plan) in self.displays.iter_mut().zip(plans) {
            display.strip_height = plan.rows;
            display.reserved_bytes = plan.bytes;
        }
        Ok(id)
    }

    pub fn display_descriptors(&self) -> impl ExactSizeIterator<Item = &DisplayDescriptor> {
        self.displays.iter().map(|display| &display.descriptor)
    }

    pub fn display_descriptor(&self, display: DisplayId) -> Option<&DisplayDescriptor> {
        self.displays
            .get(display.0)
            .map(|display| &display.descriptor)
    }

    pub fn history_valid(&self, display: DisplayId) -> Option<bool> {
        self.displays
            .get(display.0)
            .map(|display| display.history_valid)
    }

    pub fn strip_height(&self, display: DisplayId) -> Option<u32> {
        self.displays
            .get(display.0)
            .map(|display| display.strip_height)
    }

    pub fn reserved_frame_buffer_bytes(&self) -> usize {
        self.displays
            .iter()
            .map(|display| display.reserved_bytes)
            .sum()
    }

    pub fn invalidate(&mut self) {
        for display in &mut self.displays {
            display.invalidate();
        }
    }

    /// Let zero-copy Deferred renderers read texture storage after `present`
    /// returns. Without this call they render through the copying `render`;
    /// Immediate zero-copy renderers are unaffected.
    ///
    /// # Safety
    /// After every present the caller keeps the pixel and palette storage of
    /// each handle in `borrowed_textures()` alive and unchanged until
    /// `retired_frame()` reaches the reported frame, including when the
    /// resources object passed to present is mutated or dropped.
    pub unsafe fn enable_deferred_zero_copy(&mut self) {
        self.deferred_zero_copy = true;
    }

    /// Sequence number of the latest `present` call; zero before the first.
    pub fn frame(&self) -> u64 {
        self.frame
    }

    /// Every submission of this frame and all earlier frames has retired.
    /// Equals `frame()` when no Deferred frame is in flight.
    pub fn retired_frame(&self) -> u64 {
        self.displays
            .iter()
            .filter_map(|display| display.deferred.as_ref())
            .map(|deferred| deferred.frame - 1)
            .min()
            .unwrap_or(self.frame)
    }

    /// Texture handles whose pixel or palette storage an in-flight zero-copy
    /// Deferred submission reads, and the frame that submitted them. The
    /// caller keeps that storage alive and unchanged until `retired_frame()`
    /// reaches the frame. Handles are sorted and unique.
    pub fn borrowed_textures(&self) -> Option<(u64, &[i32])> {
        let frame = self
            .displays
            .iter()
            .filter_map(|display| display.deferred.as_ref())
            .filter(|deferred| deferred.pending.zero_copy)
            .map(|deferred| deferred.frame)
            .max()?;
        Some((frame, &self.borrowed))
    }

    /// Complete every in-flight Deferred frame: renderer wait, then display
    /// flush, or display wait alone when a queued flush already ran, then
    /// retirement. Displays complete in reverse order. All work is terminal on
    /// return. A failure invalidates only the failed display's damage history;
    /// the first error is returned. With nothing in flight this returns Ok.
    pub fn complete(&mut self) -> Result<(), PresentError> {
        let mut any = false;
        for display in &mut self.displays {
            if let Some(deferred) = display.deferred.take() {
                debug_assert!(display.pending.is_none());
                display.pending = Some(deferred.pending);
                any = true;
            }
        }
        if !any {
            return Ok(());
        }
        self.borrowed.clear();
        let mut frame = FrameGuard {
            coordinator: self,
            rendering: None,
            committed: false,
        };
        let failure = frame.finish_round(false);
        let failure = frame.drain_transfers().or(failure);
        // Failures invalidated their own display. Only an unwinding driver
        // call leaves this guard uncommitted and invalidates every display.
        frame.committed = true;
        failure.map_or(Ok(()), Err)
    }

    /// Complete in-flight Deferred frames, then present both roles. Immediate
    /// renderers finish every render/display wait and retirement before this
    /// returns; Deferred renderers return after submission, with a queued
    /// flush when the display declares `queued_flush`. Any failure, including
    /// one that follows a Deferred submission, leaves no work in flight.
    /// A failed completion of the previous frame returns its error before the
    /// new frame is acquired. Several displays may hold live
    /// submissions from the same renderer; completion drains in reverse display
    /// order. A strip is reacquired only after its previous transfer terminates.
    /// If render unwinds before returning a submission, its renderer is
    /// destroyed to stop hardware and every display using it is disabled.
    /// Further presentation rejects the disabled registration.
    ///
    /// CPU primary geometry must match the resources' viewport at this scale.
    /// Device-owned renderers map that logical viewport to their physical target.
    /// Auxiliary viewport dimensions come from its display dimensions / scale;
    /// resource lookup and revisions still refer to the same application.
    pub fn present(
        &mut self,
        primary: &DrawList,
        auxiliary: Option<&DrawList>,
        resources: &dyn RenderResources,
    ) -> Result<(), PresentError> {
        self.complete()?;
        let result = self.present_inner(primary, auxiliary, resources, None);
        if result.is_err() {
            self.invalidate();
        }
        result
    }

    /// Draw host overlays after each device-owned UI submission and before its
    /// terminal render wait or queued flush. The callback must use the same
    /// device/context and finish submitting commands before returning. All
    /// outputs must be device-owned. Each callback runs once per display;
    /// damage is full because host overlay changes are not represented by the
    /// UI DrawList. In-flight Deferred frames complete first, as in `present`.
    pub fn present_with_overlay(
        &mut self,
        primary: &DrawList,
        auxiliary: Option<&DrawList>,
        resources: &dyn RenderResources,
        mut overlay: impl FnMut(DisplayId),
    ) -> Result<(), PresentError> {
        if self
            .displays
            .iter()
            .any(|d| d.descriptor.target_ownership != TargetOwnership::DeviceOwned)
        {
            return Err(PresentError::IncompatibleRenderer);
        }
        self.complete()?;
        let result = self.present_inner(primary, auxiliary, resources, Some(&mut overlay));
        // External commands are absent from the tracked DrawList, so a later
        // ordinary presentation must not reuse the overlay's retained pixels.
        self.invalidate();
        result
    }

    fn present_inner(
        &mut self,
        primary: &DrawList,
        auxiliary: Option<&DrawList>,
        resources: &dyn RenderResources,
        mut overlay: Option<&mut dyn FnMut(DisplayId)>,
    ) -> Result<(), PresentError> {
        for (index, display) in self.displays.iter().enumerate() {
            if self.renderers[display.renderer.0 as usize].driver.is_none() {
                return Err(PresentError::InvalidRenderer);
            }
            if display.driver.is_none() {
                return Err(PresentError::InvalidTarget(DisplayId(index)));
            }
        }
        let viewport = resources.viewport();
        if !viewport.0.is_finite()
            || !viewport.1.is_finite()
            || viewport.0 < 1.0
            || viewport.1 < 1.0
            || viewport.0 >= i32::MAX as f32
            || viewport.1 >= i32::MAX as f32
        {
            return Err(PresentError::InvalidFrame);
        }
        let primary_width = (viewport.0 as u32)
            .checked_mul(self.scale)
            .ok_or(PresentError::InvalidFrame)?;
        let primary_height = (viewport.1 as u32)
            .checked_mul(self.scale)
            .ok_or(PresentError::InvalidFrame)?;
        self.frame = self
            .frame
            .checked_add(1)
            .ok_or(PresentError::InvalidFrame)?;
        self.borrowed.clear();
        // Texture lookups by zero-copy Deferred renderers. Declared before the
        // views so it outlives every resource wrapper.
        let borrowed = RefCell::new(Vec::new());
        let mut views = Vec::with_capacity(self.displays.len());
        for (index, display) in self.displays.iter_mut().enumerate() {
            let descriptor = display.descriptor;
            let renderer = &self.renderers[display.renderer.0 as usize].descriptor;
            let log = (renderer.zero_copy()
                && renderer.synchronization() == Synchronization::Deferred)
                .then_some(&borrowed)
                .filter(|_| self.deferred_zero_copy);
            let list = match descriptor.role {
                DisplayRole::Primary => {
                    if descriptor.target_ownership == TargetOwnership::CpuVisible
                        && (descriptor.width != primary_width
                            || descriptor.height != primary_height)
                    {
                        return Err(PresentError::InvalidFrame);
                    }
                    primary
                }
                DisplayRole::Auxiliary => auxiliary.ok_or(PresentError::MissingAuxiliary)?,
                _ => return Err(PresentError::InvalidDisplayDescriptor),
            };
            let native_primary = descriptor.role == DisplayRole::Primary
                && descriptor.target_ownership == TargetOwnership::DeviceOwned;
            let viewport = if native_primary {
                viewport
            } else {
                (
                    (descriptor.width / self.scale) as f32,
                    (descriptor.height / self.scale) as f32,
                )
            };
            // DrawList coordinates are integral, while native window scaling
            // may leave a fractional logical edge. Include its boundary pixel.
            let clip_width = viewport.0 as i32 + i32::from(viewport.0 > viewport.0 as i32 as f32);
            let clip_height = viewport.1 as i32 + i32::from(viewport.1 > viewport.1 as i32 as f32);
            pocket_draw_ops::validate(&list.words, DamageRect::new(0, 0, clip_width, clip_height))
                .map_err(|_| PresentError::InvalidFrame)?;
            views.push(FrameResources {
                source: resources,
                viewport,
                log,
            });
            display.next_y = 0;
            let identity = display
                .driver
                .as_mut()
                .expect("validated display")
                .frame_identity()
                .map_err(|error| PresentError::Acquire(DisplayId(index), error))?;
            // Arbitrary GPU scaling has no integer mapping for damage regions.
            // Submit the whole target until a renderer-specific mapping exists.
            let identity = identity.filter(|_| {
                !native_primary
                    || viewport.0 == viewport.0 as u32 as f32
                        && viewport.1 == viewport.1 as u32 as f32
                        && descriptor.width == primary_width
                        && descriptor.height == primary_height
            });
            display.history_slot = identity.map(|identity| {
                let slot = display
                    .histories
                    .iter()
                    .position(|(known, _)| known.buffer == identity.buffer);
                if let Some(slot) = slot {
                    if display.histories[slot].0 != identity {
                        display.histories[slot].1.invalidate();
                        display.histories[slot].0 = identity;
                    }
                    slot
                } else {
                    let capacity = if descriptor.double_buffered { 2 } else { 1 };
                    if display.histories.len() == capacity {
                        display.histories.remove(0);
                    }
                    display.histories.push((identity, DamageTracker::new()));
                    display.histories.len() - 1
                }
            });
            display.damage = if let Some(slot) = display
                .history_slot
                .filter(|_| descriptor.partial_refresh && overlay.is_none())
            {
                let target = DamageTarget::new(
                    descriptor.width,
                    descriptor.height,
                    self.scale,
                    descriptor.format as u64,
                );
                let plan = display.histories[slot]
                    .1
                    .prepare(views.last().unwrap(), &list.words, target)
                    .and_then(|plan| plan.with_policy(DamagePolicy::default()))
                    .map_err(|_| PresentError::InvalidFrame)?;
                physical_damage(plan.regions(), &descriptor, self.scale)?
            } else {
                alloc::vec![Rect::new(0, 0, descriptor.width, descriptor.height)]
            };
        }
        // Drop this guard before `views` on either return or unwinding. In
        // particular, zero-copy renderers may retain the resource wrapper.
        let mut frame = FrameGuard {
            coordinator: self,
            rendering: None,
            committed: false,
        };
        loop {
            let mut submitted = false;
            let mut failure = None;
            for (index, view) in views.iter().enumerate() {
                if frame.coordinator.displays[index].next_y
                    == frame.coordinator.displays[index].descriptor.height
                {
                    continue;
                }
                let list = match frame.coordinator.displays[index].descriptor.role {
                    DisplayRole::Primary => primary,
                    _ => auxiliary.expect("auxiliary validated before submission"),
                };
                match frame.submit(index, list, view) {
                    Ok(()) => {
                        if frame.coordinator.displays[index].pending.is_some() {
                            if let Some(callback) = overlay.as_mut() {
                                frame.rendering = Some(frame.coordinator.displays[index].renderer);
                                callback(DisplayId(index));
                                frame.rendering = None;
                            }
                        }
                        submitted = true;
                    }
                    Err(error) => {
                        failure = Some(error);
                        break;
                    }
                }
            }
            let completion = frame.finish_round(false);
            if let Some(error) = failure.or(completion) {
                return Err(error);
            }
            if !submitted {
                break;
            }
        }
        if let Some(error) = frame.drain_transfers() {
            return Err(error);
        }
        for (display, view) in frame.coordinator.displays.iter_mut().zip(&views) {
            let list = match display.descriptor.role {
                DisplayRole::Primary => primary,
                _ => auxiliary.unwrap(),
            };
            if let Some(slot) = display.history_slot {
                let target = DamageTarget::new(
                    display.descriptor.width,
                    display.descriptor.height,
                    frame.coordinator.scale,
                    display.descriptor.format as u64,
                );
                display.histories[slot].1.commit(view, &list.words, target);
            }
            display.history_valid = true;
        }
        frame.committed = true;
        drop(frame);
        drop(views);
        let mut borrowed = borrowed.into_inner();
        borrowed.sort_unstable();
        borrowed.dedup();
        self.borrowed = borrowed;
        Ok(())
    }
}

impl Drop for Coordinator {
    /// Destruction completes in-flight Deferred frames before driver Drop.
    fn drop(&mut self) {
        let _ = self.complete();
    }
}

struct FrameResources<'a> {
    source: &'a dyn RenderResources,
    viewport: (f32, f32),
    log: Option<&'a RefCell<Vec<i32>>>,
}

impl RenderResources for FrameResources<'_> {
    fn viewport(&self) -> (f32, f32) {
        self.viewport
    }
    fn raster_revision(&self) -> u64 {
        self.source.raster_revision()
    }
    fn texture(&self, handle: i32) -> Option<TexView<'_>> {
        let view = self.source.texture(handle);
        if let (Some(_), Some(log)) = (view.as_ref(), self.log) {
            if let Ok(mut log) = log.try_borrow_mut() {
                log.push(handle);
            }
        }
        view
    }
    fn font_atlas(&self, slot: u8) -> Option<FontView<'_>> {
        self.source.font_atlas(slot)
    }
    fn texture_revision(&self, handle: i32) -> Option<u64> {
        self.source.texture_revision(handle)
    }
    fn font_revision(&self, slot: u8) -> Option<u64> {
        self.source.font_revision(slot)
    }
    fn font_texture_width(&self, slot: u8) -> Option<u32> {
        self.source.font_texture_width(slot)
    }
}

struct FrameGuard<'a> {
    coordinator: &'a mut Coordinator,
    // A render or wait may unwind without a terminal result. Destroy that
    // renderer before the caller's frame can unwind.
    rendering: Option<RendererId>,
    committed: bool,
}

impl FrameGuard<'_> {
    fn submit(
        &mut self,
        index: usize,
        list: &DrawList,
        resources: &dyn RenderResources,
    ) -> Result<(), PresentError> {
        let display = &mut self.coordinator.displays[index];
        let renderer = &mut self.coordinator.renderers[display.renderer.0 as usize];
        let descriptor = display.descriptor;
        let id = DisplayId(index);
        let region = Rect::new(
            0,
            display.next_y,
            descriptor.width,
            display.strip_height.min(descriptor.height - display.next_y),
        );
        let damage: Box<[Rect]> = display
            .damage
            .iter()
            .filter_map(|damage| intersect(*damage, region))
            .collect();
        display.next_y += region.height;
        if damage.is_empty() {
            return Ok(());
        }
        // Keep the descriptor storage in the coordinator before invoking a
        // driver. If render panics after retaining it, FrameGuard destroys the
        // renderer before this allocation can be released.
        display.acquired_damage = Some(damage);
        let target = display
            .driver
            .as_mut()
            .ok_or(PresentError::InvalidTarget(id))?
            .acquire(region)
            .map_err(|error| PresentError::Acquire(id, error))?;
        if target.region() != region
            || target.ownership() != descriptor.target_ownership
            || target.format() != descriptor.format
            || !renderer.descriptor.accepts(&target)
        {
            return Err(PresentError::InvalidTarget(id));
        }
        if let Target::CpuVisible(surface) = &target {
            if surface.stride_bytes() != descriptor.stride_bytes
                || surface.pixels().len() > display.reserved_bytes
            {
                return Err(PresentError::InvalidTarget(id));
            }
        }
        let mut input = FrameInput::new(
            list,
            resources,
            display.acquired_damage.as_ref().unwrap(),
            target,
        );
        let deferred = renderer.descriptor.synchronization() == Synchronization::Deferred;
        // A Deferred submission outlives this call: it borrows texture storage
        // only when the caller keeps that storage until retirement.
        let zero_copy =
            renderer.descriptor.zero_copy() && (!deferred || self.coordinator.deferred_zero_copy);
        self.rendering = Some(display.renderer);
        let result = renderer
            .driver
            .as_mut()
            .ok_or(PresentError::InvalidRenderer)?
            .render(&mut input, zero_copy);
        self.rendering = None;
        let submission = result.map_err(|error| PresentError::Render(id, error))?;
        display.pending = Some(Pending {
            submission,
            render_waited: false,
            display_in_call: false,
            damage: display.acquired_damage.take().unwrap(),
            token: None,
            defer: deferred,
            zero_copy,
        });
        Ok(())
    }

    fn finish_round(&mut self, unwinding: bool) -> Option<PresentError> {
        let mut failure = None;
        let frame = self.coordinator.frame;
        for index in (0..self.coordinator.displays.len()).rev() {
            let display = &mut self.coordinator.displays[index];
            let Some(pending) = display.pending.as_mut() else {
                continue;
            };
            let renderer = &mut self.coordinator.renderers[display.renderer.0 as usize];
            let id = DisplayId(index);
            if pending.defer && !unwinding {
                // The next present completes this frame. A queued flush is
                // ordered after the rendering on the device, so it may start
                // before the renderer wait.
                let mut flush_failed = false;
                if display.descriptor.queued_flush {
                    pending.display_in_call = true;
                    let driver = display.driver.as_mut().expect("registered display");
                    match driver.flush(&pending.damage) {
                        Ok(token) => pending.token = Some(token),
                        Err(error) => {
                            failure.get_or_insert(PresentError::Flush(id, error));
                            flush_failed = true;
                        }
                    }
                    pending.display_in_call = false;
                }
                if !flush_failed {
                    let mut pending = display.pending.take().expect("pending submission");
                    pending.defer = false;
                    display.deferred = Some(Deferred { frame, pending });
                    continue;
                }
                // The failed flush stopped its transfer. Complete the
                // submission here: renderer wait, then retirement.
                pending.defer = false;
                display.invalidate();
            }
            let pending = display.pending.as_mut().expect("pending submission");
            let rendered = if pending.render_waited {
                false // A prior unwinding wait/flush never permits another flush.
            } else {
                self.rendering = Some(display.renderer);
                let result = renderer
                    .driver
                    .as_mut()
                    .expect("registered renderer")
                    .wait(&*pending.submission);
                self.rendering = None;
                pending.render_waited = true;
                match result {
                    Ok(()) => true,
                    Err(error) => {
                        failure.get_or_insert(PresentError::RenderWait(id, error));
                        display.invalidate();
                        false
                    }
                }
            };
            let pending = display.pending.as_mut().expect("pending submission");
            if pending.display_in_call {
                // A display callback panicked before returning a terminal
                // result. Its token may have been consumed. Driver destruction
                // must stop device access; do that before renderer retirement.
                // The disabled display rejects subsequent acquisitions.
                drop(display.driver.take());
            } else if rendered && !unwinding && pending.token.is_none() {
                pending.display_in_call = true;
                let driver = display.driver.as_mut().expect("registered display");
                let result = driver.flush(&pending.damage);
                pending.display_in_call = false;
                match result {
                    Ok(token) => {
                        pending.token = Some(token);
                    }
                    Err(error) => {
                        failure.get_or_insert(PresentError::Flush(id, error));
                        display.invalidate();
                    }
                }
            }
            let pending = display.pending.as_mut().expect("pending submission");
            if pending.token.is_some() {
                display
                    .transfers
                    .push_back(display.pending.take().expect("pending submission"));
                let pipeline = display.descriptor.pipelined_acquire
                    && display.strip_height < display.descriptor.height;
                if !pipeline || display.transfers.len() >= 2 || unwinding {
                    if let Some(error) = finish_transfer(display, renderer, id) {
                        failure.get_or_insert(error);
                    }
                }
                continue;
            }
            // Both wait outcomes are terminal; success is not required for
            // retirement. A failed flush also guarantees terminal device work.
            let pending = display.pending.take().expect("pending submission");
            renderer
                .driver
                .as_mut()
                .expect("registered renderer")
                .retire(pending.submission);
        }
        failure
    }
    fn drain_transfers(&mut self) -> Option<PresentError> {
        let mut failure = None;
        for index in (0..self.coordinator.displays.len()).rev() {
            let display = &mut self.coordinator.displays[index];
            let renderer = &mut self.coordinator.renderers[display.renderer.0 as usize];
            while !display.transfers.is_empty() {
                if let Some(error) = finish_transfer(display, renderer, DisplayId(index)) {
                    failure.get_or_insert(error);
                }
            }
        }
        failure
    }
}

impl Drop for FrameGuard<'_> {
    fn drop(&mut self) {
        if !self.committed {
            self.coordinator.invalidate();
            // A failed or unwinding presentation leaves no Deferred work.
            for display in &mut self.coordinator.displays {
                if let Some(deferred) = display.deferred.take() {
                    display.pending = Some(deferred.pending);
                }
            }
        }
        if let Some(id) = self.rendering.take() {
            self.drain_transfers();
            // Drop stops all hardware, including submissions already returned
            // for other displays and the current call without a token. Only
            // then may submission destructors and display storage be released.
            drop(self.coordinator.renderers[id.0 as usize].driver.take());
            for display in &mut self.coordinator.displays {
                if display.renderer == id {
                    drop(display.pending.take());
                    drop(display.driver.take());
                    display.history_valid = false;
                }
            }
        }
        self.finish_round(true);
        self.drain_transfers();
    }
}

fn finish_transfer(
    display: &mut RegisteredDisplay,
    renderer: &mut RegisteredRenderer,
    id: DisplayId,
) -> Option<PresentError> {
    let pending = display
        .transfers
        .front_mut()
        .expect("pending display transfer");
    let mut failure = None;
    if pending.display_in_call {
        // An unwinding native wait consumed its token. Driver Drop drains all
        // device access before any corresponding renderer resource is retired.
        drop(display.driver.take());
    } else if let Some(driver) = display.driver.as_mut() {
        pending.display_in_call = true;
        let token = pending.token.take().expect("display token");
        let result = driver.wait(token);
        pending.display_in_call = false;
        if let Err(error) = result {
            failure = Some(PresentError::DisplayWait(id, error));
            display.invalidate();
        }
    }
    let pending = display.transfers.pop_front().unwrap();
    renderer
        .driver
        .as_mut()
        .expect("registered renderer")
        .retire(pending.submission);
    failure
}

fn intersect(a: Rect, b: Rect) -> Option<Rect> {
    let x = a.x.max(b.x);
    let y = a.y.max(b.y);
    let right = (a.x + a.width).min(b.x + b.width);
    let bottom = (a.y + a.height).min(b.y + b.height);
    (x < right && y < bottom).then(|| Rect::new(x, y, right - x, bottom - y))
}
fn physical_damage(
    regions: &[DamageRect],
    display: &DisplayDescriptor,
    scale: u32,
) -> Result<Vec<Rect>, PresentError> {
    let quantum = |a: u32, b: u32| {
        (a / gcd(a, b))
            .checked_mul(b)
            .ok_or(PresentError::InvalidDisplayDescriptor)
    };
    let xq = quantum(display.refresh_granularity[0], display.window_alignment[0])?;
    let yq = quantum(display.refresh_granularity[1], display.window_alignment[1])?;
    let up = |value: u64, step: u32, maximum: u32| {
        value
            .div_ceil(step as u64)
            .saturating_mul(step as u64)
            .min(maximum as u64) as u32
    };
    Ok(regions
        .iter()
        .map(|r| {
            let x = r.x0.max(0) as u32 * scale / xq * xq;
            let y = r.y0.max(0) as u32 * scale / yq * yq;
            let right = up(r.x1.max(0) as u64 * scale as u64, xq, display.width);
            let bottom = up(r.y1.max(0) as u64 * scale as u64, yq, display.height);
            Rect::new(x, y, right - x, bottom - y)
        })
        .collect())
}

fn validate_display(display: &DisplayDescriptor, scale: u32) -> Result<(), PresentError> {
    let row_bytes = display
        .format
        .row_bytes(display.width)
        .ok_or(PresentError::InvalidDisplayDescriptor)?;
    if display.width == 0
        || display.height == 0
        || display.width > i32::MAX as u32
        || display.height > i32::MAX as u32
        || display.target_ownership == TargetOwnership::CpuVisible
            && (!display.width.is_multiple_of(scale) || !display.height.is_multiple_of(scale))
        || display.stride_bytes < row_bytes
        || display
            .stride_bytes
            .checked_mul(display.height as usize)
            .is_none()
        || display.refresh_granularity.contains(&0)
        || display.window_alignment.contains(&0)
        || display.pipelined_acquire
            && (!display.double_buffered
                || !display.device_frame_storage
                || display.target_ownership != TargetOwnership::CpuVisible)
        || display.queued_flush && display.target_ownership != TargetOwnership::DeviceOwned
    {
        return Err(PresentError::InvalidDisplayDescriptor);
    }
    Ok(())
}

struct BufferPlan {
    rows: u32,
    bytes: usize,
    quantum: u32,
    row_cost: usize,
}

fn budget_plans(
    displays: &[DisplayDescriptor],
    budget: usize,
) -> Result<Vec<BufferPlan>, PresentError> {
    let mut plans = Vec::with_capacity(displays.len());
    let mut used = 0usize;
    for display in displays {
        if display.target_ownership == TargetOwnership::DeviceOwned {
            plans.push(BufferPlan {
                rows: display.height,
                bytes: 0,
                quantum: 1,
                row_cost: 0,
            });
            continue;
        }
        let a = display.refresh_granularity[1];
        let b = display.window_alignment[1];
        let quantum = (a / gcd(a, b))
            .checked_mul(b)
            .ok_or(PresentError::InvalidDisplayDescriptor)?;
        let rows = if display.device_frame_storage {
            quantum.min(display.height)
        } else {
            display.height
        };
        let row_cost = display
            .stride_bytes
            .checked_mul(if display.double_buffered { 2 } else { 1 })
            .ok_or(PresentError::BudgetExceeded)?;
        let bytes = row_cost
            .checked_mul(rows as usize)
            .ok_or(PresentError::BudgetExceeded)?;
        used = used
            .checked_add(bytes)
            .ok_or(PresentError::BudgetExceeded)?;
        plans.push(BufferPlan {
            rows,
            bytes,
            quantum,
            row_cost,
        });
    }
    let mut remaining = budget
        .checked_sub(used)
        .ok_or(PresentError::BudgetExceeded)?;
    for (display, plan) in displays.iter().zip(&mut plans) {
        if plan.row_cost == 0 || plan.rows == display.height {
            continue;
        }
        let affordable = (remaining / plan.row_cost)
            .saturating_add(plan.rows as usize)
            .min(display.height as usize) as u32;
        let rows = if affordable == display.height {
            affordable
        } else {
            affordable / plan.quantum * plan.quantum
        };
        let added = (rows - plan.rows) as usize * plan.row_cost;
        plan.rows = rows;
        plan.bytes += added;
        remaining -= added;
    }
    Ok(plans)
}

fn gcd(mut a: u32, mut b: u32) -> u32 {
    while b != 0 {
        let remainder = a % b;
        a = b;
        b = remainder;
    }
    a
}
