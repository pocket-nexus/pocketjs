//! What `pocket_runtime_create` composes for `ui.physics`, driven through the
//! exported symbols with a profile that declares the capability. Shared by
//! the SDK, IDF and SiFli archive tests; each states whether its archive
//! resolves pocket-archive's `physics` feature.
use pocket_archive::{pocket_runtime_create, pocket_runtime_destroy, pocket_runtime_supports_op};
use pocket_drivers::abi::*;
use pocket_drivers::*;
use pocket_runtime::abi::Handle;
use pocket_runtime::pocket_package::{self, source::MemorySource};
use pocket_runtime::{Guest, GuestEnvironment, GuestFrame, OpContext, Runtime, RuntimeError};

const PROFILE_HASH: [u8; 32] = [0x51; 32];

fn package(physics: bool) -> Vec<u8> {
    let plan = format!(
        r#"{{"features":{{"ui.physics":{physics}}},"profile":{{"tickHz":60}},"viewport":{{"logical":[32,24],"presentation":"native","rasterDensity":1}}}}"#
    );
    let identity = pocket_package::embedded::identity("fixture", "dev.fixture", "Fixture").unwrap();
    pocket_package::embedded::encode(pocket_package::embedded::EmbeddedPackage {
        target: "fixture",
        host_abi: pocket_drivers::spec::BINDING_GENERATION,
        profile_hash: PROFILE_HASH,
        identity: &identity,
        plan: plan.as_bytes(),
        code: b"fixture",
        pak: &[],
    })
    .unwrap()
}

struct NullGuest;
impl Guest for NullGuest {
    fn initialize(&mut self, _: OpContext, _: &GuestEnvironment<'_>) -> Result<(), RuntimeError> {
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
            pocket_drivers::spec::DRAW_LIST_VERSION,
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
            32,
            24,
            PixelFormat::Rgba8888,
            128,
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

/// Create through the exported symbol with a profile that declares
/// ui.physics, boot a package, and report the boot result and ops 52..56.
fn boot(physics_plan: bool) -> (Result<(), RuntimeError>, [u32; 5]) {
    static LOGICAL: [u32; 2] = [32, 24];
    let display = PocketProfileDisplay {
        physical: [32, 24],
        logical: LOGICAL.as_ptr(),
        logical_count: 1,
        raster_density: 1,
        ..PocketProfileDisplay::empty()
    };
    let facts = PocketProfileFacts {
        id: b"fixture".as_ptr(),
        id_length: 7,
        tick_hz: 60,
        display: &display,
        capabilities: c"ui.physics".as_ptr().cast(),
        capabilities_length: 11,
        ..PocketProfileFacts::empty()
    };
    let config = PocketRuntimeConfig {
        profile_hash: PROFILE_HASH,
        host_abi: pocket_drivers::spec::BINDING_GENERATION,
        tick_hz: 60,
        heap_limit: 1 << 20,
        frame_buffer_budget: 0,
        profile: &facts,
        ..PocketRuntimeConfig::empty()
    };
    let runtime = unsafe { pocket_runtime_create(&config) };
    assert!(!runtime.is_null());
    let handle = unsafe { Handle::from_raw(runtime) }.unwrap();
    let booted = handle.with_runtime(|runtime: &mut Runtime| {
        runtime.set_package_source(Box::new(MemorySource(package(physics_plan))))?;
        runtime.set_guest(Box::new(NullGuest))?;
        let renderer = runtime.add_renderer(Gpu)?;
        runtime.add_display(Output, renderer)?;
        runtime.boot_deferred()
    });
    let mut supported = [0; 5];
    for (slot, op) in (52..=56).enumerate() {
        supported[slot] = unsafe { pocket_runtime_supports_op(runtime, op) };
    }
    unsafe { pocket_runtime_destroy(runtime) };
    (booted, supported)
}

/// With the engine installed a `ui.physics` plan boots and ops 52..56 are
/// supported; without it the same plan is rejected at admission and the ops
/// stay unsupported. A plan without the request never gets them.
pub fn check(installed: bool) {
    let (booted, supported) = boot(true);
    if installed {
        assert_eq!((booted, supported), (Ok(()), [1; 5]));
    } else {
        assert!(
            matches!(
                booted,
                Err(RuntimeError::Package(pocket_package::source::LoadError::Admission(
                    pocket_package::GuestError::NotAdmitted(mismatch)
                ))) if mismatch.capability.as_str() == "ui.physics"
            ),
            "{booted:?}"
        );
        assert_eq!(supported, [0; 5]);
    }
    assert_eq!(boot(false), (Ok(()), [0; 5]));
}
