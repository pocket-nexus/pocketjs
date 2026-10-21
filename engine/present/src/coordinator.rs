//! Register drivers and complete a frame's rendering and display transfers.
//!
//! Acquired CPU surfaces have no persistent buffer identity in this version of
//! the driver contract. Every presentation therefore redraws each full display,
//! using strips when its device frame storage and the host budget allow that.
//! The completion flag is diagnostic; it never permits skipping a redraw.

use alloc::{boxed::Box, vec::Vec};
use core::any::Any;

use pocket_drivers::{
    DamageRect, DisplayDescriptor, DisplayError, DisplayOutput, DisplayRole, DrawList, FontView,
    FrameInput, Rect, RenderError, RenderResources, Renderer, RendererDescriptor, Synchronization,
    Target, TargetOwnership, TexView,
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
    fn acquire(&mut self, region: Rect) -> Result<Target<'_>, DisplayError>;
    fn flush(&mut self, regions: &[Rect]) -> Result<ErasedValue, DisplayError>;
    fn wait(&mut self, token: ErasedValue) -> Result<(), DisplayError>;
}

struct DisplayAdapter<D>(D);

impl<D: DisplayOutput> ErasedDisplay for DisplayAdapter<D>
where
    D::Token: 'static,
{
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
}

struct RegisteredDisplay {
    descriptor: DisplayDescriptor,
    driver: Option<Box<dyn ErasedDisplay>>,
    renderer: RendererId,
    strip_height: u32,
    reserved_bytes: usize,
    next_y: u32,
    damage: [Rect; 1],
    pending: Option<Pending>,
    history_valid: bool,
}

/// A synchronous frame boundary over drivers which may submit asynchronous
/// work. It owns the registered drivers and erases their token types.
///
/// The budget accounts for host CPU framebuffer storage across all displays;
/// device-owned targets consume no host framebuffer reservation. Double-buffer
/// descriptors reserve two buffers even though this coordinator waits before
/// reusing a strip. Drivers own the actual allocation and must honor the
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
            damage: [Rect::default()],
            pending: None,
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
        self.invalidate();
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
        for display in &mut self.displays {
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
        }
        // Drop this guard before `views` on either return or unwinding. In
        // particular, zero-copy renderers may retain the resource wrapper.
        let mut frame = FrameGuard {
            coordinator: self,
            rendering: None,
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
                    Ok(()) => submitted = true,
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
        for display in &mut frame.coordinator.displays {
            display.history_valid = true;
        }
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
    // A render may unwind after starting zero-copy work but before returning
    // a token. Destroy that renderer before the caller's frame can unwind.
    rendering: Option<RendererId>,
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
        display.damage[0] = region;
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
        let mut input = FrameInput::new(list, resources, &display.damage, target);
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
                let result = renderer
                    .driver
                    .as_mut()
                    .expect("registered renderer")
                    .wait(&*pending.submission);
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
                match driver.flush(&display.damage) {
                    Ok(token) => {
                        if let Err(error) = driver.wait(token) {
                            failure.get_or_insert(PresentError::DisplayWait(id, error));
                        }
                    }
                    Err(error) => {
                        failure.get_or_insert(PresentError::Flush(id, error));
                    }
                }
                pending.display_in_call = false;
            }
            // Both wait outcomes are terminal; success is not required for
            // retirement. A failed flush also guarantees terminal device work.
            let pending = display.pending.take().expect("pending submission");
            renderer
                .driver
                .as_mut()
                .expect("registered renderer")
                .retire(pending.submission);
            display.next_y += display.damage[0].height;
        }
        failure
    }
}

impl Drop for FrameGuard<'_> {
    fn drop(&mut self) {
        if let Some(id) = self.rendering.take() {
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
    }
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
