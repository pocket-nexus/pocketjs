use pocket_drivers::Rect;
use pocket_embassy::display::{Frame, Transport};
use pocket_embassy_host_check::fixture::{SCRIPT, program};
use pocket_package::{GuestError, admission::item, source::LoadError};
use pocket_runtime::RuntimeError;
use std::{
    future::{Future, pending},
    task::{Context, Poll, Waker},
};

#[derive(Default)]
struct Screen {
    pending: bool,
    fail: bool,
    frames: Vec<(Vec<u8>, Vec<Rect>)>,
}
impl Transport for Screen {
    type Error = ();
    async fn write(&mut self, frame: Frame<'_>) -> Result<(), ()> {
        self.frames
            .push((frame.pixels.to_vec(), frame.regions.to_vec()));
        if self.pending {
            pending::<()>().await;
        }
        if self.fail { Err(()) } else { Ok(()) }
    }
}
fn ready<T>(future: impl Future<Output = T>) -> T {
    let mut future = std::pin::pin!(future);
    match future
        .as_mut()
        .poll(&mut Context::from_waker(Waker::noop()))
    {
        Poll::Ready(result) => result,
        Poll::Pending => panic!("unexpected wait"),
    }
}
#[test]
fn canonical_runtime_admits_package_samples_input_and_renders() {
    let (mut runtime, mut presenter) = program(SCRIPT, pocket_drivers::spec::BINDING_GENERATION);
    runtime.boot().unwrap();
    assert_eq!(runtime.timing().unwrap().cadence_hz, 30);
    let mut screen = Screen::default();
    ready(presenter.present(&mut screen)).unwrap();
    assert_eq!(&screen.frames[0].0[..2], &0x001fu16.to_le_bytes());
    runtime.tick().unwrap();
    ready(presenter.present(&mut screen)).unwrap();
    assert_eq!(&screen.frames[1].0[..2], &0xf800u16.to_le_bytes());
    let context = runtime.op_context();
    assert_eq!(context.core().unwrap().ui.node_text(3), Some("5:1"));
    runtime.shutdown().unwrap();
    assert!(context.core().is_err());
}
#[test]
fn admission_rejects_wrong_binding_generation_before_javascript() {
    let (mut runtime, _) = program(
        b"throw Error('must not evaluate')",
        pocket_drivers::spec::BINDING_GENERATION + 1,
    );
    let error = runtime.boot().unwrap_err();
    assert!(
        matches!(
            error,
            RuntimeError::Package(LoadError::Admission(GuestError::NotAdmitted(mismatch)))
                if mismatch.items == item::BINDING_GENERATION
        ),
        "{error:?}"
    );
    assert!(!runtime.op_context().core().unwrap().ui.node_exists(2));
}
#[test]
fn cancelled_transfer_repaints_without_replaying_guest() {
    let (mut runtime, mut presenter) = program(SCRIPT, pocket_drivers::spec::BINDING_GENERATION);
    runtime.boot().unwrap();
    let mut screen = Screen {
        pending: true,
        ..Default::default()
    };
    {
        let mut transfer = std::pin::pin!(presenter.present(&mut screen));
        assert!(
            transfer
                .as_mut()
                .poll(&mut Context::from_waker(Waker::noop()))
                .is_pending()
        );
        assert!(runtime.present().is_err());
    }
    screen.pending = false;
    runtime.present().unwrap();
    ready(presenter.present(&mut screen)).unwrap();
    assert_eq!(
        screen.frames.last().unwrap().1,
        vec![Rect::new(0, 0, 24, 16)]
    );
    assert_eq!(
        runtime.op_context().core().unwrap().ui.node_text(3),
        Some("")
    );
}
#[test]
fn failed_transfer_invalidates_coordinator_history() {
    let (mut runtime, mut presenter) = program(SCRIPT, pocket_drivers::spec::BINDING_GENERATION);
    runtime.boot().unwrap();
    let mut screen = Screen::default();
    ready(presenter.present(&mut screen)).unwrap();
    runtime.tick().unwrap();
    screen.fail = true;
    assert!(ready(presenter.present(&mut screen)).is_err());
    screen.fail = false;
    runtime.present().unwrap();
    ready(presenter.present(&mut screen)).unwrap();
    assert_eq!(
        screen.frames.last().unwrap().1,
        vec![Rect::new(0, 0, 24, 16)]
    );
    assert_eq!(
        runtime.op_context().core().unwrap().ui.node_text(3),
        Some("5:1")
    );
}
#[test]
fn interpreter_failure_reaches_runtime_and_stops_future_turns() {
    for code in [b"function {".as_slice(), b"throw Error('probe')"] {
        let (mut runtime, _) = program(code, pocket_drivers::spec::BINDING_GENERATION);
        assert!(matches!(runtime.boot(), Err(RuntimeError::Guest)));
        assert!(runtime.tick().is_err());
    }
}

#[test]
fn panel_reset_expands_an_already_queued_frame() {
    let (mut runtime, mut presenter) = program(SCRIPT, pocket_drivers::spec::BINDING_GENERATION);
    runtime.boot().unwrap();
    let mut screen = Screen::default();
    ready(presenter.present(&mut screen)).unwrap();
    runtime.tick().unwrap();
    presenter.invalidate();
    ready(presenter.present(&mut screen)).unwrap();
    assert_eq!(
        screen.frames.last().unwrap().1,
        vec![Rect::new(0, 0, 24, 16)]
    );
    assert_eq!(
        runtime.op_context().core().unwrap().ui.node_text(3),
        Some("5:1")
    );
}
