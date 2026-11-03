//! `ui.physics` admission across the three entries (package boot, AOT boot,
//! a direct `OpContext` embedding) and three configurations: engine
//! installed, capability requested without an engine, capability not
//! requested. The engine here is a recorder; the `pocket-physics` engine is
//! exercised end to end by `pocket-ui-surface` and the program crates.
use pocket_drivers::*;
use pocket_package::source::MemorySource;
use pocket_runtime::*;
use pocketjs_core::{tree::Tree, Physics, Ui};
use std::{cell::RefCell, rc::Rc};

const PHYSICS_OPS: std::ops::RangeInclusive<u16> = 52..=56;

#[derive(Default)]
struct Calls {
    created: usize,
    steps: usize,
}
struct Recorder(Rc<RefCell<Calls>>);
impl Physics for Recorder {
    fn is_idle(&self) -> bool {
        self.0.borrow().created == 0
    }
    fn step(&mut self, _: f32, _: &mut Tree, _: i32) {
        self.0.borrow_mut().steps += 1;
    }
    fn create(&mut self, _: u32, _: &[f64]) -> i32 {
        self.0.borrow_mut().created += 1;
        7
    }
    fn apply(&mut self, _: &[f64]) {}
    fn destroy(&mut self, _: i32, _: &mut Tree) {}
    fn take_events(&mut self, out: &mut Vec<f64>) {
        out.clear();
    }
    fn has_events(&self) -> bool {
        false
    }
    fn query(&self, _: u32, _: i32, _: f64, _: f64, _: f64, _: f64) -> f64 {
        0.5
    }
}

fn config(capability: bool) -> RuntimeConfig {
    static WITH: [Cow<'static, str>; 1] = [Cow::Borrowed("ui.physics")];
    RuntimeConfig {
        profile_hash: [0x5a; 32],
        host_abi: pocket_spec::BINDING_GENERATION,
        heap_limit: 64 * 1024,
        frame_buffer_budget: 0,
        profile: Profile {
            id: Cow::Borrowed("fixture"),
            cadences: Cow::Borrowed(&[60]),
            viewport: [4, 4],
            logical_viewports: Cow::Borrowed(&[[4, 4]]),
            dynamic_viewport: None,
            presentations: Cow::Borrowed(&[Cow::Borrowed("native")]),
            auxiliary: None,
            auxiliary_logical: Cow::Borrowed(&[]),
            density: 1,
            animation: Cow::Borrowed("composited"),
            capabilities: if capability { Cow::Borrowed(&WITH) } else { Cow::Borrowed(&[]) },
            required_inputs: InputClasses::NONE,
        },
    }
}

fn package(physics: bool) -> Vec<u8> {
    let identity = pocket_package::embedded::identity("app", "test.app", "App").unwrap();
    let plan = format!(
        r#"{{"animation":"composited","profile":{{"tickHz":60}},"viewport":{{"logical":[4,4],"presentation":"native","rasterDensity":1}},"features":{}}}"#,
        if physics { r#"{"ui.physics":true}"# } else { "{}" }
    );
    pocket_package::embedded::encode(pocket_package::embedded::EmbeddedPackage {
        target: "fixture",
        host_abi: pocket_spec::BINDING_GENERATION,
        profile_hash: [0x5a; 32],
        identity: &identity,
        plan: plan.as_bytes(),
        code: b"test",
        pak: &[],
    })
    .unwrap()
}

/// Records whether initialization ran; the test reads ops after boot.
struct NullGuest(Rc<RefCell<bool>>);
impl Guest for NullGuest {
    fn initialize(&mut self, _: OpContext, _: &GuestEnvironment<'_>) -> Result<(), RuntimeError> {
        *self.0.borrow_mut() = true;
        Ok(())
    }
    fn evaluate(&mut self, _: &[u8]) -> Result<(), RuntimeError> {
        Ok(())
    }
    fn frame(&mut self, _: &GuestFrame<'_>) -> Result<(), RuntimeError> {
        Ok(())
    }
    fn shutdown(&mut self) {}
}
struct Gpu;
impl Renderer for Gpu {
    type Submission = ();
    fn descriptor(&self) -> RendererDescriptor {
        RendererDescriptor::new(
            &[PixelFormat::Rgba8888],
            TargetOwnership::DeviceOwned,
            Synchronization::Immediate,
            pocket_spec::DRAW_LIST_VERSION,
            false,
        )
        .unwrap()
    }
    fn render(&mut self, _: &mut FrameInput<'_>) -> Result<(), RenderError> {
        Ok(())
    }
    fn wait(&mut self, _: &()) -> Result<(), RenderError> {
        Ok(())
    }
    fn retire(&mut self, _: ()) {}
}
struct Output;
impl DisplayOutput for Output {
    type Token = ();
    fn descriptor(&self) -> DisplayDescriptor {
        DisplayDescriptor::new(
            DisplayRole::Primary,
            4,
            4,
            PixelFormat::Rgba8888,
            16,
            TargetOwnership::DeviceOwned,
        )
    }
    fn acquire(&mut self, region: Rect) -> Result<Target<'_>, DisplayError> {
        Ok(Target::DeviceOwned(DeviceTarget::new(1, region, PixelFormat::Rgba8888)))
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

/// A configured runtime, with the recorder installed when `calls` is given.
fn runtime(
    capability: bool,
    calls: Option<Rc<RefCell<Calls>>>,
    started: Rc<RefCell<bool>>,
) -> Runtime {
    let mut runtime = Runtime::new(config(capability)).unwrap();
    if let Some(calls) = calls {
        runtime.set_physics(Box::new(Recorder(calls))).unwrap();
    }
    runtime.set_guest(Box::new(NullGuest(started))).unwrap();
    let renderer = runtime.add_renderer(Gpu).unwrap();
    runtime.add_display(Output, renderer).unwrap();
    runtime
}

fn physics_supported(ops: &OpContext) -> [bool; 5] {
    let mut supported = [false; 5];
    for (slot, op) in PHYSICS_OPS.enumerate() {
        supported[slot] = ops.supports_op(op);
    }
    supported
}

/// An installed engine receives the ops and the tick.
fn assert_engine_reached(ops: &OpContext, calls: &Rc<RefCell<Calls>>) {
    assert_eq!(physics_supported(ops), [true; 5]);
    assert_eq!(
        ops.dispatch(52, &[OpArg::Integer(1), OpArg::Bytes(&[])]),
        Ok(OpResult::Integer(7))
    );
    assert_eq!(
        ops.dispatch(56, &[OpArg::Integer(1), OpArg::Integer(7), OpArg::Real(0.0), OpArg::Real(0.0), OpArg::Real(0.0), OpArg::Real(0.0)]),
        Ok(OpResult::Real(0.5))
    );
    assert_eq!(calls.borrow().created, 1);
}

fn assert_unsupported(ops: &OpContext) {
    assert_eq!(physics_supported(ops), [false; 5]);
    assert_eq!(
        ops.dispatch(52, &[OpArg::Integer(1), OpArg::Bytes(&[])]),
        Err(RuntimeError::UnsupportedOperation)
    );
}

// ---- package boot ----------------------------------------------------------

#[test]
fn package_boot_admits_ui_physics_with_an_installed_engine() {
    let calls = Rc::new(RefCell::new(Calls::default()));
    let started = Rc::new(RefCell::new(false));
    let mut rt = runtime(true, Some(calls.clone()), started.clone());
    rt.set_package_source(Box::new(MemorySource(package(true)))).unwrap();
    rt.boot_deferred().unwrap();
    assert!(*started.borrow());
    let ops = rt.op_context();
    assert_engine_reached(&ops, &calls);
    rt.present().unwrap();
    rt.tick().unwrap();
    assert_eq!(calls.borrow().steps, 1);
}

#[test]
fn package_boot_rejects_ui_physics_without_an_engine_before_the_guest_starts() {
    let started = Rc::new(RefCell::new(false));
    // The profile declares the capability; the instance did not compose it.
    let mut rt = runtime(true, None, started.clone());
    rt.set_package_source(Box::new(MemorySource(package(true)))).unwrap();
    match rt.boot_deferred() {
        Err(RuntimeError::Package(pocket_package::source::LoadError::Admission(
            pocket_package::GuestError::NotAdmitted(mismatch),
        ))) => {
            assert_eq!(mismatch.items, pocket_package::admission::item::CAPABILITY);
            assert_eq!(mismatch.capability.as_str(), "ui.physics");
        }
        other => panic!("expected capability admission failure, got {other:?}"),
    }
    assert!(!*started.borrow());
}

#[test]
fn package_boot_without_the_request_leaves_physics_ops_unsupported() {
    for engine in [false, true] {
        let calls = Rc::new(RefCell::new(Calls::default()));
        let started = Rc::new(RefCell::new(false));
        let mut rt = runtime(true, engine.then(|| calls.clone()), started);
        rt.set_package_source(Box::new(MemorySource(package(false)))).unwrap();
        rt.boot_deferred().unwrap();
        assert_unsupported(&rt.op_context());
        rt.present().unwrap();
        rt.tick().unwrap();
        assert_eq!(calls.borrow().created, 0);
    }
}

// ---- AOT boot --------------------------------------------------------------

#[test]
fn aot_boot_admits_ui_physics_with_an_installed_engine() {
    let calls = Rc::new(RefCell::new(Calls::default()));
    let started = Rc::new(RefCell::new(false));
    let mut rt = runtime(true, Some(calls.clone()), started.clone());
    rt.boot_aot_deferred([0x5a; 32], [4, 4], true, 60).unwrap();
    assert!(*started.borrow());
    assert_engine_reached(&rt.op_context(), &calls);
    rt.present().unwrap();
    rt.tick().unwrap();
    assert_eq!(calls.borrow().steps, 1);
}

#[test]
fn aot_boot_rejects_ui_physics_without_an_engine_before_the_guest_starts() {
    let started = Rc::new(RefCell::new(false));
    let mut rt = runtime(true, None, started.clone());
    assert_eq!(
        rt.boot_aot_deferred([0x5a; 32], [4, 4], true, 60),
        Err(RuntimeError::ProfileMismatch)
    );
    assert!(!*started.borrow());
    // Nothing changed: the same instance boots an artifact without physics.
    rt.boot_aot_deferred([0x5a; 32], [4, 4], false, 60).unwrap();
    assert!(*started.borrow());
    assert_unsupported(&rt.op_context());
}

#[test]
fn aot_boot_without_the_request_leaves_physics_ops_unsupported() {
    let calls = Rc::new(RefCell::new(Calls::default()));
    let started = Rc::new(RefCell::new(false));
    let mut rt = runtime(false, Some(calls.clone()), started);
    rt.boot_aot_deferred([0x5a; 32], [4, 4], false, 60).unwrap();
    assert_unsupported(&rt.op_context());
    assert_eq!(calls.borrow().created, 0);
}

// ---- direct OpContext embedding --------------------------------------------

#[test]
fn op_context_enables_physics_with_an_installed_engine() {
    let calls = Rc::new(RefCell::new(Calls::default()));
    let mut ui = Ui::new();
    ui.set_physics(Box::new(Recorder(calls.clone())));
    let ops = OpContext::from_ui(ui);
    ops.set_physics_enabled(true).unwrap();
    assert_engine_reached(&ops, &calls);
    ops.core_mut().unwrap().ui.tick();
    assert_eq!(calls.borrow().steps, 1);
}

#[test]
fn op_context_refuses_physics_without_an_engine() {
    let ops = OpContext::from_ui(Ui::new());
    assert_eq!(
        ops.set_physics_enabled(true),
        Err(RuntimeError::UnsupportedOperation)
    );
    assert_unsupported(&ops);
    // Disabling stays allowed.
    ops.set_physics_enabled(false).unwrap();
}

#[test]
fn op_context_without_the_request_leaves_physics_ops_unsupported() {
    let calls = Rc::new(RefCell::new(Calls::default()));
    let mut ui = Ui::new();
    ui.set_physics(Box::new(Recorder(calls.clone())));
    let ops = OpContext::from_ui(ui);
    assert_unsupported(&ops);
    assert_eq!(calls.borrow().created, 0);
}

#[test]
fn physics_is_installed_only_while_configuring() {
    let started = Rc::new(RefCell::new(false));
    let mut rt = runtime(false, None, started);
    rt.boot_aot_deferred([0x5a; 32], [4, 4], false, 60).unwrap();
    let calls = Rc::new(RefCell::new(Calls::default()));
    assert_eq!(
        rt.set_physics(Box::new(Recorder(calls))),
        Err(RuntimeError::InvalidState)
    );
}
