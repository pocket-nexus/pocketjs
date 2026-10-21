use pocket_drivers::*;
use pocket_package::{package::fnv1a64, source::MemorySource};
use pocket_runtime::*;
use std::{cell::RefCell, rc::Rc};

fn config() -> RuntimeConfig {
    let profile_json=br#"{"capabilities":[],"display":{"logicalViewports":[[4,4]],"physicalViewport":[4,4],"presentations":["native"],"rasterDensity":1},"form":"takeover","id":"fixture","platform":"test","tickHz":60}"#.to_vec();
    RuntimeConfig {
        profile_hash: pocket_package::sha256::sha256(&profile_json),
        host_abi: 1,
        tick_hz: 60,
        heap_limit: 64 * 1024,
        frame_buffer_budget: 64,
        profile_json,
    }
}
fn package() -> Vec<u8> {
    let mut identity = Vec::new();
    for value in ["app", "test.app", "App"] {
        identity.extend_from_slice(&(value.len() as u16).to_le_bytes());
        identity.extend_from_slice(value.as_bytes());
    }
    let sections = [
        (1, identity),
        (
            2,
            br#"{"viewport":{"logical":[4,4],"rasterDensity":1},"features":{}}"#.to_vec(),
        ),
        (3, b"test\0".to_vec()),
    ];
    let mut bytes = vec![0; 16 + 40 + 48];
    bytes[0..4].copy_from_slice(b"PCKT");
    bytes[4..8].copy_from_slice(&1u32.to_le_bytes());
    bytes[12..16].copy_from_slice(&1u32.to_le_bytes());
    bytes[16..23].copy_from_slice(b"fixture");
    bytes[32..36].copy_from_slice(&1u32.to_le_bytes());
    bytes[36..40].copy_from_slice(&3u32.to_le_bytes());
    bytes[40..44].copy_from_slice(&56u32.to_le_bytes());
    for (i, (kind, payload)) in sections.into_iter().enumerate() {
        while bytes.len() % 16 != 0 {
            bytes.push(0);
        }
        let offset = bytes.len();
        let entry = 56 + i * 16;
        bytes[entry..entry + 4].copy_from_slice(&(kind as u32).to_le_bytes());
        bytes[entry + 8..entry + 12].copy_from_slice(&(offset as u32).to_le_bytes());
        bytes[entry + 12..entry + 16].copy_from_slice(&(payload.len() as u32).to_le_bytes());
        bytes.extend_from_slice(&payload);
    }
    let hash = fnv1a64(&[&bytes]);
    bytes.extend_from_slice(&hash.to_le_bytes());
    bytes
}
#[derive(Default)]
struct Facts {
    frames: usize,
    shutdowns: usize,
    evaluated: bool,
    flushes: usize,
}
struct TestGuest {
    facts: Rc<RefCell<Facts>>,
    ops: Option<OpContext>,
    fail: bool,
}
impl Guest for TestGuest {
    fn initialize(
        &mut self,
        ops: OpContext,
        env: &GuestEnvironment<'_>,
    ) -> Result<(), RuntimeError> {
        assert_eq!(env.viewport, [4, 4]);
        assert!(env.assets.is_some());
        assert!(ops.supports_op(1));
        self.ops = Some(ops);
        Ok(())
    }
    fn evaluate(&mut self, code: &[u8]) -> Result<(), RuntimeError> {
        assert_eq!(code, b"test\0");
        self.ops
            .as_ref()
            .unwrap()
            .dispatch(1, &[OpArg::Integer(1)])?;
        self.facts.borrow_mut().evaluated = true;
        Ok(())
    }
    fn frame(&mut self, frame: &GuestFrame<'_>) -> Result<(), RuntimeError> {
        assert_eq!(frame.analog, 0x8080);
        self.facts.borrow_mut().frames += 1;
        if self.fail {
            return Err(RuntimeError::Guest);
        }
        self.ops
            .as_ref()
            .unwrap()
            .dispatch(1, &[OpArg::Integer(1)])?;
        Ok(())
    }
    fn shutdown(&mut self) {
        self.facts.borrow_mut().shutdowns += 1;
    }
}
struct Display {
    pixels: [u8; 64],
    facts: Rc<RefCell<Facts>>,
    fail_once: bool,
}
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
    fn acquire(&mut self, region: Rect) -> Result<Target<'_>, DisplayError> {
        Ok(Target::CpuVisible(Surface::new(
            &mut self.pixels,
            region,
            16,
            PixelFormat::Rgba8888,
        )?))
    }
    fn flush(&mut self, _: &[Rect]) -> Result<(), DisplayError> {
        self.facts.borrow_mut().flushes += 1;
        Ok(())
    }
    fn wait(&mut self, _: ()) -> Result<(), DisplayError> {
        if self.fail_once {
            self.fail_once = false;
            Err(DisplayError::Failed)
        } else {
            Ok(())
        }
    }
    fn vsync(&mut self) -> VsyncSource {
        VsyncSource::None
    }
}
fn runtime(facts: Rc<RefCell<Facts>>, fail_guest: bool, fail_display: bool) -> Runtime {
    let mut runtime = Runtime::new(config()).unwrap();
    runtime
        .set_package_source(Box::new(MemorySource(package())))
        .unwrap();
    runtime
        .set_guest(Box::new(TestGuest {
            facts: facts.clone(),
            ops: None,
            fail: fail_guest,
        }))
        .unwrap();
    runtime
        .add_display(
            Display {
                pixels: [0; 64],
                facts,
                fail_once: fail_display,
            },
            RendererId::SOFTWARE,
        )
        .unwrap();
    runtime
}
#[test]
fn guest_callbacks_reenter_dispatch_and_each_tick_runs_one_frame() {
    let facts = Rc::new(RefCell::new(Facts::default()));
    let mut rt = runtime(facts.clone(), false, false);
    let ops = rt.op_context();
    rt.boot().unwrap();
    assert_eq!(facts.borrow().frames, 0);
    assert!(facts.borrow().evaluated);
    assert_eq!(facts.borrow().flushes, 1);
    rt.tick().unwrap();
    rt.tick().unwrap();
    assert_eq!(facts.borrow().frames, 2);
    assert_eq!(facts.borrow().flushes, 3);
    assert!(matches!(rt.boot(), Err(RuntimeError::InvalidState)));
    rt.shutdown().unwrap();
    assert!(!ops.supports_op(1));
    drop(rt);
    assert_eq!(facts.borrow().shutdowns, 1);
}
#[test]
fn terminal_display_failure_allows_next_tick_and_guest_failure_stops_ticks() {
    let facts = Rc::new(RefCell::new(Facts::default()));
    let mut rt = runtime(facts.clone(), false, true);
    assert!(matches!(rt.boot(), Err(RuntimeError::Presentation(_))));
    rt.tick().unwrap();
    assert_eq!(facts.borrow().frames, 1);
    drop(rt);
    assert_eq!(facts.borrow().shutdowns, 1);
    let facts = Rc::new(RefCell::new(Facts::default()));
    let mut rt = runtime(facts.clone(), true, false);
    rt.boot().unwrap();
    assert_eq!(rt.tick(), Err(RuntimeError::Guest));
    assert_eq!(rt.tick(), Err(RuntimeError::InvalidState));
    drop(rt);
    assert_eq!(facts.borrow().shutdowns, 1);
}
#[test]
fn rejects_configuration_and_missing_registration_before_guest_evaluation() {
    let mut bad = config();
    bad.profile_hash[0] ^= 1;
    assert!(matches!(
        Runtime::new(bad),
        Err(RuntimeError::ProfileMismatch)
    ));
    let facts = Rc::new(RefCell::new(Facts::default()));
    let mut rt = Runtime::new(config()).unwrap();
    rt.set_guest(Box::new(TestGuest {
        facts: facts.clone(),
        ops: None,
        fail: false,
    }))
    .unwrap();
    assert_eq!(rt.boot(), Err(RuntimeError::MissingDisplay));
    assert!(!facts.borrow().evaluated);
}
#[test]
fn frame_borrow_rejects_mutation_and_private_services_are_absent() {
    let ops = OpContext::from_ui(pocketjs_core::Ui::new());
    let core = ops.core().unwrap();
    assert_eq!(
        ops.dispatch(1, &[OpArg::Integer(1)]),
        Err(RuntimeError::Busy)
    );
    drop(core);
    assert!(!ops.supports_op(30));
    assert!(!ops.supports_op(44));
    assert!(ops.supports_op(57));
    assert_eq!(
        ops.dispatch(7, &[OpArg::Integer(0), OpArg::Bytes(&[255])]),
        Err(RuntimeError::InvalidArgument)
    );
}

#[test]
fn dropping_with_an_outstanding_read_guard_disables_all_cloned_contexts() {
    let facts = Rc::new(RefCell::new(Facts::default()));
    let mut runtime = runtime(facts.clone(), false, false);
    runtime.boot().unwrap();
    let ops = runtime.op_context();
    let held = ops.core().unwrap();
    drop(runtime);
    assert!(!ops.supports_op(23));
    assert!(!ops.supports_op(1));
    assert_eq!(facts.borrow().shutdowns, 1);
    drop(held);
    assert_eq!(
        ops.dispatch(1, &[OpArg::Integer(1)]),
        Err(RuntimeError::UnsupportedOperation)
    );
}

#[test]
fn auxiliary_density_must_match_the_shared_resource_density() {
    let mut c = config();
    let mut json: serde_json::Value = serde_json::from_slice(&c.profile_json).unwrap();
    json["display"]["auxiliary"] = serde_json::json!({"physicalViewport":[4,4],"logicalViewports":[[4,4]],"rasterDensity":2,"presentations":["native"]});
    c.profile_json = serde_json::to_vec(&json).unwrap();
    c.profile_hash = pocket_package::sha256::sha256(&c.profile_json);
    assert!(matches!(
        Runtime::new(c),
        Err(RuntimeError::InvalidConfiguration)
    ));
}
