//! Runtime registration owns a terminal boundary even when the process keeps
//! another Rc for native drawing and subsequent guests.
use pocket_drivers::{FrameInput, RenderError, Renderer, RendererDescriptor};
use pocket_vita_render::{Device, GxmRenderer, Submission};
use std::{cell::RefCell, rc::Rc};

pub(crate) struct RegisteredRenderer<D: Device>(pub Rc<RefCell<GxmRenderer<D>>>);
impl<D: Device> Renderer for RegisteredRenderer<D> {
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
impl<D: Device> Drop for RegisteredRenderer<D> {
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
