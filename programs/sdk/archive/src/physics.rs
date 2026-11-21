//! The `physics` feature: every runtime `pocket_runtime_create` returns has
//! the `pocket-physics` engine installed, so a plan that requests
//! `ui.physics` is admitted where the profile declares it. Archives built
//! without the feature do not link `pocket-physics`; their runtimes report
//! ops 52..56 unsupported and reject such a plan at boot.
use alloc::boxed::Box;
use pocket_drivers::abi::PocketRuntime;
use pocket_runtime::abi::{self, Handle};

/// Install the engine in a runtime `abi::pocket_runtime_create` returned.
/// A null runtime stays null; a failed install destroys it and returns null.
///
/// # Safety
/// `runtime` is null or a live runtime no other call is using.
pub(crate) unsafe fn install(runtime: *mut PocketRuntime) -> *mut PocketRuntime {
    let Some(handle) = (unsafe { Handle::from_raw(runtime) }) else {
        return runtime;
    };
    let installed = handle.with_runtime(|runtime| {
        runtime.set_physics(Box::new(pocket_physics::Physics::new()))
    });
    if installed.is_err() {
        unsafe { abi::pocket_runtime_destroy(runtime) };
        return core::ptr::null_mut();
    }
    runtime
}
