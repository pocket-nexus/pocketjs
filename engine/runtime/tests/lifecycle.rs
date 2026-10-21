use pocket_drivers::*;
use pocket_package::source::MemorySource;
use pocket_runtime::*;
use std::{cell::RefCell, rc::Rc};

fn config() -> RuntimeConfig {
    let profile_json=br#"{"capabilities":[],"display":{"logicalViewports":[[4,4]],"physicalViewport":[4,4],"presentations":["native"],"rasterDensity":1},"form":"takeover","id":"fixture","platform":"test","tickHz":60}"#.to_vec();
    RuntimeConfig {
        profile_hash: pocket_package::sha256::sha256(&profile_json),
        host_abi: pocket_spec::BINDING_GENERATION,
        tick_hz: 60,
        heap_limit: 64 * 1024,
        frame_buffer_budget: 64,
        profile_json,
    }
}
fn package() -> Vec<u8> {
    package_for(config().profile_hash)
}
fn package_for(profile_hash: [u8; 32]) -> Vec<u8> {
    package_for_generation(profile_hash, pocket_spec::BINDING_GENERATION)
}
fn package_for_generation(profile_hash: [u8; 32], generation: u32) -> Vec<u8> {
    let identity = pocket_package::embedded::identity("app", "test.app", "App").unwrap();
    pocket_package::embedded::encode(pocket_package::embedded::EmbeddedPackage {
        target: "fixture",
        host_abi: generation,
        profile_hash,
        identity: &identity,
        plan: br#"{"viewport":{"logical":[4,4],"rasterDensity":1},"features":{}}"#,
        code: b"test",
        pak: &[],
    })
    .unwrap()
}
#[derive(Default)]
struct Facts {
    initializations: usize,
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
        self.facts.borrow_mut().initializations += 1;
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

#[test]
fn native_scene_embedding_separates_advancement_from_terminal_presentation() {
    let facts = Rc::new(RefCell::new(Facts::default()));
    let mut rt = runtime(facts.clone(), false, true);
    assert_eq!(rt.present(), Err(RuntimeError::InvalidState));
    rt.boot_deferred().unwrap();
    assert!(facts.borrow().evaluated);
    assert_eq!(facts.borrow().flushes, 0);
    assert_eq!(rt.advance(), Err(RuntimeError::InvalidState));
    assert!(matches!(rt.present(), Err(RuntimeError::Presentation(_))));
    rt.present().unwrap(); // retry the initial output without a guest turn
    assert_eq!(facts.borrow().frames, 0);
    rt.advance().unwrap();
    assert_eq!(facts.borrow().frames, 1);
    assert_eq!(facts.borrow().flushes, 2);
    assert_eq!(rt.advance(), Err(RuntimeError::InvalidState));
    assert_eq!(rt.tick(), Err(RuntimeError::InvalidState));
    rt.present().unwrap();
    rt.tick().unwrap();
    assert_eq!(facts.borrow().frames, 2);
    assert_eq!(facts.borrow().flushes, 4);
    rt.advance().unwrap();
    rt.shutdown().unwrap(); // no GPU work was started by advance
    assert_eq!(rt.present(), Err(RuntimeError::InvalidState));
    assert_eq!(facts.borrow().shutdowns, 1);
}

#[test]
fn embedded_resize_requires_opt_in_and_checks_budget_before_changing_ui() {
    use std::cell::Cell;
    struct Resizable {
        size: Rc<Cell<[u32; 2]>>,
        pixels: Vec<u8>,
    }
    impl DisplayOutput for Resizable {
        type Token = ();
        fn vsync(&mut self) -> VsyncSource {
            VsyncSource::None
        }
        fn descriptor(&self) -> DisplayDescriptor {
            let [w, h] = self.size.get();
            DisplayDescriptor::new(
                DisplayRole::Primary,
                w,
                h,
                PixelFormat::Rgba8888,
                w as usize * 4,
                TargetOwnership::CpuVisible,
            )
        }
        fn acquire(&mut self, region: Rect) -> Result<Target<'_>, DisplayError> {
            let [w, h] = self.size.get();
            self.pixels.resize(w as usize * h as usize * 4, 0);
            Ok(Target::CpuVisible(Surface::new(
                &mut self.pixels,
                region,
                w as usize * 4,
                PixelFormat::Rgba8888,
            )?))
        }
        fn flush(&mut self, _: &[Rect]) -> Result<(), DisplayError> {
            Ok(())
        }
        fn wait(&mut self, _: ()) -> Result<(), DisplayError> {
            Ok(())
        }
    }
    let facts = Rc::new(RefCell::new(Facts::default()));
    let mut fixed = runtime(facts.clone(), false, false);
    fixed.boot().unwrap();
    assert_eq!(
        fixed.allow_embedded_viewport_changes(),
        Err(RuntimeError::InvalidState)
    );
    assert_eq!(
        fixed.resize_embedded([2, 2], [4, 4]),
        Err(RuntimeError::InvalidState)
    );
    let mut rt = Runtime::new(config()).unwrap();
    rt.allow_embedded_viewport_changes().unwrap();
    rt.set_guest(Box::new(TestGuest {
        facts: facts.clone(),
        ops: None,
        fail: false,
    }))
    .unwrap();
    rt.set_package_source(Box::new(MemorySource(package())))
        .unwrap();
    let size = Rc::new(Cell::new([4, 4]));
    rt.add_display(
        Resizable {
            size: size.clone(),
            pixels: vec![],
        },
        RendererId::SOFTWARE,
    )
    .unwrap();
    rt.boot().unwrap();
    let ops = rt.op_context();
    size.set([8, 8]);
    assert!(matches!(
        rt.resize_embedded([8, 8], [8, 8]),
        Err(RuntimeError::Presentation(
            pocket_present::PresentError::BudgetExceeded
        ))
    ));
    assert_eq!(ops.core().unwrap().ui.viewport(), (4., 4.));
    size.set([4, 4]);
    rt.resize_embedded([2, 2], [4, 4]).unwrap();
    assert_eq!(ops.core().unwrap().ui.viewport(), (2., 2.));
    rt.present().unwrap();
    assert_eq!(
        rt.advance_with_core_ticks(0),
        Err(RuntimeError::InvalidArgument)
    );
    assert_eq!(
        rt.advance_with_core_ticks(61),
        Err(RuntimeError::InvalidArgument)
    );
    rt.advance_with_core_ticks(30).unwrap();
    assert_eq!(facts.borrow().frames, 1);
    rt.present().unwrap();
}

#[test]
fn profile_auxiliary_surface_has_guest_metadata_without_a_package_declaration() {
    struct AuxDisplay(Display);
    impl DisplayOutput for AuxDisplay {
        type Token = ();
        fn descriptor(&self) -> DisplayDescriptor {
            let mut descriptor = self.0.descriptor();
            descriptor.role = DisplayRole::Auxiliary;
            descriptor
        }
        fn acquire(&mut self, region: Rect) -> Result<Target<'_>, DisplayError> {
            self.0.acquire(region)
        }
        fn flush(&mut self, damage: &[Rect]) -> Result<(), DisplayError> {
            self.0.flush(damage)
        }
        fn wait(&mut self, token: ()) -> Result<(), DisplayError> {
            self.0.wait(token)
        }
        fn vsync(&mut self) -> VsyncSource {
            VsyncSource::None
        }
    }
    struct AuxGuest;
    impl Guest for AuxGuest {
        fn initialize(
            &mut self,
            ops: OpContext,
            env: &GuestEnvironment<'_>,
        ) -> Result<(), RuntimeError> {
            assert_eq!(env.auxiliary_viewport, Some([4, 4]));
            assert!(env.auxiliary_root > 0);
            assert!(ops.supports_op(45));
            assert_eq!(ops.core()?.ui.auxiliary_surface_root(), env.auxiliary_root);
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
    let mut cfg = config();
    let mut profile: serde_json::Value = serde_json::from_slice(&cfg.profile_json).unwrap();
    profile["display"]["auxiliary"] = serde_json::json!({"physicalViewport": [4,4], "logicalViewports": [[4,4]], "rasterDensity": 1});
    cfg.profile_json = serde_json::to_vec(&profile).unwrap();
    cfg.profile_hash = pocket_package::sha256::sha256(&cfg.profile_json);
    cfg.frame_buffer_budget = 128;
    let package = package_for(cfg.profile_hash);
    let mut rt = Runtime::new(cfg).unwrap();
    rt.set_guest(Box::new(AuxGuest)).unwrap();
    rt.set_package_source(Box::new(MemorySource(package)))
        .unwrap();
    let facts = Rc::new(RefCell::new(Facts::default()));
    rt.add_display(
        Display {
            pixels: [0; 64],
            facts: facts.clone(),
            fail_once: false,
        },
        RendererId::SOFTWARE,
    )
    .unwrap();
    rt.add_display(
        AuxDisplay(Display {
            pixels: [0; 64],
            facts: facts.clone(),
            fail_once: false,
        }),
        RendererId::SOFTWARE,
    )
    .unwrap();
    rt.boot_deferred().unwrap();
    assert_eq!(facts.borrow().flushes, 0);
    rt.skip_presentation().unwrap();
    rt.advance().unwrap();
    rt.present().unwrap();
    assert_eq!(facts.borrow().flushes, 2);
}

#[test]
fn gpu_resize_preserves_fractional_logical_viewport_and_rejects_invalid_targets() {
    use std::cell::Cell;
    type RenderedFrame = ((f32, f32), Rect);
    struct Gpu(Rc<RefCell<Vec<RenderedFrame>>>);
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
        fn render(&mut self, frame: &mut FrameInput<'_>) -> Result<(), RenderError> {
            let Target::DeviceOwned(target) = &frame.target else {
                panic!("GPU target required")
            };
            self.0
                .borrow_mut()
                .push((frame.resources.viewport(), target.region));
            Ok(())
        }
        fn wait(&mut self, _: &()) -> Result<(), RenderError> {
            Ok(())
        }
        fn retire(&mut self, _: ()) {}
    }
    struct Output(Rc<Cell<[u32; 2]>>, DisplayRole);
    impl DisplayOutput for Output {
        type Token = ();
        fn descriptor(&self) -> DisplayDescriptor {
            let [w, h] = self.0.get();
            DisplayDescriptor::new(
                self.1,
                w,
                h,
                PixelFormat::Rgba8888,
                w as usize * 4,
                TargetOwnership::DeviceOwned,
            )
        }
        fn acquire(&mut self, region: Rect) -> Result<Target<'_>, DisplayError> {
            Ok(Target::DeviceOwned(DeviceTarget::new(
                1,
                region,
                PixelFormat::Rgba8888,
            )))
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
    let facts = Rc::new(RefCell::new(Facts::default()));
    let mut rt = Runtime::new(config()).unwrap();
    assert_eq!(
        rt.resize_embedded_gpu([3.5, 2.25], [7, 5]),
        Err(RuntimeError::InvalidState)
    );
    rt.allow_embedded_viewport_changes().unwrap();
    rt.set_guest(Box::new(TestGuest {
        facts: facts.clone(),
        ops: None,
        fail: false,
    }))
    .unwrap();
    rt.set_package_source(Box::new(MemorySource(package())))
        .unwrap();
    let size = Rc::new(Cell::new([4, 4]));
    let frames = Rc::new(RefCell::new(Vec::new()));
    let renderer = rt.add_renderer(Gpu(frames.clone())).unwrap();
    rt.add_display(Output(size.clone(), DisplayRole::Primary), renderer)
        .unwrap();
    rt.boot().unwrap();
    let ops = rt.op_context();
    for logical in [
        [f32::NAN, 1.],
        [1., f32::INFINITY],
        [0., 1.],
        [-1., 1.],
        [32001., 1.],
    ] {
        assert_eq!(
            rt.resize_embedded_gpu(logical, [7, 5]),
            Err(RuntimeError::InvalidArgument)
        );
    }
    assert_eq!(
        rt.resize_embedded_gpu([3.5, 2.25], [0, 5]),
        Err(RuntimeError::InvalidArgument)
    );
    assert!(matches!(
        rt.resize_embedded_gpu([3.5, 2.25], [7, 5]),
        Err(RuntimeError::Presentation(_))
    ));
    assert_eq!(ops.core().unwrap().ui.viewport(), (4., 4.));
    size.set([7, 5]);
    let borrow = ops.core().unwrap();
    assert_eq!(
        rt.resize_embedded_gpu([3.5, 2.25], [7, 5]),
        Err(RuntimeError::Busy)
    );
    drop(borrow);
    rt.resize_embedded_gpu([3.5, 2.25], [7, 5]).unwrap();
    assert_eq!(ops.core().unwrap().ui.viewport(), (3.5, 2.25));
    rt.tick().unwrap();
    assert_eq!(
        frames.borrow().last(),
        Some(&((3.5, 2.25), Rect::new(0, 0, 7, 5)))
    );
    size.set([1, 1]);
    rt.resize_embedded_gpu([0.5, 0.5], [1, 1]).unwrap();
    rt.tick().unwrap();
    assert_eq!(
        frames.borrow().last(),
        Some(&((1.0, 1.0), Rect::new(0, 0, 1, 1)))
    );
    let mut cpu = runtime(facts, false, false);
    cpu.allow_embedded_viewport_changes().unwrap();
    cpu.boot().unwrap();
    assert_eq!(
        cpu.resize_embedded_gpu([3.5, 2.25], [4, 4]),
        Err(RuntimeError::InvalidArgument)
    );

    // Auxiliary GPU resources retain their logical viewport at density two.
    // Its scale takes priority over the primary GPU's optional integer mapping.
    for (aux_extent, admitted) in [(8, true), (4, true), (5, false)] {
        let mut cfg = config();
        let mut profile: serde_json::Value = serde_json::from_slice(&cfg.profile_json).unwrap();
        profile["display"]["physicalViewport"] = serde_json::json!([8, 8]);
        profile["display"]["rasterDensity"] = serde_json::json!(2);
        profile["display"]["auxiliary"] = serde_json::json!({
            "physicalViewport":[aux_extent,aux_extent], "logicalViewports":[[4,4]],
            "rasterDensity":2, "presentations":["integer-fit"]
        });
        cfg.profile_json = serde_json::to_vec(&profile).unwrap();
        cfg.profile_hash = pocket_package::sha256::sha256(&cfg.profile_json);
        cfg.frame_buffer_budget = 0;
        let identity = pocket_package::embedded::identity("app", "test.app", "App").unwrap();
        let bytes = pocket_package::embedded::encode(pocket_package::embedded::EmbeddedPackage {
            target: "fixture",
            host_abi: pocket_spec::BINDING_GENERATION,
            profile_hash: cfg.profile_hash,
            identity: &identity,
            plan: br#"{"viewport":{"logical":[4,4],"rasterDensity":2},"features":{}}"#,
            code: b"test",
            pak: &[],
        })
        .unwrap();
        let observed = Rc::new(RefCell::new(Vec::new()));
        let facts = Rc::new(RefCell::new(Facts::default()));
        let mut runtime = Runtime::new(cfg).unwrap();
        runtime
            .set_guest(Box::new(TestGuest {
                facts: facts.clone(),
                ops: None,
                fail: false,
            }))
            .unwrap();
        runtime
            .set_package_source(Box::new(MemorySource(bytes)))
            .unwrap();
        let renderer = runtime.add_renderer(Gpu(observed.clone())).unwrap();
        runtime
            .add_display(
                Output(Rc::new(Cell::new([8, 8])), DisplayRole::Primary),
                renderer,
            )
            .unwrap();
        runtime
            .add_display(
                Output(
                    Rc::new(Cell::new([aux_extent, aux_extent])),
                    DisplayRole::Auxiliary,
                ),
                renderer,
            )
            .unwrap();
        if admitted {
            runtime.boot().unwrap();
            assert_eq!(
                *observed.borrow(),
                vec![
                    ((4., 4.), Rect::new(0, 0, 8, 8)),
                    ((4., 4.), Rect::new(0, 0, aux_extent, aux_extent)),
                ]
            );
        } else {
            assert_eq!(runtime.boot(), Err(RuntimeError::ProfileMismatch));
            assert_eq!(facts.borrow().initializations, 0);
        }
    }
}

#[test]
fn profile_hash_mismatch_precedes_guest_initialization_and_allows_source_replacement() {
    let facts = Rc::new(RefCell::new(Facts::default()));
    let mut rt = runtime(facts.clone(), false, false);
    rt.set_package_source(Box::new(MemorySource(package_for([0x55; 32]))))
        .unwrap();
    assert!(matches!(
        rt.boot(),
        Err(RuntimeError::Package(
            pocket_package::source::LoadError::Admission(
                pocket_package::GuestError::ProfileHashMismatch
            )
        ))
    ));
    assert_eq!(facts.borrow().initializations, 0);
    assert!(!facts.borrow().evaluated);
    assert_eq!(facts.borrow().flushes, 0);
    rt.set_package_source(Box::new(MemorySource(package())))
        .unwrap();
    rt.boot().unwrap();
    assert_eq!(facts.borrow().initializations, 1);
}

#[test]
fn profile_orientations_dynamic_ranges_and_cpu_targets_are_admitted_before_guest() {
    struct Probe(Rc<RefCell<Vec<[u32; 2]>>>);
    impl Guest for Probe {
        fn initialize(
            &mut self,
            _: OpContext,
            env: &GuestEnvironment<'_>,
        ) -> Result<(), RuntimeError> {
            self.0.borrow_mut().push(env.viewport);
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
    struct Output([u32; 2]);
    impl DisplayOutput for Output {
        type Token = ();
        fn descriptor(&self) -> DisplayDescriptor {
            DisplayDescriptor::new(
                DisplayRole::Primary,
                self.0[0],
                self.0[1],
                PixelFormat::Rgba8888,
                self.0[0] as usize * 4,
                TargetOwnership::CpuVisible,
            )
        }
        fn acquire(&mut self, _: Rect) -> Result<Target<'_>, DisplayError> {
            unreachable!()
        }
        fn flush(&mut self, _: &[Rect]) -> Result<(), DisplayError> {
            unreachable!()
        }
        fn wait(&mut self, _: ()) -> Result<(), DisplayError> {
            unreachable!()
        }
        fn vsync(&mut self) -> VsyncSource {
            VsyncSource::None
        }
    }
    let cases = [
        // The panel and the selected declared viewport turn together.
        (false, false, [4, 2], [8, 4], true),
        // A fixed CPU output cannot replace the profile panel with an arbitrary size.
        (false, false, [4, 2], [4, 2], false),
        // A native embedding explicitly owns the final host-side scaling step.
        (false, true, [4, 2], [4, 2], true),
        // A dynamic viewport need not be the profile's default viewport.
        (true, false, [3, 3], [6, 6], true),
        (true, false, [5, 3], [10, 6], false),
        // A dynamic CPU target still matches the density promised by the profile.
        (true, false, [3, 3], [3, 3], false),
        (true, true, [5, 3], [5, 3], false),
    ];
    for (dynamic, embedding, logical, physical, admitted) in cases {
        let mut cfg = config();
        let mut profile: serde_json::Value = serde_json::from_slice(&cfg.profile_json).unwrap();
        profile["display"]["physicalViewport"] = serde_json::json!([4, 8]);
        profile["display"]["logicalViewports"] = serde_json::json!([[2, 4], [4, 2]]);
        profile["display"]["rasterDensity"] = serde_json::json!(2);
        if dynamic {
            profile["form"] = serde_json::json!("window");
            profile["display"]["dynamicViewport"] = serde_json::json!({"min":[2,2],"max":[4,4]});
        }
        cfg.profile_json = serde_json::to_vec(&profile).unwrap();
        cfg.profile_hash = pocket_package::sha256::sha256(&cfg.profile_json);
        cfg.frame_buffer_budget = 1024;
        let identity = pocket_package::embedded::identity("app", "test.app", "App").unwrap();
        let plan = serde_json::to_vec(
            &serde_json::json!({"viewport":{"logical":logical,"rasterDensity":2},"features":{}}),
        )
        .unwrap();
        let package = pocket_package::embedded::encode(pocket_package::embedded::EmbeddedPackage {
            target: "fixture",
            host_abi: pocket_spec::BINDING_GENERATION,
            profile_hash: cfg.profile_hash,
            identity: &identity,
            plan: &plan,
            code: b"test",
            pak: &[],
        })
        .unwrap();
        let observed = Rc::new(RefCell::new(Vec::new()));
        let mut runtime = Runtime::new(cfg).unwrap();
        runtime
            .set_guest(Box::new(Probe(observed.clone())))
            .unwrap();
        runtime
            .set_package_source(Box::new(MemorySource(package)))
            .unwrap();
        runtime
            .add_display(Output(physical), RendererId::SOFTWARE)
            .unwrap();
        if embedding {
            runtime.allow_embedded_viewport_changes().unwrap();
        }
        let result = runtime.boot_deferred();
        if admitted {
            result.unwrap();
            assert_eq!(*observed.borrow(), vec![logical]);
        } else {
            assert_eq!(result, Err(RuntimeError::ProfileMismatch));
            assert!(observed.borrow().is_empty());
        }
    }
}

#[test]
fn runtime_configuration_requires_the_generated_binding_generation() {
    for generation in
        (0..pocket_spec::BINDING_GENERATION).chain([pocket_spec::BINDING_GENERATION + 1, u32::MAX])
    {
        let mut config = config();
        config.host_abi = generation;
        assert!(matches!(
            Runtime::new(config),
            Err(RuntimeError::BindingGenerationMismatch)
        ));
    }
    assert!(Runtime::new(config()).is_ok());
}

#[test]
fn old_packages_are_rejected_before_guest_initialization_and_can_be_replaced() {
    use pocket_package::source::LoadError;
    use pocket_package::{GuestError, PackageError};
    let mut rejected = vec![(
        include_bytes!("fixtures/bad-v1.pocket").to_vec(),
        GuestError::Package(PackageError::BadVersion),
    )];
    rejected.extend((1..pocket_spec::BINDING_GENERATION).map(|generation| {
        (
            package_for_generation(config().profile_hash, generation),
            GuestError::HostAbiMismatch,
        )
    }));
    for (bytes, expected) in rejected {
        let facts = Rc::new(RefCell::new(Facts::default()));
        let mut runtime = runtime(facts.clone(), false, false);
        runtime
            .set_package_source(Box::new(MemorySource(bytes)))
            .unwrap();
        assert_eq!(
            runtime.boot(),
            Err(RuntimeError::Package(LoadError::Admission(expected)))
        );
        assert_eq!(facts.borrow().initializations, 0);
        assert!(!facts.borrow().evaluated);
        assert_eq!(facts.borrow().flushes, 0);
        runtime
            .set_package_source(Box::new(MemorySource(package())))
            .unwrap();
        runtime.boot().unwrap();
        assert_eq!(facts.borrow().initializations, 1);
        assert!(facts.borrow().evaluated);
        assert_eq!(facts.borrow().flushes, 1);
    }
}

#[test]
fn current_package_does_not_admit_under_a_legacy_expected_generation() {
    for expected in 1..pocket_spec::BINDING_GENERATION {
        assert!(matches!(
            pocket_package::select_guest(
                &package(),
                "fixture",
                expected,
                &config().profile_hash,
                false
            ),
            Err(pocket_package::GuestError::HostAbiMismatch)
        ));
    }
}
