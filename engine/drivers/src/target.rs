//! Device target registration between one renderer and the displays that
//! present its targets.
//!
//! [`Renderer::render`] receives `Target::DeviceOwned(DeviceTarget)`, whose
//! handle the renderer issued. This module defines where that handle comes
//! from and how long it stays valid:
//!
//! - The composition creates the renderer and places it in a
//!   [`RendererCell`]. The cell is the only strong owner besides the runtime
//!   [`Registration`]; the renderer is destroyed when it is taken out of the
//!   cell ([`RendererCell::take`]) or when the last of the two drops.
//! - A display holds a [`TargetPort`], a weak link that reaches only the
//!   [`TargetRenderer`] methods. A port never keeps the renderer alive; every
//!   call after the renderer is gone, or while another call holds it, returns
//!   [`RenderError::Failed`].
//! - The composition or display creates each target's backing (a native
//!   framebuffer description, a texture view) and registers it through the
//!   port; the renderer validates it and issues the handle. A renderer that
//!   owns a fixed target issues the handle at construction instead.
//! - A handle is valid only for the renderer instance that issued it.
//!   Installing or taking a renderer advances [`RendererCell::instance`];
//!   handles of an earlier instance are stale, and the renderer rejects them
//!   as foreign. A target's region is fixed at registration: a resize
//!   registers a new target and unregisters the old one.
//! - Unregistering a target that a pending submission renders into follows
//!   [`TargetRenderer::PENDING_UNREGISTER`].
//! - Context loss is terminal for the renderer instance: render and wait
//!   return `Failed`, retirement releases without device calls, and the
//!   pending rule still applies until retirement. Recovery installs a new
//!   renderer in the cell, which makes every earlier handle stale.
//! - Destruction: the runtime drops its renderer registrations before its
//!   displays. Dropping a [`Registration`] runs
//!   [`TargetRenderer::end_registration`], which stops the work submitted
//!   through it. A display dropped afterwards finds either the renderer still
//!   owned by the composition or no renderer; its port calls then cost no
//!   device work. A display dropped first releases its targets through the
//!   port under the pending rule.

use crate::{DeviceTarget, FrameInput, RenderError, Renderer, RendererDescriptor};
use alloc::rc::{Rc, Weak};
use core::cell::{Cell, RefCell, RefMut};

/// What [`TargetRenderer::unregister_target`] does while a pending submission
/// renders into the target.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum PendingUnregister {
    /// Unregistering returns `RenderError::Failed` and keeps the
    /// registration until the last submission using the target retires.
    Refused,
    /// The registration is removed at once. Each encoded submission holds its
    /// own reference to the target's backing until it retires.
    Detached,
    /// The renderer owns one target for its whole life. Registering and
    /// unregistering return `RenderError::Unsupported`.
    Fixed,
}

/// The renderer half of the device target contract.
///
/// Handles are untrusted: `target`, `unregister_target`, `queue_present` and
/// `render` reject unknown, stale and foreign handles with
/// `RenderError::InvalidFrame`.
pub trait TargetRenderer: Renderer {
    /// What a registration supplies: the target's backing and its mapping.
    type TargetConfig;
    /// The renderer's rule for unregistering a target in use.
    const PENDING_UNREGISTER: PendingUnregister;

    /// Validate `config` and issue a handle for it.
    fn register_target(&mut self, config: Self::TargetConfig) -> Result<u64, RenderError>;
    fn unregister_target(&mut self, handle: u64) -> Result<(), RenderError>;
    /// The target a display returns from `acquire` for this handle.
    fn target(&self, handle: u64) -> Result<DeviceTarget, RenderError>;
    /// Queue the display transfer of the target's rendered frame behind the
    /// device work already submitted to it, for a display that declares
    /// `queued_flush`. An error means the work was drained first.
    fn queue_present(&mut self, handle: u64) -> Result<(), RenderError> {
        let _ = handle;
        Err(RenderError::Unsupported)
    }
    /// Wait for every queued display transfer.
    fn drain_present(&mut self) -> Result<(), RenderError> {
        Ok(())
    }
    /// The runtime registration ends: stop the work submitted through it.
    /// The renderer may stay in its cell for the composition's own drawing.
    fn end_registration(&mut self) {}
}

struct Slot<R> {
    renderer: RefCell<Option<R>>,
    instance: Cell<u64>,
}

impl<R> Slot<R> {
    fn with<T>(&self, f: impl FnOnce(&mut R) -> T) -> Result<T, RenderError> {
        let mut renderer = self
            .renderer
            .try_borrow_mut()
            .map_err(|_| RenderError::Failed)?;
        renderer.as_mut().map(f).ok_or(RenderError::Failed)
    }
    fn advance(&self) {
        self.instance.set(self.instance.get().wrapping_add(1));
    }
}

/// The composition's owner handle for one renderer. Clones share the cell.
pub struct RendererCell<R>(Rc<Slot<R>>);

impl<R> Clone for RendererCell<R> {
    fn clone(&self) -> Self {
        Self(self.0.clone())
    }
}

impl<R: TargetRenderer> RendererCell<R> {
    pub fn new(renderer: R) -> Self {
        let cell = Self::empty();
        *cell.0.renderer.borrow_mut() = Some(renderer);
        cell.0.advance();
        cell
    }
    /// A cell whose renderer the composition creates later, for example once
    /// a host context is current.
    pub fn empty() -> Self {
        Self(Rc::new(Slot {
            renderer: RefCell::new(None),
            instance: Cell::new(0),
        }))
    }
    /// Place a renderer in an empty cell. Every handle of an earlier
    /// instance becomes stale. Returns the renderer when the cell holds one
    /// or a call is using it.
    pub fn install(&self, renderer: R) -> Result<(), R> {
        let Ok(mut slot) = self.0.renderer.try_borrow_mut() else {
            return Err(renderer);
        };
        if slot.is_some() {
            return Err(renderer);
        }
        *slot = Some(renderer);
        drop(slot);
        self.0.advance();
        Ok(())
    }
    /// Remove the renderer. Its handles become stale; the caller drops it.
    pub fn take(&self) -> Result<Option<R>, RenderError> {
        let renderer = self
            .0
            .renderer
            .try_borrow_mut()
            .map_err(|_| RenderError::Failed)?
            .take();
        if renderer.is_some() {
            self.0.advance();
        }
        Ok(renderer)
    }
    /// Run `f` on the renderer. `Failed` when the cell is empty or in use.
    pub fn with<T>(&self, f: impl FnOnce(&mut R) -> T) -> Result<T, RenderError> {
        self.0.with(f)
    }
    /// Exclusive access to the renderer; None when the cell is empty or in use.
    pub fn borrow_mut(&self) -> Option<RefMut<'_, R>> {
        let slot = self.0.renderer.try_borrow_mut().ok()?;
        RefMut::filter_map(slot, Option::as_mut).ok()
    }
    /// Advances each time a renderer is installed or taken.
    pub fn instance(&self) -> u64 {
        self.0.instance.get()
    }
    pub fn port(&self) -> TargetPort<R> {
        TargetPort(Rc::downgrade(&self.0))
    }
    /// The runtime registration, with the installed renderer's descriptor.
    pub fn registration(&self) -> Result<Registration<R>, RenderError> {
        let descriptor = self.with(|renderer| renderer.descriptor())?;
        Ok(self.registration_with(descriptor))
    }
    /// The runtime registration of a cell that may still be empty. The
    /// descriptor must describe every renderer later installed in the cell.
    pub fn registration_with(&self, descriptor: RendererDescriptor) -> Registration<R> {
        Registration {
            slot: self.0.clone(),
            descriptor,
        }
    }
}

/// The `Renderer` a composition registers with the runtime. It renders with
/// the cell's current renderer; an empty cell fails render and wait, and
/// retirement of a submission from a removed renderer does nothing. Drop runs
/// [`TargetRenderer::end_registration`] when the cell holds a renderer that no
/// call is using.
pub struct Registration<R: TargetRenderer> {
    slot: Rc<Slot<R>>,
    descriptor: RendererDescriptor,
}

impl<R: TargetRenderer> Renderer for Registration<R> {
    type Submission = R::Submission;
    fn descriptor(&self) -> RendererDescriptor {
        self.descriptor
    }
    fn render(&mut self, frame: &mut FrameInput<'_>) -> Result<Self::Submission, RenderError> {
        self.slot.with(|renderer| renderer.render(frame))?
    }
    unsafe fn render_zero_copy(
        &mut self,
        frame: &mut FrameInput<'_>,
    ) -> Result<Self::Submission, RenderError> {
        // SAFETY: the caller's zero-copy promise passes through unchanged.
        self.slot
            .with(|renderer| unsafe { renderer.render_zero_copy(frame) })?
    }
    fn wait(&mut self, submission: &Self::Submission) -> Result<(), RenderError> {
        self.slot.with(|renderer| renderer.wait(submission))?
    }
    fn retire(&mut self, submission: Self::Submission) {
        let _ = self.slot.with(|renderer| renderer.retire(submission));
    }
}

impl<R: TargetRenderer> Drop for Registration<R> {
    fn drop(&mut self) {
        let _ = self.slot.with(R::end_registration);
    }
}

/// A display's link to the renderer that owns its targets. It reaches only
/// the [`TargetRenderer`] methods and never keeps the renderer alive.
pub struct TargetPort<R>(Weak<Slot<R>>);

impl<R> Clone for TargetPort<R> {
    fn clone(&self) -> Self {
        Self(self.0.clone())
    }
}

impl<R: TargetRenderer> TargetPort<R> {
    fn with<T>(&self, f: impl FnOnce(&mut R) -> T) -> Result<T, RenderError> {
        self.0.upgrade().ok_or(RenderError::Failed)?.with(f)
    }
    /// The instance of the cell's renderer; None once the renderer is gone
    /// for good or the cell is empty.
    pub fn instance(&self) -> Option<u64> {
        let slot = self.0.upgrade()?;
        let occupied = slot.renderer.try_borrow().map_or(true, |r| r.is_some());
        occupied.then(|| slot.instance.get())
    }
    pub fn pending_unregister(&self) -> PendingUnregister {
        R::PENDING_UNREGISTER
    }
    pub fn register(&self, config: R::TargetConfig) -> Result<u64, RenderError> {
        self.with(|renderer| renderer.register_target(config))?
    }
    pub fn unregister(&self, handle: u64) -> Result<(), RenderError> {
        self.with(|renderer| renderer.unregister_target(handle))?
    }
    pub fn target(&self, handle: u64) -> Result<DeviceTarget, RenderError> {
        self.with(|renderer| TargetRenderer::target(renderer, handle))?
    }
    pub fn queue_present(&self, handle: u64) -> Result<(), RenderError> {
        self.with(|renderer| renderer.queue_present(handle))?
    }
    pub fn drain_present(&self) -> Result<(), RenderError> {
        self.with(R::drain_present)?
    }
}

/// One registered target that its holder replaces each frame or on resize.
/// The slot remembers the renderer instance that issued the handle: a stale
/// handle is forgotten without a renderer call. Drop releases the target.
pub struct TargetSlot<R: TargetRenderer> {
    port: TargetPort<R>,
    current: Option<(u64, u64)>,
}

impl<R: TargetRenderer> TargetSlot<R> {
    pub fn new(port: TargetPort<R>) -> Self {
        Self {
            port,
            current: None,
        }
    }
    /// Release the current target, then register `config`. When the
    /// renderer refuses the release, the current target stays and the error
    /// is returned before anything is registered.
    pub fn replace(&mut self, config: R::TargetConfig) -> Result<DeviceTarget, RenderError> {
        self.release()?;
        let instance = self.port.instance().ok_or(RenderError::Failed)?;
        let handle = self.port.register(config)?;
        self.current = Some((instance, handle));
        self.port.target(handle)
    }
    /// The current target's handle, if the renderer that issued it is still
    /// installed.
    pub fn handle(&self) -> Option<u64> {
        let (instance, handle) = self.current?;
        (self.port.instance() == Some(instance)).then_some(handle)
    }
    /// The current target, validated by the renderer.
    pub fn target(&self) -> Result<DeviceTarget, RenderError> {
        self.port
            .target(self.handle().ok_or(RenderError::InvalidFrame)?)
    }
    /// Unregister the current target. A stale or unknown handle is
    /// forgotten; a refusal keeps it and returns the error.
    pub fn release(&mut self) -> Result<(), RenderError> {
        let Some(handle) = self.handle() else {
            self.current = None;
            return Ok(());
        };
        match self.port.unregister(handle) {
            Ok(()) | Err(RenderError::InvalidFrame) => {
                self.current = None;
                Ok(())
            }
            Err(error) => Err(error),
        }
    }
}

impl<R: TargetRenderer> Drop for TargetSlot<R> {
    fn drop(&mut self) {
        let _ = self.release();
    }
}
