//! Rust composition helpers for a program whose public entry points use C
//! runtime handles. These helpers share the handle's application instance.

use crate::{
    abi::{PocketProfileFacts, PocketRuntime},
    runtime,
};
use alloc::boxed::Box;
use pocket_runtime::{Guest, OpContext, Profile, Runtime, RuntimeConfig, RuntimeError};

/// Copy an exported `pocket_profile_facts` record into a runtime `Profile`,
/// the conversion `pocket_runtime_create` applies to `config.profile`.
/// `Runtime::new` checks the ranges.
///
/// # Safety
/// `facts` is null or provides its announced readable bytes, and its id and
/// viewport lists are live for the call.
pub unsafe fn profile_from_facts(facts: *const PocketProfileFacts) -> Option<Profile> {
    unsafe { runtime::profile(facts) }
}

/// Construct a runtime from a Rust configuration and return the C handle the
/// `pocket_runtime_*` entry points accept. Release it with
/// `pocket_runtime_destroy`.
pub fn create(config: RuntimeConfig) -> Result<*mut PocketRuntime, RuntimeError> {
    Runtime::new(config).map(runtime::into_handle)
}

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
pub unsafe fn resize_embedded(
    pointer: *mut PocketRuntime,
    logical: [u32; 2],
    physical: [u32; 2],
) -> i32 {
    unsafe {
        runtime::modify(pointer, |runtime| {
            runtime.resize_embedded(logical, physical)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::borrow::Cow;
    use pocket_runtime::{InputClasses, Profile};

    fn config() -> RuntimeConfig {
        RuntimeConfig {
            profile_hash: [7; 32],
            host_abi: pocket_spec::BINDING_GENERATION,
            heap_limit: 64 * 1024,
            frame_buffer_budget: 64,
            profile: Profile {
                id: Cow::Borrowed("fixture"),
                tick_hz: 30,
                viewport: [960, 544],
                logical_viewports: Cow::Borrowed(&[[480, 272], [320, 240]]),
                dynamic_viewport: None,
                auxiliary: Some([320, 240]),
                auxiliary_logical: Cow::Borrowed(&[[160, 120]]),
                density: 2,
                required_inputs: InputClasses::BUTTONS,
            },
        }
    }

    #[test]
    fn rust_configuration_reaches_the_runtime_handle() {
        let handle = create(config()).unwrap();
        unsafe {
            let ops = op_context(handle).unwrap();
            {
                let state = ops.core().unwrap();
                assert_eq!(state.ui.viewport(), (480.0, 272.0));
                assert_eq!(state.ui.tick_rate(), 30);
                assert_eq!(state.ui.raster_density(), 2);
                assert_eq!(state.ui.auxiliary_viewport(), Some((160.0, 120.0)));
            }
            crate::pocket_runtime_destroy(handle);
        }
        let mut dynamic = config();
        dynamic.profile.dynamic_viewport = Some([[320, 240], [640, 480]]);
        let handle = create(dynamic).unwrap();
        unsafe { crate::pocket_runtime_destroy(handle) };
    }

    #[test]
    fn rejected_configurations_are_errors() {
        let mut generation = config();
        generation.host_abi += 1;
        assert!(matches!(
            create(generation),
            Err(RuntimeError::BindingGenerationMismatch)
        ));
        let mut orphan = config();
        orphan.profile.auxiliary = None;
        let mut empty = config();
        empty.profile.logical_viewports = Cow::Borrowed(&[]);
        let mut range = config();
        range.profile.dynamic_viewport = Some([[640, 480], [320, 240]]);
        let mut id = config();
        id.profile.id = Cow::Borrowed("");
        for rejected in [orphan, empty, range, id] {
            assert!(matches!(
                create(rejected),
                Err(RuntimeError::InvalidConfiguration)
            ));
        }
    }
}
