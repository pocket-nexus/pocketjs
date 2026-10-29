use pocket_driver_kit::{check_package_admission, Event, Lifecycle, ViolationKind};
use pocket_package::{embedded, source::MemorySource};

#[test]
fn package_sources_share_canonical_acceptance_and_rejection() {
    let identity = embedded::identity("application", "kit.consumer", "Driver kit").unwrap();
    let bytes = embedded::encode(embedded::EmbeddedPackage {
        target: "external-test",
        host_abi: pocket_spec::BINDING_GENERATION,
        profile_hash: [42; 32],
        identity: &identity,
        plan: br#"{"animation":"composited","features":{},"profile":{"tickHz":60},"viewport":{"logical":[4,4],"presentation":"native","rasterDensity":1}}"#,
        code: b"application",
        pak: &[],
    })
    .unwrap();
    for source_bytes in [&bytes[..], &bytes[..bytes.len() - 1]] {
        for hash in [[42; 32], [99; 32]] {
            let host = pocket_package::HostFacts::<&str> {
                binding_generation: pocket_spec::BINDING_GENERATION,
                profile_hash: hash,
                raster_density: 1,
                animation: Some("composited"),
                cadences: &[60],
                logical_viewports: &[[4, 4]],
                dynamic_viewport: None,
                presentations: Some(&["native"]),
                capabilities: &[],
                auxiliary_logical: &[],
            };
            check_package_admission(&mut MemorySource(source_bytes), source_bytes, &host)
                .unwrap();
        }
    }
}

#[test]
fn terminal_error_still_requires_device_stop_and_single_retirement() {
    let mut lifecycle = Lifecycle::new(2);
    lifecycle.observe(Event::Acquire(1)).unwrap();
    lifecycle
        .observe(Event::Render {
            submission: 10,
            buffer: 1,
        })
        .unwrap();
    lifecycle.observe(Event::RenderStopped(10)).unwrap();
    lifecycle
        .observe(Event::RenderWaited {
            submission: 10,
            failed: true,
        })
        .unwrap();
    lifecycle.observe(Event::Retire(10)).unwrap();
    lifecycle.observe(Event::Invalidate(1)).unwrap();
    lifecycle.observe(Event::FrameEnd { failed: true }).unwrap();
    lifecycle.finish().unwrap();
    assert_eq!(
        lifecycle.observe(Event::Retire(10)).unwrap_err().kind,
        ViolationKind::UnknownId
    );
}
