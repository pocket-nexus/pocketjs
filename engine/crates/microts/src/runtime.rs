//! A compiled MicroTS app is a guest of the same Runtime used by JavaScript.
//! Runtime owns the retained core, input encoding, core ticks and presentation.

use crate::Ui;
use alloc::rc::Rc;
use core::cell::RefCell;
use pocket_runtime::{Guest, GuestEnvironment, GuestFrame, OpContext, RuntimeError};

pub trait AotApp: Sized {
    fn mount(ui: Ui, environment: &GuestEnvironment<'_>) -> Result<Self, RuntimeError>;
    fn frame(&mut self, frame: &GuestFrame<'_>) -> Result<(), RuntimeError>;
    /// The core is invalidated before shutdown. Release app-owned resources
    /// here without dispatching UI operations.
    fn shutdown(&mut self) {}
}

pub type AppState<A> = Rc<RefCell<Option<A>>>;

pub struct AotGuest<A> {
    state: AppState<A>,
}
impl<A> AotGuest<A> {
    pub fn new() -> (Self, AppState<A>) {
        let state = Rc::new(RefCell::new(None));
        (
            Self {
                state: state.clone(),
            },
            state,
        )
    }
}
impl<A: AotApp> Guest for AotGuest<A> {
    fn initialize(
        &mut self,
        ops: OpContext,
        environment: &GuestEnvironment<'_>,
    ) -> Result<(), RuntimeError> {
        let mut state = self
            .state
            .try_borrow_mut()
            .map_err(|_| RuntimeError::Busy)?;
        if state.is_some() {
            return Err(RuntimeError::InvalidState);
        }
        *state = Some(A::mount(Ui::from_runtime(ops), environment)?);
        Ok(())
    }
    fn evaluate(&mut self, _code: &[u8]) -> Result<(), RuntimeError> {
        // AOT code is linked into the product. Use Runtime::boot_aot_deferred;
        // a package cannot substitute a payload for that compiled app.
        Err(RuntimeError::Guest)
    }
    fn frame(&mut self, frame: &GuestFrame<'_>) -> Result<(), RuntimeError> {
        self.state
            .try_borrow_mut()
            .map_err(|_| RuntimeError::Busy)?
            .as_mut()
            .ok_or(RuntimeError::InvalidState)?
            .frame(frame)
    }
    fn shutdown(&mut self) {
        let Ok(mut state) = self.state.try_borrow_mut() else {
            return;
        };
        if let Some(mut app) = state.take() {
            app.shutdown();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::boxed::Box;
    use pocket_drivers::*;
    use pocket_runtime::{OpArg, OpResult, RendererId, Runtime, RuntimeConfig};
    struct App {
        ui: Ui,
        frames: usize,
    }
    impl AotApp for App {
        fn mount(mut ui: Ui, env: &GuestEnvironment<'_>) -> Result<Self, RuntimeError> {
            assert_eq!(env.viewport, [4, 4]);
            assert!(env.pak.is_empty());
            assert!(env.assets.is_none());
            assert!(
                ui.core_mut()
                    .animate(1, crate::spec::prop::TRANSLATE_X, 60.0, 1000, 0, 0)
                    >= 0
            );
            Ok(Self { ui, frames: 0 })
        }
        fn frame(&mut self, _: &GuestFrame<'_>) -> Result<(), RuntimeError> {
            self.frames += 1;
            self.ui.tick();
            Ok(())
        }
    }
    struct Display([u8; 64]);
    impl DisplayOutput for Display {
        type Token = ();
        fn descriptor(&self) -> DisplayDescriptor {
            DisplayDescriptor::new(
                DisplayRole::Primary,
                4,
                4,
                PixelFormat::Rgba8888,
                16,
                TargetOwnership::CpuVisible,
            )
        }
        fn acquire(&mut self, r: Rect) -> Result<Target<'_>, DisplayError> {
            Ok(Target::CpuVisible(Surface::new(
                &mut self.0,
                r,
                16,
                PixelFormat::Rgba8888,
            )?))
        }
        fn flush(&mut self, _: &[Rect]) -> Result<(), DisplayError> {
            Ok(())
        }
        fn wait(&mut self, _: ()) -> Result<(), DisplayError> {
            Ok(())
        }
        fn vsync(&mut self) -> VsyncSource {
            VsyncSource::None
        }
    }
    #[test]
    fn compiled_guest_shares_core_and_runtime_advances_animation_once() {
        let json = br#"{"capabilities":[],"display":{"logicalViewports":[[4,4]],"physicalViewport":[4,4],"presentations":["native"],"rasterDensity":1},"form":"takeover","id":"aot","platform":"test","tickHz":60}"#;
        let hash = pocket_package::sha256::sha256(json);
        let mut runtime = Runtime::new(RuntimeConfig {
            profile_hash: hash,
            profile_json: json.to_vec(),
            host_abi: pocket_spec::BINDING_GENERATION,
            tick_hz: 60,
            heap_limit: 65536,
            frame_buffer_budget: 64,
        })
        .unwrap();
        let (guest, app) = AotGuest::<App>::new();
        runtime.set_guest(Box::new(guest)).unwrap();
        runtime
            .add_display(Display([0; 64]), RendererId::SOFTWARE)
            .unwrap();
        assert_eq!(
            runtime.boot_aot_deferred([0; 32], [4, 4], false),
            Err(RuntimeError::ProfileMismatch)
        );
        runtime.boot_aot_deferred(hash, [4, 4], false).unwrap();
        assert_eq!(app.borrow().as_ref().unwrap().frames, 0);
        let ops = runtime.op_context();
        assert!(!ops.supports_op(23)); // no package-backed tile operation
        runtime.present().unwrap();
        runtime.tick().unwrap();
        let state = app.borrow();
        let state = state.as_ref().unwrap();
        assert_eq!(state.frames, 1);
        let x = state.ui.core().resolved_style(1).unwrap().translate_x;
        assert!((x - 1.0).abs() < 0.001, "one 60 Hz core step: {x}");
        let id = match ops.dispatch(1, &[OpArg::Integer(1)]).unwrap() {
            OpResult::Integer(id) => id as i32,
            _ => panic!("create result"),
        };
        assert!(state.ui.core().resolved_style(id).is_some());
        // A retained read handle cannot keep a stopped Runtime usable.
        drop(runtime);
        assert!(!ops.supports_op(1));
    }
    #[test]
    fn zero_cpu_budget_is_accepted_but_rejects_cpu_visible_display() {
        let json = br#"{"capabilities":[],"display":{"logicalViewports":[[4,4]],"physicalViewport":[4,4],"presentations":["native"],"rasterDensity":1},"form":"takeover","id":"aot","platform":"test","tickHz":60}"#;
        let mut runtime = Runtime::new(RuntimeConfig {
            profile_hash: pocket_package::sha256::sha256(json),
            profile_json: json.to_vec(),
            host_abi: pocket_spec::BINDING_GENERATION,
            tick_hz: 60,
            heap_limit: 65536,
            frame_buffer_budget: 0,
        })
        .unwrap();
        assert!(
            runtime
                .add_display(Display([0; 64]), RendererId::SOFTWARE)
                .is_err()
        );
    }
    #[test]
    fn aot_guest_rejects_script_packages() {
        let (mut guest, _) = AotGuest::<App>::new();
        assert_eq!(guest.evaluate(b""), Err(RuntimeError::Guest));
        assert_eq!(guest.evaluate(b"alert(1)\0"), Err(RuntimeError::Guest));
    }
}
