//! The exported `pocket_runtime_*` symbols: one `#[no_mangle]` definition
//! each, forwarding to the bodies in `pocket_runtime::abi`.
use core::ffi::c_void;
use pocket_drivers::abi::*;
use pocket_runtime::{abi, RuntimeError};

/// A boot failure names its cause in the host log: the status alone does not
/// tell package admission from guest evaluation or the first present, and
/// the guest's error text covers evaluation only.
fn report_boot_failure(error: &RuntimeError) {
    let message = alloc::format!("boot failed: {error:?}");
    // SAFETY: the message bytes are live for the call.
    unsafe { pocket_host_log(0, message.as_ptr().cast(), message.len()) };
}

/// # Safety
/// config and its borrowed profile facts provide their announced readable bytes.
#[no_mangle]
pub unsafe extern "C" fn pocket_runtime_create(
    config: *const PocketRuntimeConfig,
) -> *mut PocketRuntime {
    let runtime = unsafe { abi::pocket_runtime_create(config) };
    let Some(handle) = (unsafe { abi::Handle::from_raw(runtime) }) else {
        return runtime;
    };
    // The archive's features choose what a new instance holds before the C
    // caller registers its own drivers.
    let composed = handle.with_runtime(|runtime| {
        #[cfg(feature = "software-renderer")]
        crate::raster::install_software_renderer(runtime)?;
        let _ = runtime;
        Ok(())
    });
    if composed.is_err() {
        unsafe { abi::pocket_runtime_destroy(runtime) };
        return core::ptr::null_mut();
    }
    #[cfg(feature = "physics")]
    let runtime = unsafe { crate::physics::install(runtime) };
    runtime
}
/// # Safety
/// runtime is live; driver storage and callback validity last through destruction.
#[no_mangle]
pub unsafe extern "C" fn pocket_runtime_set_package_source(
    runtime: *mut PocketRuntime,
    source: *const PocketPackageSourceV1,
    context: *mut c_void,
) -> i32 {
    unsafe { abi::pocket_runtime_set_package_source(runtime, source, context) }
}
/// # Safety
/// runtime is live.
#[no_mangle]
pub unsafe extern "C" fn pocket_runtime_set_texture_budget(
    runtime: *mut PocketRuntime,
    bytes: usize,
) -> i32 {
    unsafe { abi::pocket_runtime_set_texture_budget(runtime, bytes) }
}
/// # Safety
/// runtime is live; guest/context obey the callback and borrowing contracts.
#[no_mangle]
pub unsafe extern "C" fn pocket_runtime_set_guest(
    runtime: *mut PocketRuntime,
    guest: *const PocketGuestV1,
    context: *mut c_void,
) -> i32 {
    unsafe { abi::pocket_runtime_set_guest(runtime, guest, context) }
}
/// # Safety
/// runtime is live; renderer/context obey the C driver contract until destruction.
#[no_mangle]
pub unsafe extern "C" fn pocket_runtime_add_renderer(
    runtime: *mut PocketRuntime,
    renderer: *const PocketRendererV1,
    context: *mut c_void,
) -> u32 {
    unsafe { abi::pocket_runtime_add_renderer(runtime, renderer, context) }
}
/// # Safety
/// runtime is live; display/context obey the C driver contract until destruction.
#[no_mangle]
pub unsafe extern "C" fn pocket_runtime_add_display(
    runtime: *mut PocketRuntime,
    display: *const PocketDisplayOutputV1,
    context: *mut c_void,
    renderer: u32,
) -> i32 {
    unsafe { abi::pocket_runtime_add_display(runtime, display, context, renderer) }
}
/// # Safety
/// runtime is live; source/context obey the C input contract until destruction.
#[no_mangle]
pub unsafe extern "C" fn pocket_runtime_add_input_source(
    runtime: *mut PocketRuntime,
    source: *const PocketInputSourceV1,
    context: *mut c_void,
) -> i32 {
    unsafe { abi::pocket_runtime_add_input_source(runtime, source, context) }
}
/// # Safety
/// runtime is live. The provider context and callback last through destruction;
/// operations supplies operation_count readable u16 values for this call.
#[no_mangle]
pub unsafe extern "C" fn pocket_runtime_add_op_provider(
    runtime: *mut PocketRuntime,
    provider: *const PocketOpProviderV1,
    context: *mut c_void,
    operations: *const u16,
    operation_count: usize,
) -> i32 {
    unsafe {
        abi::pocket_runtime_add_op_provider(runtime, provider, context, operations, operation_count)
    }
}
/// # Safety
/// runtime is a live instance on its owning thread.
#[no_mangle]
pub unsafe extern "C" fn pocket_runtime_boot(runtime: *mut PocketRuntime) -> i32 {
    unsafe { abi::pocket_runtime_boot(runtime, report_boot_failure) }
}
/// # Safety
/// runtime is a live instance on its owning thread.
#[no_mangle]
pub unsafe extern "C" fn pocket_runtime_boot_deferred(runtime: *mut PocketRuntime) -> i32 {
    unsafe { abi::pocket_runtime_boot_deferred(runtime, report_boot_failure) }
}
/// # Safety
/// runtime is a live instance on its owning thread.
#[no_mangle]
pub unsafe extern "C" fn pocket_runtime_present(runtime: *mut PocketRuntime) -> i32 {
    unsafe { abi::pocket_runtime_present(runtime) }
}
/// # Safety
/// runtime is a live instance on its owning thread.
#[no_mangle]
pub unsafe extern "C" fn pocket_runtime_complete_presentation(runtime: *mut PocketRuntime) -> i32 {
    unsafe { abi::pocket_runtime_complete_presentation(runtime) }
}
/// # Safety
/// runtime is a live instance on its owning thread.
#[no_mangle]
pub unsafe extern "C" fn pocket_runtime_tick(runtime: *mut PocketRuntime) -> i32 {
    unsafe { abi::pocket_runtime_tick(runtime) }
}
/// # Safety
/// runtime is a live instance on its owning thread; out provides its
/// announced writable prefix.
#[no_mangle]
pub unsafe extern "C" fn pocket_runtime_get_timing(
    runtime: *const PocketRuntime,
    out: *mut PocketRuntimeTiming,
) -> i32 {
    unsafe { abi::pocket_runtime_get_timing(runtime, out) }
}
/// # Safety
/// runtime is a live instance on its owning thread.
#[no_mangle]
pub unsafe extern "C" fn pocket_runtime_supports_op(runtime: *const PocketRuntime, op: u16) -> u32 {
    unsafe { abi::pocket_runtime_supports_op(runtime, op) }
}
/// # Safety
/// runtime is live and no guest or driver callback is running; pixels
/// supplies length readable bytes.
#[no_mangle]
pub unsafe extern "C" fn pocket_runtime_update_texture(
    runtime: *mut PocketRuntime,
    texture: i32,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
    pixels: *const u8,
    length: usize,
) -> i32 {
    unsafe {
        abi::pocket_runtime_update_texture(runtime, texture, x, y, width, height, pixels, length)
    }
}
/// # Safety
/// runtime is live. args supplies length readable bytes of aligned extensible
/// argument records and borrowed payloads; out supplies its writable prefix.
#[no_mangle]
pub unsafe extern "C" fn pocket_runtime_op(
    runtime: *mut PocketRuntime,
    op: u16,
    args: *const c_void,
    length: usize,
    out: *mut PocketResult,
) -> i32 {
    unsafe { abi::pocket_runtime_op(runtime, op, args, length, out) }
}
/// # Safety
/// runtime was returned by create and has not been destroyed. Reentrant
/// destruction is rejected; the caller can destroy after the active call ends.
#[no_mangle]
pub unsafe extern "C" fn pocket_runtime_destroy(runtime: *mut PocketRuntime) {
    unsafe { abi::pocket_runtime_destroy(runtime) }
}
