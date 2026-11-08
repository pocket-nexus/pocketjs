use crate::registered_renderer::RegisteredRenderer;
use pocket_drivers::target::RendererCell;
use pocket_drivers::{DrawList, FrameInput, RenderError, Renderer, Target};
use pocket_vita_render::{Command, Config, Device, GxmRenderer, TextureFormat, Vertex};
use std::{cell::RefCell, panic::AssertUnwindSafe, rc::Rc};

#[derive(Default)]
struct State {
    events: Vec<&'static str>,
    active: bool,
    display_pending: bool,
    panic_submit: bool,
    fail_wait: bool,
}
#[derive(Clone)]
struct Mock(Rc<RefCell<State>>);
unsafe impl Device for Mock {
    type Frame = ();
    fn upload(
        &mut self,
        _: &[u8],
        _: u32,
        _: u32,
        _: TextureFormat,
        _: bool,
    ) -> Result<u32, RenderError> {
        unreachable!("the fixture submits an empty DrawList")
    }
    fn release_texture(&mut self, _: u32) {}
    fn submit(
        &mut self,
        _: &[Vertex],
        _: &[Command],
        _: (i32, i32),
        _: Option<u32>,
    ) -> Result<(), RenderError> {
        let mut state = self.0.borrow_mut();
        state.events.push("submit");
        state.active = true;
        assert!(
            !state.panic_submit,
            "native submission panicked before returning its token"
        );
        Ok(())
    }
    fn begin_external(&mut self, _: u32) -> Result<(), RenderError> {
        let mut state = self.0.borrow_mut();
        assert!(!state.active, "previous scene still active");
        state.active = true;
        state.events.push("begin");
        Ok(())
    }
    fn wait(&mut self) -> Result<(), RenderError> {
        let mut state = self.0.borrow_mut();
        state.events.push("gpu-terminal");
        state.active = false;
        if state.fail_wait {
            Err(RenderError::Failed)
        } else {
            Ok(())
        }
    }
    fn wait_display(&mut self) -> Result<(), RenderError> {
        let mut state = self.0.borrow_mut();
        state.events.push("display-terminal");
        state.display_pending = false;
        Ok(())
    }
    fn retire(&mut self, _: ()) {
        let mut state = self.0.borrow_mut();
        assert!(
            !state.active && !state.display_pending,
            "retired before terminal waits"
        );
        state.events.push("retire");
    }
}

#[test]
fn registered_renderer_drop_stops_work_while_process_rc_remains_alive() {
    let state = Rc::new(RefCell::new(State::default()));
    let process = RendererCell::new(
        GxmRenderer::new(Mock(state.clone()), Config::new(960, 544, 2)).unwrap(),
    );
    process.borrow_mut().unwrap().begin_frame(0).unwrap();
    let mut registered: RegisteredRenderer<Mock> = process.registration().unwrap();
    let mut ui = pocketjs_core::Ui::new();
    ui.set_viewport(480., 272.);
    let target = process.borrow_mut().unwrap().target();
    let list = DrawList::new();
    let token = registered
        .render(&mut FrameInput::new(
            &list,
            &ui,
            &[],
            Target::DeviceOwned(target),
        ))
        .unwrap();
    state.borrow_mut().display_pending = true;
    state.borrow_mut().fail_wait = true;
    drop(registered);
    assert!(process.borrow_mut().is_some(), "the process keeps its renderer");
    assert_eq!(
        state.borrow().events,
        [
            "gpu-terminal",
            "begin",
            "submit",
            "display-terminal",
            "gpu-terminal",
            "retire"
        ]
    );
    // The token and native host reference can both outlive the registration.
    process.borrow_mut().unwrap().retire(token);
    state.borrow_mut().fail_wait = false;
    process.borrow_mut().unwrap().begin_frame(0).unwrap();
    process.borrow_mut().unwrap().discard_frame().unwrap();
    // The registration held no other owner: the process cell was the last.
    let port = process.port();
    drop(process);
    assert_eq!(port.instance(), None);
}

#[test]
fn registered_renderer_unwind_stops_submission_without_returned_token() {
    let state = Rc::new(RefCell::new(State {
        panic_submit: true,
        ..Default::default()
    }));
    let process = RendererCell::new(
        GxmRenderer::new(Mock(state.clone()), Config::new(960, 544, 2)).unwrap(),
    );
    let mut ui = pocketjs_core::Ui::new();
    ui.set_viewport(480., 272.);
    let target = process.borrow_mut().unwrap().target();
    let list = DrawList::new();
    let panic = std::panic::catch_unwind(AssertUnwindSafe(|| {
        let mut registered: RegisteredRenderer<Mock> = process.registration().unwrap();
        let _ = registered.render(&mut FrameInput::new(
            &list,
            &ui,
            &[],
            Target::DeviceOwned(target),
        ));
    }));
    assert!(panic.is_err());
    assert!(process.borrow_mut().is_some(), "the unwound call released the renderer");
    assert!(!state.borrow().active);
    assert_eq!(
        state.borrow().events,
        ["submit", "display-terminal", "gpu-terminal"]
    );
    process.borrow_mut().unwrap().begin_frame(0).unwrap();
    process.borrow_mut().unwrap().discard_frame().unwrap();
    let port = process.port();
    drop(process);
    assert_eq!(port.instance(), None);
}
