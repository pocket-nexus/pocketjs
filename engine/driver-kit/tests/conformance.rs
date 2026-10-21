use pocket_driver_kit::{
    check_input, check_package_admission, check_package_source, Event::*, Lifecycle,
    SourceViolation, ViolationKind,
};
use pocket_drivers::*;
use pocket_package::source::MemorySource;

fn verify(events: &[pocket_driver_kit::Event]) -> Result<(), ViolationKind> {
    let mut audit = Lifecycle::new(16);
    for event in events {
        audit.observe(*event).map_err(|e| e.kind)?;
    }
    audit.finish().map_err(|e| e.kind)
}
#[test]
fn shared_versions_survive_reverse_completion_and_retirement() {
    assert_eq!(
        verify(&[
            Acquire(1),
            Render {
                submission: 11,
                buffer: 1
            },
            UseResource {
                submission: 11,
                resource: 9
            },
            Acquire(2),
            Render {
                submission: 12,
                buffer: 2
            },
            UseResource {
                submission: 12,
                resource: 9
            },
            RenderStopped(12),
            RenderWaited {
                submission: 12,
                failed: false
            },
            Flush {
                transfer: 22,
                submission: 12,
                buffer: 2
            },
            RenderStopped(11),
            RenderWaited {
                submission: 11,
                failed: false
            },
            Flush {
                transfer: 21,
                submission: 11,
                buffer: 1
            },
            DisplayStopped(22),
            DisplayWaited {
                transfer: 22,
                failed: false
            },
            Retire(12),
            DisplayStopped(21),
            DisplayWaited {
                transfer: 21,
                failed: false
            },
            Retire(11),
            ReleaseResource(9),
            FrameEnd { failed: false },
            Destroy,
        ]),
        Ok(())
    );
}
#[test]
fn broken_driver_sequences_are_rejected_at_the_boundary() {
    let start = [
        Acquire(1),
        Render {
            submission: 1,
            buffer: 1,
        },
        UseResource {
            submission: 1,
            resource: 1,
        },
    ];
    for (extra, wanted) in [
        (
            RenderWaited {
                submission: 1,
                failed: false,
            },
            ViolationKind::WaitBeforeStop,
        ),
        (
            RenderWaited {
                submission: 1,
                failed: true,
            },
            ViolationKind::WaitBeforeStop,
        ),
        (
            Flush {
                transfer: 1,
                submission: 1,
                buffer: 1,
            },
            ViolationKind::FlushBeforeRenderWait,
        ),
        (Acquire(1), ViolationKind::BufferBusy),
        (Retire(1), ViolationKind::RetireBeforeStop),
        (ReleaseResource(1), ViolationKind::ResourceStillReferenced),
        (Destroy, ViolationKind::PendingWork),
        (FrameEnd { failed: false }, ViolationKind::PendingWork),
    ] {
        let mut trace = start.to_vec();
        trace.push(extra);
        assert_eq!(verify(&trace), Err(wanted));
    }
    let mut trace = start.to_vec();
    trace.extend([
        RenderStopped(1),
        RenderWaited {
            submission: 1,
            failed: false,
        },
        Flush {
            transfer: 1,
            submission: 1,
            buffer: 1,
        },
    ]);
    let mut early = trace.clone();
    early.push(DisplayWaited {
        transfer: 1,
        failed: true,
    });
    assert_eq!(verify(&early), Err(ViolationKind::WaitBeforeStop));
    trace.push(Retire(1));
    assert_eq!(verify(&trace), Err(ViolationKind::RetireBeforeStop));
}
#[test]
fn terminal_failures_drain_invalidate_and_report_failure() {
    let mut trace = vec![
        Acquire(1),
        Render {
            submission: 1,
            buffer: 1,
        },
        RenderStopped(1),
        RenderWaited {
            submission: 1,
            failed: false,
        },
        Flush {
            transfer: 1,
            submission: 1,
            buffer: 1,
        },
        DisplayStopped(1),
        DisplayWaited {
            transfer: 1,
            failed: true,
        },
        Retire(1),
    ];
    let mut missing = trace.clone();
    missing.push(FrameEnd { failed: true });
    assert_eq!(verify(&missing), Err(ViolationKind::MissingInvalidation));
    trace.push(Invalidate(1));
    let mut unreported = trace.clone();
    unreported.push(FrameEnd { failed: false });
    assert_eq!(verify(&unreported), Err(ViolationKind::FailureNotReported));
    assert_eq!(verify(&trace), Err(ViolationKind::MissingFrameEnd));
    trace.push(FrameEnd { failed: true });
    assert_eq!(verify(&trace), Ok(()));
    assert_eq!(
        verify(&[
            Acquire(1),
            Render {
                submission: 1,
                buffer: 1
            },
            RenderStopped(1),
            RenderWaited {
                submission: 1,
                failed: true
            },
            Retire(1),
            Destroy
        ]),
        Ok(())
    );
}
#[test]
fn bounded_audit_never_drops_overflow_or_first_failure() {
    let mut audit = Lifecycle::new(1);
    audit.observe(Acquire(1)).unwrap();
    let err = audit.observe(Acquire(2)).unwrap_err();
    assert_eq!(err.kind, ViolationKind::Capacity);
    assert_eq!(audit.observe(Destroy), Err(err));
    assert_eq!(audit.finish(), Err(err));
}
struct Short<'a>(&'a [u8]);
impl PackageSource for Short<'_> {
    fn length(&self) -> Result<usize, SourceError> {
        Ok(self.0.len())
    }
    fn range(&mut self, offset: usize, out: &mut [u8]) -> Result<usize, SourceError> {
        let rest = self.0.get(offset..).ok_or(SourceError::OutOfBounds)?;
        let n = rest.len().min(out.len()).min(3);
        out[..n].copy_from_slice(&rest[..n]);
        Ok(n)
    }
}
#[test]
fn real_sources_share_canonical_admission_and_reject_overreported_reads() {
    let identity = pocket_package::embedded::identity("test", "test.app", "Test").unwrap();
    let bytes = pocket_package::embedded::encode(pocket_package::embedded::EmbeddedPackage {
        target: "kit",
        host_abi: pocket_spec::BINDING_GENERATION,
        profile_hash: [7; 32],
        identity: &identity,
        plan: b"{}",
        code: b"test",
        pak: &[],
    })
    .unwrap();
    for payload in [&bytes[..], &bytes[..bytes.len() - 1]] {
        check_package_admission(
            &mut MemorySource(payload),
            payload,
            "kit",
            pocket_spec::BINDING_GENERATION,
            &[7; 32],
        )
        .unwrap();
        check_package_admission(
            &mut Short(payload),
            payload,
            "kit",
            pocket_spec::BINDING_GENERATION,
            &[7; 32],
        )
        .unwrap();
        check_package_admission(
            &mut Short(payload),
            payload,
            "kit",
            pocket_spec::BINDING_GENERATION,
            &[8; 32],
        )
        .unwrap();
    }
    struct Bad;
    impl PackageSource for Bad {
        fn length(&self) -> Result<usize, SourceError> {
            Ok(3)
        }
        fn range(&mut self, _: usize, out: &mut [u8]) -> Result<usize, SourceError> {
            Ok(out.len() + 1)
        }
    }
    assert_eq!(
        check_package_source(&mut Bad, b"123"),
        Err(SourceViolation::RangeCount)
    );
}
struct Input {
    tick: usize,
    overwrite: bool,
    classes: InputClasses,
}
impl InputSource for Input {
    fn classes(&self) -> InputClasses {
        self.classes
    }
    fn poll(&mut self, out: &mut InputFrameBuilder) {
        if self.overwrite {
            out.clear()
        };
        out.buttons |= pocket_spec::btn::CROSS;
        out.axes.push(AxisSample {
            id: 0,
            value: 128.0,
        });
        if self.tick == 0 {
            out.contacts.push(Contact {
                surface: 0,
                id: 4,
                x: 2.0,
                y: 3.0,
                cancelled: false,
            })
        } else {
            out.cancelled.push(CancelledContact { surface: 0, id: 4 })
        };
        self.tick += 1;
    }
}
#[test]
fn input_replay_checks_appends_classes_units_and_cancellation() {
    let classes = InputClasses::BUTTONS | InputClasses::AXIS_ABSOLUTE | InputClasses::CONTACT;
    check_input(
        &mut Input {
            tick: 0,
            overwrite: false,
            classes,
        },
        2,
        |tick, frame| {
            frame.buttons == pocket_spec::btn::CROSS
                && frame.axes
                    == [AxisSample {
                        id: 0,
                        value: 128.0,
                    }]
                && if tick == 0 {
                    frame.contacts.len() == 1 && frame.cancelled.is_empty()
                } else {
                    frame.contacts.is_empty()
                        && frame.cancelled == [CancelledContact { surface: 0, id: 4 }]
                }
        },
    )
    .unwrap();
    assert_eq!(
        check_input(
            &mut Input {
                tick: 0,
                overwrite: true,
                classes
            },
            1,
            |_, _| true
        ),
        Err(SourceViolation::InputOverwrite)
    );
    assert_eq!(
        check_input(
            &mut Input {
                tick: 0,
                overwrite: false,
                classes: InputClasses::NONE
            },
            1,
            |_, _| true
        ),
        Err(SourceViolation::InputClasses)
    );
}

#[test]
fn real_coordinator_uses_extracted_delayed_device_and_drains_each_fault() {
    use pocket_driver_kit::test_device::{
        self as device, Device, Display, Fault, Renderer, Resources,
    };
    use std::{cell::RefCell, rc::Rc};
    for fault in [
        None,
        Some(Fault::RenderWait),
        Some(Fault::Flush),
        Some(Fault::DisplayWait),
    ] {
        let shared = Rc::new(RefCell::new(Device::default()));
        shared.borrow_mut().fault = fault;
        let mut coordinator = pocket_present::Coordinator::new(1, 1024).unwrap();
        let renderer = coordinator
            .add_renderer(Renderer::new(shared.clone()))
            .unwrap();
        coordinator
            .add_display(Display::new(shared.clone(), 1), renderer)
            .unwrap();
        coordinator
            .add_display(Display::new(shared.clone(), 2), renderer)
            .unwrap();
        let result = coordinator.present(&device::scene(), None, &Resources::new(1, 200));
        assert_eq!(result.is_err(), fault.is_some());
        assert!(shared.borrow().stopped());
        drop(coordinator);
        assert!(shared.borrow().released());
        assert!(shared.borrow().max_live >= 2);
    }
}

#[test]
fn software_renderer_matches_external_pixel_oracle_with_padding_and_unaligned_rgb565() {
    struct Empty;
    impl RenderResources for Empty {
        fn raster_revision(&self) -> u64 {
            0
        }
        fn viewport(&self) -> (f32, f32) {
            (2.0, 2.0)
        }
        fn texture(&self, _: i32) -> Option<TexView<'_>> {
            None
        }
        fn font_atlas(&self, _: u8) -> Option<FontView<'_>> {
            None
        }
    }
    let mut list = DrawList::new();
    list.words = vec![pocket_spec::draw_op::RECT, 0, 2 | 2 << 16, 0xff0000ff];
    let mut renderer = pocket_raster::RasterRenderer::new(1).unwrap();
    pocket_driver_kit::check_cpu_frame(
        &mut renderer,
        &list,
        &Empty,
        Rect::new(0, 0, 2, 2),
        PixelFormat::Rgb565,
        6,
        &[0, 248, 0, 248, 0, 248, 0, 248],
    )
    .unwrap();
    assert_eq!(
        pocket_driver_kit::check_cpu_frame(
            &mut renderer,
            &list,
            &Empty,
            Rect::new(0, 0, 2, 2),
            PixelFormat::Rgb565,
            6,
            &[0; 8]
        ),
        Err(pocket_driver_kit::PixelViolation::Pixels)
    );
}
