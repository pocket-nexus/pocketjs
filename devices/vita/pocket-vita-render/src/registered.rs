//! Runtime registration owns a terminal boundary even when the process keeps
//! another Rc for native drawing and subsequent guests.
use crate::{Device, GxmRenderer, Submission};
use alloc::rc::Rc;
use core::cell::RefCell;
use pocket_drivers::{FrameInput, RenderError, Renderer, RendererDescriptor};

/// One Runtime registration owns the terminal boundary. Extra Rc handles are
/// for that program's native scene; do not register the same device in multiple
/// independent runtimes. Drop drains display and render work before returning.
pub struct SharedRenderer<D: Device>(pub Rc<RefCell<GxmRenderer<D>>>);
impl<D: Device> Renderer for SharedRenderer<D> {
    type Submission = Submission;
    fn descriptor(&self) -> RendererDescriptor {
        self.0.borrow().descriptor()
    }
    fn render(&mut self, frame: &mut FrameInput<'_>) -> Result<Submission, RenderError> {
        self.0.borrow_mut().render(frame)
    }
    unsafe fn render_zero_copy(
        &mut self,
        _: &mut FrameInput<'_>,
    ) -> Result<Submission, RenderError> {
        Err(RenderError::Unsupported)
    }
    fn wait(&mut self, token: &Submission) -> Result<(), RenderError> {
        self.0.borrow_mut().wait(token)
    }
    fn retire(&mut self, token: Submission) {
        self.0.borrow_mut().retire(token)
    }
}
impl<D: Device> Drop for SharedRenderer<D> {
    fn drop(&mut self) {
        // FrameGuard drops its renderer after the active call's RefMut unwinds.
        // A process/native drawing Rc can keep the underlying driver alive.
        if let Ok(mut renderer) = self.0.try_borrow_mut() {
            // Finish prior display transfers before discard_frame retires any
            // submission. No current scene is flushed during this cleanup.
            let _ = renderer.wait_display();
            let _ = renderer.discard_frame();
        }
    }
}

/// A display paired with one SharedRenderer. Use on the same owning thread.
pub struct GxmDisplay<D: Device> {
    role: pocket_drivers::DisplayRole,
    shared: Rc<RefCell<GxmRenderer<D>>>,
    acquired: bool,
    pending: Option<u64>,
    next: u64,
}
impl<D: Device> pocket_drivers::DisplayOutput for GxmDisplay<D> {
    type Token = u64;
    fn descriptor(&self) -> pocket_drivers::DisplayDescriptor {
        let target = self.shared.borrow().target();
        let mut d = pocket_drivers::DisplayDescriptor::new(
            self.role,
            target.region.width,
            target.region.height,
            pocket_drivers::PixelFormat::Rgba8888,
            target.region.width as usize * 4,
            pocket_drivers::TargetOwnership::DeviceOwned,
        );
        d.vsync = pocket_drivers::VsyncSource::Display;
        // vita2d queues the swap behind the scene's GXM sync object.
        d.queued_flush = true;
        d
    }
    fn acquire(
        &mut self,
        region: pocket_drivers::Rect,
    ) -> Result<pocket_drivers::Target<'_>, pocket_drivers::DisplayError> {
        let target = self.shared.borrow().target();
        if self.pending.is_some() || region != target.region {
            return Err(pocket_drivers::DisplayError::InvalidTarget);
        }
        self.acquired = true;
        Ok(pocket_drivers::Target::DeviceOwned(target))
    }
    fn flush(&mut self, _: &[pocket_drivers::Rect]) -> Result<u64, pocket_drivers::DisplayError> {
        if !self.acquired || self.pending.is_some() {
            return Err(pocket_drivers::DisplayError::InvalidTarget);
        }
        self.acquired = false;
        let token = self.next;
        self.next = self
            .next
            .checked_add(1)
            .ok_or(pocket_drivers::DisplayError::Failed)?;
        self.shared
            .borrow_mut()
            .queue_display()
            .map_err(|_| pocket_drivers::DisplayError::Failed)?;
        self.pending = Some(token);
        Ok(token)
    }
    /// The swap stays queued. GXM sync objects keep the display buffers from
    /// being rendered while scanned out, and retirement releases only vertex
    /// and texture storage covered by the renderer wait, so no display-queue
    /// drain runs per frame.
    fn wait(&mut self, token: u64) -> Result<(), pocket_drivers::DisplayError> {
        if self.pending != Some(token) {
            return Err(pocket_drivers::DisplayError::InvalidTarget);
        }
        self.pending = None;
        Ok(())
    }
    fn vsync(&mut self) -> pocket_drivers::VsyncSource {
        pocket_drivers::VsyncSource::Display
    }
}
impl<D: Device> Drop for GxmDisplay<D> {
    fn drop(&mut self) {
        if self.pending.take().is_some() {
            let _ = self.shared.borrow_mut().wait_display();
        }
    }
}

impl<D: Device> GxmDisplay<D> {
    pub fn new(shared: Rc<RefCell<GxmRenderer<D>>>, role: pocket_drivers::DisplayRole) -> Self {
        Self {
            shared,
            role,
            acquired: false,
            pending: None,
            next: 1,
        }
    }
}
