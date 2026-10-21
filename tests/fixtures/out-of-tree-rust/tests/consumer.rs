mod support;
use pocket_drivers::*;
use pocket_package::source::{LoadedPackage, MemorySource};
use pocket_present::{Coordinator, DisplayId, RendererId};
use pocket_runtime::{
    Guest, GuestEnvironment, GuestFrame, OpArg, OpContext, OpResult, Runtime, RuntimeConfig,
    RuntimeError,
};
use std::{cell::RefCell, rc::Rc};
use support::{Device, Event, Fault, Resources, Shared, HEIGHT, WIDTH};

const PROFILE: &[u8] = br#"{"capabilities":["input.buttons","input.analog.left","input.touch"],"display":{"logicalViewports":[[8,6]],"physicalViewport":[8,6],"presentations":["native"],"rasterDensity":1},"form":"takeover","id":"consumer","platform":"external-test","tickHz":60}"#;
fn config() -> RuntimeConfig {
    RuntimeConfig {
        profile_hash: pocket_package::sha256::sha256(PROFILE),
        host_abi: pocket_spec::BINDING_GENERATION,
        tick_hz: 60,
        heap_limit: 65536,
        frame_buffer_budget: (WIDTH * HEIGHT * 4) as usize,
        profile_json: PROFILE.to_vec(),
    }
}
fn package() -> Vec<u8> {
    let identity =
        pocket_package::embedded::identity("application", "external.consumer", "Consumer").unwrap();
    pocket_package::embedded::encode(pocket_package::embedded::EmbeddedPackage {
        target: "consumer",
        host_abi: pocket_spec::BINDING_GENERATION,
        profile_hash: config().profile_hash,
        identity: &identity,
        plan: br#"{"viewport":{"logical":[8,6],"rasterDensity":1},"features":{}}"#,
        code: b"public-api-fixture",
        pak: &[],
    })
    .unwrap()
}
struct RangeSource {
    bytes: Vec<u8>,
    reads: Rc<RefCell<usize>>,
}
impl PackageSource for RangeSource {
    fn length(&self) -> Result<usize, SourceError> {
        Ok(self.bytes.len())
    }
    fn range(&mut self, offset: usize, output: &mut [u8]) -> Result<usize, SourceError> {
        let bytes = self.bytes.get(offset..).ok_or(SourceError::OutOfBounds)?;
        let count = bytes.len().min(output.len()).min(7);
        output[..count].copy_from_slice(&bytes[..count]);
        *self.reads.borrow_mut() += 1;
        Ok(count)
    }
}
#[derive(Default)]
struct GuestFacts {
    frames: usize,
    shutdowns: usize,
}
struct ScriptGuest {
    facts: Rc<RefCell<GuestFacts>>,
    ops: Option<OpContext>,
}
impl Guest for ScriptGuest {
    fn initialize(
        &mut self,
        ops: OpContext,
        environment: &GuestEnvironment<'_>,
    ) -> Result<(), RuntimeError> {
        assert_eq!(environment.host, "consumer");
        assert_eq!(environment.viewport, [WIDTH, HEIGHT]);
        self.ops = Some(ops);
        Ok(())
    }
    fn evaluate(&mut self, code: &[u8]) -> Result<(), RuntimeError> {
        assert_eq!(code, b"public-api-fixture\0");
        let ops = self.ops.as_ref().unwrap();
        let OpResult::Integer(node) = ops.dispatch(
            pocket_spec::op::CREATE_NODE as u16,
            &[OpArg::Integer(pocket_spec::NodeType::Image as i64)],
        )?
        else {
            panic!("node handle")
        };
        for (property, value) in [
            (pocket_spec::prop::WIDTH, WIDTH),
            (pocket_spec::prop::HEIGHT, HEIGHT),
        ] {
            ops.dispatch(
                pocket_spec::op::SET_PROP as u16,
                &[
                    OpArg::Integer(node),
                    OpArg::Integer(property as i64),
                    OpArg::Real(value as f64),
                ],
            )?;
        }
        let OpResult::Integer(texture) = ops.dispatch(
            pocket_spec::op::UPLOAD_TEXTURE as u16,
            &[
                OpArg::Bytes(&[255, 0, 0, 255]),
                OpArg::Integer(1),
                OpArg::Integer(1),
                OpArg::Integer(pocket_spec::psm::PSM_8888 as i64),
            ],
        )?
        else {
            panic!("texture handle")
        };
        assert!(texture >= 0);
        ops.dispatch(
            pocket_spec::op::SET_IMAGE as u16,
            &[OpArg::Integer(node), OpArg::Integer(texture)],
        )?;
        ops.dispatch(
            pocket_spec::op::INSERT_BEFORE as u16,
            &[
                OpArg::Integer(pocket_spec::ROOT_ID as i64),
                OpArg::Integer(node),
                OpArg::Integer(0),
            ],
        )?;
        Ok(())
    }
    fn frame(&mut self, frame: &GuestFrame<'_>) -> Result<(), RuntimeError> {
        assert_eq!(frame.buttons, pocket_spec::btn::CROSS);
        assert_eq!(frame.analog, 14 << 8 | 212);
        match self.facts.borrow().frames {
            0 => {
                assert_eq!(frame.touches, [200 << 18 | 4 << 9 | 3]);
                assert_ne!(frame.hits, [0]);
            }
            1 => {
                assert_eq!(frame.touches, [0x4000_0000 | 200 << 18]);
                assert_eq!(frame.hits, [0]);
            }
            _ => assert!(
                frame.touches.is_empty(),
                "a repeated cancellation emits no second event"
            ),
        }
        self.facts.borrow_mut().frames += 1;
        Ok(())
    }
    fn shutdown(&mut self) {
        self.facts.borrow_mut().shutdowns += 1;
    }
}
struct Input {
    tick: usize,
}
impl InputSource for Input {
    fn classes(&self) -> InputClasses {
        InputClasses::BUTTONS | InputClasses::AXIS_ABSOLUTE | InputClasses::CONTACT
    }
    fn poll(&mut self, output: &mut InputFrameBuilder) {
        output.buttons |= pocket_spec::btn::CROSS;
        output.axes.extend([
            AxisSample { id: 0, value: 14. },
            AxisSample { id: 1, value: 212. },
        ]);
        if self.tick == 0 {
            output.contacts.push(Contact {
                surface: 0,
                id: 200,
                x: 3.,
                y: 4.,
                cancelled: false,
            });
        } else {
            output.cancelled.push(CancelledContact {
                surface: 0,
                id: 200,
            });
        }
        self.tick += 1;
    }
}
fn runtime(facts: Rc<RefCell<GuestFacts>>, reads: Rc<RefCell<usize>>) -> Runtime {
    let mut runtime = Runtime::new(config()).unwrap();
    runtime
        .set_package_source(Box::new(RangeSource {
            bytes: package(),
            reads,
        }))
        .unwrap();
    runtime
        .set_guest(Box::new(ScriptGuest { facts, ops: None }))
        .unwrap();
    runtime
        .add_input_source(Box::new(Input { tick: 0 }))
        .unwrap();
    runtime
}
struct CpuDisplay {
    pixels: Vec<u8>,
    snapshots: Rc<RefCell<Vec<Vec<u8>>>>,
    pending: bool,
}
impl DisplayOutput for CpuDisplay {
    type Token = ();
    fn descriptor(&self) -> DisplayDescriptor {
        DisplayDescriptor::new(
            DisplayRole::Primary,
            WIDTH,
            HEIGHT,
            PixelFormat::Rgba8888,
            WIDTH as usize * 4,
            TargetOwnership::CpuVisible,
        )
    }
    fn acquire(&mut self, region: Rect) -> Result<Target<'_>, DisplayError> {
        if self.pending {
            return Err(DisplayError::InvalidTarget);
        }
        Ok(Target::CpuVisible(Surface::new(
            &mut self.pixels,
            region,
            WIDTH as usize * 4,
            PixelFormat::Rgba8888,
        )?))
    }
    fn flush(&mut self, _: &[Rect]) -> Result<(), DisplayError> {
        self.snapshots.borrow_mut().push(self.pixels.clone());
        self.pending = true;
        Ok(())
    }
    fn wait(&mut self, _: ()) -> Result<(), DisplayError> {
        self.pending = false;
        Ok(())
    }
    fn vsync(&mut self) -> VsyncSource {
        VsyncSource::None
    }
}
#[test]
fn public_runtime_registers_draws_and_preserves_input_tapes() {
    let facts = Rc::new(RefCell::new(GuestFacts::default()));
    let reads = Rc::new(RefCell::new(0));
    let snapshots = Rc::new(RefCell::new(Vec::new()));
    let mut runtime = runtime(facts.clone(), reads.clone());
    runtime
        .add_display(
            CpuDisplay {
                pixels: vec![0; (WIDTH * HEIGHT * 4) as usize],
                snapshots: snapshots.clone(),
                pending: false,
            },
            RendererId::SOFTWARE,
        )
        .unwrap();
    let ops = runtime.op_context();
    runtime.boot().unwrap();
    for _ in 0..3 {
        runtime.tick().unwrap();
    }
    drop(runtime);
    assert_eq!(facts.borrow().frames, 3);
    assert_eq!(facts.borrow().shutdowns, 1);
    assert!(!ops.supports_op(pocket_spec::op::CREATE_NODE as u16));
    assert!(*reads.borrow() > 1);
    assert_eq!(snapshots.borrow().len(), 4);
    assert!(snapshots
        .borrow()
        .iter()
        .all(|pixels| pixels.chunks_exact(4).all(|p| p == [255, 0, 0, 255])));
}
fn pair() -> (Coordinator, Shared) {
    let shared = Rc::new(RefCell::new(Device::default()));
    let mut coordinator = Coordinator::new(1, 0).unwrap();
    let renderer = coordinator
        .add_renderer(support::Renderer::new(shared.clone()))
        .unwrap();
    for id in 1..=2 {
        coordinator
            .add_display(support::Display::new(shared.clone(), id), renderer)
            .unwrap();
    }
    (coordinator, shared)
}
#[test]
fn two_displays_share_one_upload_and_finish_in_reverse_order() {
    let (mut coordinator, shared) = pair();
    coordinator
        .present(&support::scene(), None, &Resources::new(1, 42))
        .unwrap();
    let state = shared.borrow();
    assert_eq!(state.uploads, 1);
    assert_eq!(state.max_live, 2);
    assert_eq!(
        state
            .events
            .iter()
            .filter_map(|e| if let Event::Retire(id) = e {
                Some(*id)
            } else {
                None
            })
            .collect::<Vec<_>>(),
        [2, 1]
    );
    for target in 1..=2 {
        let at = |event| state.events.iter().position(|e| *e == event).unwrap();
        assert!(at(Event::RenderStop(target)) < at(Event::Flush(target)));
        assert!(at(Event::Flush(target)) < at(Event::DisplayStop(target, true)));
        assert!(at(Event::DisplayStop(target, true)) < at(Event::Retire(target)));
    }
    assert!(state.stopped());
    drop(state);
    assert_eq!(
        coordinator.history_valid(DisplayId::from_raw(0)),
        Some(true)
    );
    drop(coordinator);
    assert!(shared.borrow().released());
    assert_eq!(shared.borrow().freed, [1]);
}
#[test]
fn texture_versions_survive_until_the_last_display_retires() {
    let shared = Rc::new(RefCell::new(Device::default()));
    let mut renderer = support::Renderer::new(shared.clone());
    let mut first = support::Display::new(shared.clone(), 1);
    let mut second = support::Display::new(shared.clone(), 2);
    let mut old = Resources::new(1, 42);
    let a = support::submit(&mut renderer, &mut first, &old);
    let b = support::submit(&mut renderer, &mut second, &old);
    // Driver copied borrowed bytes: caller mutation cannot change queued reads.
    old.pixels.fill(0);
    assert_eq!(shared.borrow().pixels(1), [42, 0, 0, 255]);
    assert!(first.acquire(Rect::new(0, 0, WIDTH, HEIGHT)).is_err());
    assert!(
        first.flush(&[]).is_err(),
        "display cannot read before renderer wait"
    );
    support::finish(&mut renderer, &mut second, b);
    let replacement = Resources::new(2, 99);
    let c = support::submit(&mut renderer, &mut second, &replacement);
    assert_eq!(shared.borrow().uploads, 2);
    assert!(
        shared.borrow().freed.is_empty(),
        "old version is still pinned by display one"
    );
    support::finish(&mut renderer, &mut second, c);
    assert!(shared.borrow().freed.is_empty());
    support::finish(&mut renderer, &mut first, a);
    assert_eq!(shared.borrow().freed, [1]);
    drop(renderer);
    assert_eq!(shared.borrow().freed, [1, 2]);
    assert!(shared.borrow().released());
}
#[test]
fn terminal_failures_invalidate_history_and_allow_full_retry() {
    for fault in [Fault::RenderWait, Fault::Flush, Fault::DisplayWait] {
        let (mut coordinator, shared) = pair();
        shared.borrow_mut().fault = Some(fault);
        assert!(coordinator
            .present(&support::scene(), None, &Resources::new(1, 42))
            .is_err());
        assert!(shared.borrow().stopped());
        let state = shared.borrow();
        if fault == Fault::RenderWait {
            assert!(
                !state.events.contains(&Event::Flush(2)),
                "failed rendering must not reach display"
            );
        } else {
            let stopped = state
                .events
                .iter()
                .position(|e| *e == Event::DisplayStop(2, false))
                .unwrap();
            let retired = state
                .events
                .iter()
                .position(|e| *e == Event::Retire(2))
                .unwrap();
            assert!(
                stopped < retired,
                "even partial transfer failure stops before retirement"
            );
        }
        drop(state);
        for id in 0..2 {
            assert_eq!(
                coordinator.history_valid(DisplayId::from_raw(id)),
                Some(false)
            );
        }
        shared.borrow_mut().fault = None;
        coordinator
            .present(&support::scene(), None, &Resources::new(2, 99))
            .unwrap();
        assert!(shared.borrow().stopped());
        assert_eq!(shared.borrow().freed, [1]);
        drop(coordinator);
        assert!(shared.borrow().released());
    }
}
#[test]
fn runtime_destroy_after_failed_render_or_display_wait_releases_everything() {
    for fault in [Fault::RenderWait, Fault::Flush, Fault::DisplayWait] {
        let facts = Rc::new(RefCell::new(GuestFacts::default()));
        let shared = Rc::new(RefCell::new(Device::default()));
        shared.borrow_mut().fault = Some(fault);
        let mut runtime = runtime(facts.clone(), Rc::new(RefCell::new(0)));
        let renderer = runtime
            .add_renderer(support::Renderer::new(shared.clone()))
            .unwrap();
        for id in 1..=2 {
            runtime
                .add_display(support::Display::new(shared.clone(), id), renderer)
                .unwrap();
        }
        assert!(matches!(runtime.boot(), Err(RuntimeError::Presentation(_))));
        assert!(shared.borrow().stopped());
        assert_eq!(shared.borrow().max_live, 2);
        drop(runtime);
        assert!(shared.borrow().released());
        assert_eq!(facts.borrow().shutdowns, 1);
        let state = shared.borrow();
        let retires: Vec<_> = state
            .events
            .iter()
            .filter_map(|e| {
                if let Event::Retire(id) = e {
                    Some(*id)
                } else {
                    None
                }
            })
            .collect();
        assert_eq!(retires, [2, 1], "each terminal submission retires once");
    }
}
#[test]
fn all_and_short_range_sources_share_package_corpus_admission() {
    let directory = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("corpus");
    let mut cases = 0;
    for item in std::fs::read_dir(directory).unwrap() {
        let path = item.unwrap().path();
        if path.extension().and_then(|v| v.to_str()) != Some("pocket") {
            continue;
        }
        let bytes = std::fs::read(&path).unwrap();
        let expected = path
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("ok-");
        assert_eq!(
            pocket_package::Package::parse(&bytes, false).is_ok(),
            expected,
            "{}",
            path.display()
        );
        let summary = |result: Result<LoadedPackage, _>| {
            result.map(|p| (p.package_hash, p.variant_hash, p.javascript().to_vec()))
        };
        let memory = summary(LoadedPackage::load(
            &mut MemorySource(&bytes),
            "psp",
            1,
            &[0x11; 32],
            bytes.len(),
        ));
        let reads = Rc::new(RefCell::new(0));
        let range = summary(LoadedPackage::load(
            &mut RangeSource {
                bytes: bytes.clone(),
                reads: reads.clone(),
            },
            "psp",
            1,
            &[0x11; 32],
            bytes.len(),
        ));
        assert_eq!(memory, range, "{}", path.display());
        assert!(*reads.borrow() > 0);
        cases += 1;
    }
    assert!(cases >= 24);
}
