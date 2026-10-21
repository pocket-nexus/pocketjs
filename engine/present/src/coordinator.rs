//! Register drivers and complete a frame's rendering and display transfers.
//!
//! Drivers can identify retained output buffers for incremental damage. GRAM
//! displays can overlap two CPU staging buffers when they declare that acquire
//! does not reuse storage read by a pending transfer.

use crate::damage::{DamagePolicy, DamageTarget, DamageTracker};
use alloc::{boxed::Box, collections::VecDeque, vec::Vec};
use core::any::Any;

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
            // SAFETY: this adapter is private to Coordinator. Its frame guard
            // waits before the caller's DrawLists/resources or the per-display
            // resource wrappers/damage arrays can be changed or released.
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
    acquired_damage: Option<Box<[Rect]>>,
    transfers: VecDeque<Pending>,
    histories: Vec<(BufferIdentity, DamageTracker)>,
    history_slot: Option<usize>,
    history_valid: bool,
}

/// A synchronous frame boundary over drivers which may submit asynchronous
/// work. It owns the registered drivers and erases their token types.
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
        };
        result.add_renderer(software)?;
        Ok(result)
    }

    /// Change the logical-to-physical scale after package admission. This
    /// replaces only the built-in software renderer; custom renderers retain
    /// their own configuration. Call before the next presentation begins.
    pub fn set_scale(&mut self, scale: u32) -> Result<(), PresentError> {
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
    /// Validation and budget planning finish before registration changes. A
    /// primary display must have the requested physical viewport.
    pub fn refresh_displays(&mut self, scale: u32, primary: [u32; 2]) -> Result<(), PresentError> {
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
            display.history_valid = false;
            for (_, tracker) in &mut display.histories {
                tracker.invalidate();
            }
        }
    }

    /// Present both roles, then finish every render/display wait and retirement
    /// before returning, including on failure. Several displays may hold live
    /// submissions from the same renderer; completion drains in reverse display
    /// order. A strip is reacquired only after its previous transfer terminates.
    /// If render unwinds before returning a submission, its renderer is
    /// destroyed to stop hardware and every display using it is disabled.
    /// Further presentation rejects the disabled registration.
    ///
    /// Primary geometry must match the resources' viewport at this scale.
    /// Auxiliary viewport dimensions come from its display dimensions / scale;
    /// resource lookup and revisions still refer to the same application.
    pub fn present(
        &mut self,
        primary: &DrawList,
        auxiliary: Option<&DrawList>,
        resources: &dyn RenderResources,
    ) -> Result<(), PresentError> {
        let result = self.present_inner(primary, auxiliary, resources, None);
        if result.is_err() {
            self.invalidate();
        }
        result
    }

    /// Draw host overlays after each device-owned UI submission and before its
    /// terminal render wait. The callback must use the same device/context and
    /// finish submitting commands before returning. All outputs must be
    /// device-owned. Each callback runs once per display; damage is full because
    /// host overlay changes are not represented by the UI DrawList.
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
        let mut views = Vec::with_capacity(self.displays.len());
        for (index, display) in self.displays.iter_mut().enumerate() {
            let descriptor = display.descriptor;
            let list = match descriptor.role {
                DisplayRole::Primary => {
                    if descriptor.width != primary_width || descriptor.height != primary_height {
                        return Err(PresentError::InvalidFrame);
                    }
                    primary
                }
                DisplayRole::Auxiliary => auxiliary.ok_or(PresentError::MissingAuxiliary)?,
                _ => return Err(PresentError::InvalidDisplayDescriptor),
            };
            let viewport = (
                descriptor.width / self.scale,
                descriptor.height / self.scale,
            );
            pocket_draw_ops::validate(
                &list.words,
                DamageRect::new(0, 0, viewport.0 as i32, viewport.1 as i32),
            )
            .map_err(|_| PresentError::InvalidFrame)?;
            views.push(FrameResources {
                source: resources,
                viewport,
            });
            display.next_y = 0;
            let identity = display
                .driver
                .as_mut()
                .expect("validated display")
                .frame_identity()
                .map_err(|error| PresentError::Acquire(DisplayId(index), error))?;
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
        Ok(())
    }
}

struct FrameResources<'a> {
    source: &'a dyn RenderResources,
    viewport: (u32, u32),
}

impl RenderResources for FrameResources<'_> {
    fn viewport(&self) -> (f32, f32) {
        (self.viewport.0 as f32, self.viewport.1 as f32)
    }
    fn raster_revision(&self) -> u64 {
        self.source.raster_revision()
    }
    fn texture(&self, handle: i32) -> Option<TexView<'_>> {
        self.source.texture(handle)
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
        self.rendering = Some(display.renderer);
        let result = renderer
            .driver
            .as_mut()
            .ok_or(PresentError::InvalidRenderer)?
            .render(&mut input, renderer.descriptor.zero_copy());
        self.rendering = None;
        let submission = result.map_err(|error| PresentError::Render(id, error))?;
        display.pending = Some(Pending {
            submission,
            render_waited: false,
            display_in_call: false,
            damage: display.acquired_damage.take().unwrap(),
            token: None,
        });
        Ok(())
    }

    fn finish_round(&mut self, unwinding: bool) -> Option<PresentError> {
        let mut failure = None;
        for index in (0..self.coordinator.displays.len()).rev() {
            let display = &mut self.coordinator.displays[index];
            let Some(pending) = display.pending.as_mut() else {
                continue;
            };
            let renderer = &mut self.coordinator.renderers[display.renderer.0 as usize];
            let id = DisplayId(index);
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
                        false
                    }
                }
            };
            if pending.display_in_call {
                // A display callback panicked before returning a terminal
                // result. Its token may have been consumed. Driver destruction
                // must stop device access; do that before renderer retirement.
                // The disabled display rejects subsequent acquisitions.
                drop(display.driver.take());
            } else if rendered && !unwinding {
                pending.display_in_call = true;
                let driver = display.driver.as_mut().expect("registered display");
                match driver.flush(&pending.damage) {
                    Ok(token) => {
                        pending.token = Some(token);
                    }
                    Err(error) => {
                        failure.get_or_insert(PresentError::Flush(id, error));
                    }
                }
                pending.display_in_call = false;
            }
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
        if let Err(error) = driver.wait(token) {
            failure = Some(PresentError::DisplayWait(id, error));
        }
        pending.display_in_call = false;
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
        || !display.width.is_multiple_of(scale)
        || !display.height.is_multiple_of(scale)
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
