//! Rust composition helpers for a program whose public entry points use C
//! runtime handles. These helpers share the handle's application instance.

use crate::{abi::PocketRuntime, runtime};
use alloc::boxed::Box;
use pocket_runtime::{Guest, OpContext, RuntimeError};

/// Register a Rust guest in the same instance used by the C driver tables.
///
/// # Safety
/// `pointer` is a live runtime on its owning thread. Calls on it do not overlap.
pub unsafe fn set_guest(pointer: *mut PocketRuntime, guest: Box<dyn Guest>) -> i32 {
    unsafe { runtime::modify(pointer, |runtime| runtime.set_guest(guest)) }
}

/// # Safety
/// `pointer` is live on its owning thread; calls on it do not overlap.
pub unsafe fn set_native_asset_loading(pointer: *mut PocketRuntime, enabled: bool) -> i32 {
    unsafe { runtime::modify(pointer, |runtime| runtime.set_native_asset_loading(enabled)) }
}

/// Get an operation context for native guest bindings and private host hooks.
/// Clones become inactive when the runtime shuts down; a held core guard must
/// be released before a runtime call that needs the core.
///
/// # Safety
/// `pointer` is a live runtime on its owning thread. Calls on it do not overlap.
pub unsafe fn op_context(pointer: *mut PocketRuntime) -> Result<OpContext, RuntimeError> {
    let handle = unsafe { runtime::handle(pointer) }.ok_or(RuntimeError::InvalidArgument)?;
    Ok(handle.ops.clone())
}

/// # Safety
/// `pointer` is live on its owning thread; calls on it do not overlap.
pub unsafe fn boot_deferred(pointer: *mut PocketRuntime) -> i32 {
    unsafe { runtime::modify(pointer, pocket_runtime::Runtime::boot_deferred) }
}
/// # Safety
/// `pointer` is live on its owning thread; calls on it do not overlap.
pub unsafe fn advance(pointer: *mut PocketRuntime) -> i32 {
    unsafe { runtime::modify(pointer, pocket_runtime::Runtime::advance) }
}
/// # Safety
/// `pointer` is live on its owning thread; calls on it do not overlap.
pub unsafe fn advance_with_core_ticks(pointer: *mut PocketRuntime, ticks: u32) -> i32 {
    unsafe { runtime::modify(pointer, |runtime| runtime.advance_with_core_ticks(ticks)) }
}
/// # Safety
/// `pointer` is live on its owning thread; calls on it do not overlap.
pub unsafe fn present(pointer: *mut PocketRuntime) -> i32 {
    unsafe { runtime::modify(pointer, pocket_runtime::Runtime::present) }
}
/// # Safety
/// `pointer` is live on its owning thread; calls on it do not overlap.
pub unsafe fn collect(pointer: *mut PocketRuntime) -> i32 {
    unsafe { runtime::modify(pointer, pocket_runtime::Runtime::collect) }
}
/// # Safety
/// `pointer` is live on its owning thread; calls on it do not overlap.
pub unsafe fn set_package_source(
    pointer: *mut PocketRuntime,
    source: Box<dyn pocket_drivers::PackageSource>,
) -> i32 {
    unsafe { runtime::modify(pointer, |runtime| runtime.set_package_source(source)) }
}
/// # Safety
/// `pointer` is live on its owning thread; calls on it do not overlap.
pub unsafe fn add_input_source(
    pointer: *mut PocketRuntime,
    source: Box<dyn pocket_drivers::InputSource>,
) -> i32 {
    unsafe { runtime::modify(pointer, |runtime| runtime.add_input_source(source)) }
}
/// # Safety
/// `pointer` is live on its owning thread; calls on it do not overlap. The
/// renderer obeys the same lifetime contract as a standalone Rust runtime.
pub unsafe fn add_renderer<R: pocket_drivers::Renderer + 'static>(
    pointer: *mut PocketRuntime,
    renderer: R,
) -> Result<pocket_runtime::RendererId, i32>
where
    R::Submission: 'static,
{
    let mut result = None;
    let status = unsafe {
        runtime::modify(pointer, |runtime| {
            result = Some(runtime.add_renderer(renderer)?);
            Ok(())
        })
    };
    if status == 0 {
        Ok(result.unwrap())
    } else {
        Err(status)
    }
}
/// # Safety
/// `pointer` is live on its owning thread; calls on it do not overlap. The
/// display obeys the same lifetime contract as a standalone Rust runtime.
pub unsafe fn add_display<D: pocket_drivers::DisplayOutput + 'static>(
    pointer: *mut PocketRuntime,
    display: D,
    renderer: pocket_runtime::RendererId,
) -> i32
where
    D::Token: 'static,
{
    unsafe {
        runtime::modify(pointer, |runtime| {
            runtime.add_display(display, renderer).map(|_| ())
        })
    }
}

/// # Safety
/// `pointer` is live on its owning thread; calls on it do not overlap. The
/// overlay submits only to the selected display's current native device.
pub unsafe fn present_with_overlay(
    pointer: *mut PocketRuntime,
    overlay: impl FnMut(pocket_runtime::DisplayId),
) -> i32 {
    unsafe { runtime::modify(pointer, |runtime| runtime.present_with_overlay(overlay)) }
}

/// # Safety
/// `pointer` is live on its owning thread; calls on it do not overlap.
pub unsafe fn skip_presentation(pointer: *mut PocketRuntime) -> i32 {
    unsafe { runtime::modify(pointer, pocket_runtime::Runtime::skip_presentation) }
}

/// # Safety
/// `pointer` is live on its owning thread; calls on it do not overlap.
pub unsafe fn allow_embedded_viewport_changes(pointer: *mut PocketRuntime) -> i32 {
    unsafe {
        runtime::modify(
            pointer,
            pocket_runtime::Runtime::allow_embedded_viewport_changes,
        )
    }
}

/// # Safety
/// `pointer` is live on its owning thread; calls on it do not overlap. The
/// program prepared the display descriptors and restores them on failure.
pub unsafe fn resize_embedded_presentation(pointer: *mut PocketRuntime, physical: [u32; 2]) -> i32 {
    unsafe {
        runtime::modify(pointer, |runtime| {
            runtime.resize_embedded_presentation(physical)
        })
    }
}

/// # Safety
/// `pointer` is live on its owning thread; calls on it do not overlap. The
/// program prepared the display storage and restores it on failure.
pub unsafe fn resize_embedded(pointer: *mut PocketRuntime, logical: [u32; 2], physical: [u32; 2]) -> i32 {
    unsafe { runtime::modify(pointer, |runtime| runtime.resize_embedded(logical, physical)) }
}
