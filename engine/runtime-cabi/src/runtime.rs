use crate::{
    adapters::{borrowed, AdapterError, CDisplay, CInputSource, CPackageSource, CRenderer},
    guest::CGuest,
    provider::COpProvider,
};
use alloc::{borrow::Cow, boxed::Box, string::String, vec::Vec};
use core::{
    cell::{Cell, RefCell},
    ffi::c_void,
    mem, ptr,
};
use pocket_drivers::{abi::*, InputClasses};
use pocket_runtime::{
    OpArg, OpContext, OpResult, Profile, RendererId, Runtime, RuntimeConfig, RuntimeError,
};

pub(crate) struct Handle {
    pub runtime: RefCell<Runtime>,
    pub ops: OpContext,
    pub guest_active: Cell<bool>,
    operation_active: Cell<bool>,
    result: RefCell<Vec<u8>>,
}
pub(crate) unsafe fn handle<'a>(pointer: *const PocketRuntime) -> Option<&'a Handle> {
    unsafe { pointer.cast::<Handle>().as_ref() }
}
fn status(error: RuntimeError) -> i32 {
    match error {
        RuntimeError::UnsupportedOperation => POCKET_STATUS_UNSUPPORTED,
        RuntimeError::InvalidArgument
        | RuntimeError::InvalidConfiguration
        | RuntimeError::BindingGenerationMismatch
        | RuntimeError::ProfileMismatch
        | RuntimeError::InvalidState
        | RuntimeError::InvalidAssets
        | RuntimeError::InvalidInput => POCKET_STATUS_INVALID,
        _ => POCKET_STATUS_FAILED,
    }
}
fn invalidate(handle: &Handle) -> Result<(), i32> {
    handle
        .result
        .try_borrow_mut()
        .map(|mut bytes| bytes.clear())
        .map_err(|_| POCKET_STATUS_FAILED)
}
pub(crate) unsafe fn modify(
    pointer: *mut PocketRuntime,
    action: impl FnOnce(&mut Runtime) -> Result<(), RuntimeError>,
) -> i32 {
    let Some(handle) = (unsafe { handle(pointer) }) else {
        return POCKET_STATUS_INVALID;
    };
    if let Err(status) = invalidate(handle) {
        return status;
    }
    if handle.operation_active.get() {
        return POCKET_STATUS_FAILED;
    }
    let Ok(mut runtime) = handle.runtime.try_borrow_mut() else {
        return POCKET_STATUS_FAILED;
    };
    action(&mut runtime)
        .map(|_| POCKET_STATUS_OK)
        .unwrap_or_else(status)
}

/// Copy `count` width/height pairs out of an exported viewport list.
/// # Safety
/// A nonnull pointer provides 2 * count readable, 4-byte aligned u32 values.
unsafe fn pairs(pointer: *const u32, count: usize) -> Option<Cow<'static, [[u32; 2]]>> {
    if count == 0 {
        return Some(Cow::Borrowed(&[]));
    }
    // Exported lists hold a handful of sizes; a larger count is a corrupt record.
    if pointer.is_null() || count > 64 || !(pointer as usize).is_multiple_of(mem::align_of::<u32>())
    {
        return None;
    }
    let words = unsafe { core::slice::from_raw_parts(pointer, count * 2) };
    Some(Cow::Owned(words.as_chunks::<2>().0.to_vec()))
}
/// Split a NUL-terminated name list into runtime-owned names.
/// # Safety
/// A nonnull pointer provides `length` readable bytes.
unsafe fn names(pointer: *const u8, length: usize) -> Option<Cow<'static, [Cow<'static, str>]>> {
    if length == 0 {
        return Some(Cow::Borrowed(&[]));
    }
    let bytes = unsafe { borrowed(pointer, length) }.ok()?;
    let (last, list) = bytes.split_last()?;
    if *last != 0 {
        return None;
    }
    let mut names = Vec::new();
    for name in list.split(|byte| *byte == 0) {
        let name = core::str::from_utf8(name).ok()?;
        if name.is_empty() || names.len() >= 256 {
            return None;
        }
        names.push(Cow::Owned(String::from(name)));
    }
    Some(Cow::Owned(names))
}
/// One exported panel: physical size, logical viewports and raster density.
type Panel = ([u32; 2], Cow<'static, [[u32; 2]]>, u32);
/// # Safety
/// display is null or points at a readable record whose viewport list is live.
unsafe fn display(display: *const PocketProfileDisplay) -> Option<Option<Panel>> {
    if display.is_null() {
        return Some(None);
    }
    let display = unsafe { PocketProfileDisplay::read_prefix(display) }?;
    let logical = unsafe { pairs(display.logical, display.logical_count) }?;
    Some(Some((display.physical, logical, display.raster_density)))
}
/// Copy exported profile facts into runtime-owned storage.
/// # Safety
/// facts is null or provides its announced readable bytes and live lists.
pub(crate) unsafe fn profile(facts: *const PocketProfileFacts) -> Option<Profile> {
    let facts = unsafe { PocketProfileFacts::read_prefix(facts) }?;
    let id = unsafe { borrowed(facts.id, facts.id_length) }.ok()?;
    let id = String::from(core::str::from_utf8(id).ok()?);
    let (viewport, logical_viewports, density) = unsafe { display(facts.display) }??;
    let auxiliary = unsafe { display(facts.auxiliary) }?;
    let dynamic_viewport = if facts.dynamic_viewport.is_null() {
        None
    } else {
        let range = unsafe { PocketProfileRange::read_prefix(facts.dynamic_viewport) }?;
        Some([range.min, range.max])
    };
    let (auxiliary, auxiliary_logical) = match auxiliary {
        Some((physical, logical, aux_density)) => {
            if aux_density != density {
                return None;
            }
            (Some(physical), logical)
        }
        None => (None, Cow::Borrowed(&[][..])),
    };
    // A record without cadences presents at its one rate, tick_hz.
    let cadences = if facts.cadence_count == 0 {
        Cow::Owned(alloc::vec![facts.tick_hz])
    } else if facts.cadence_count > 64 {
        return None;
    } else {
        Cow::Owned(
            unsafe { borrowed(facts.cadences, facts.cadence_count) }
                .ok()?
                .to_vec(),
        )
    };
    let animation = if facts.animation_length == 0 {
        Cow::Borrowed("")
    } else {
        let bytes = unsafe { borrowed(facts.animation, facts.animation_length) }.ok()?;
        Cow::Owned(String::from(core::str::from_utf8(bytes).ok()?))
    };
    Some(Profile {
        id: Cow::Owned(id),
        cadences,
        viewport,
        logical_viewports,
        dynamic_viewport,
        presentations: unsafe { names(facts.presentations, facts.presentations_length) }?,
        auxiliary,
        auxiliary_logical,
        density,
        animation,
        capabilities: unsafe { names(facts.capabilities, facts.capabilities_length) }?,
        required_inputs: InputClasses::from_bits(facts.input_classes),
    })
}
/// Copy the exported profile facts into runtime-owned storage. The config's
/// tick_hz must repeat the facts' tick_hz: a program that passes a literal
/// rate for a profile with another one is refused here, before any package
/// loads.
/// # Safety
/// config and the facts it points to provide their announced readable bytes.
unsafe fn configuration(config: *const PocketRuntimeConfig) -> Option<RuntimeConfig> {
    let config = unsafe { PocketRuntimeConfig::read_prefix(config) }?;
    let profile = unsafe { profile(config.profile) }?;
    let facts = unsafe { PocketProfileFacts::read_prefix(config.profile) }?;
    if config.tick_hz != facts.tick_hz {
        return None;
    }
    Some(RuntimeConfig {
        profile_hash: config.profile_hash,
        host_abi: config.host_abi,
        heap_limit: config.heap_limit,
        frame_buffer_budget: config.frame_buffer_budget,
        profile,
    })
}
/// # Safety
/// config and its borrowed profile facts provide their announced readable bytes.
#[no_mangle]
pub unsafe extern "C" fn pocket_runtime_create(
    config: *const PocketRuntimeConfig,
) -> *mut PocketRuntime {
    let Some(config) = (unsafe { configuration(config) }) else {
        return ptr::null_mut();
    };
    let Ok(runtime) = Runtime::new(config) else {
        return ptr::null_mut();
    };
    into_handle(runtime)
}
/// Move a constructed runtime behind the opaque C handle.
pub(crate) fn into_handle(runtime: Runtime) -> *mut PocketRuntime {
    let ops = runtime.op_context();
    Box::into_raw(Box::new(Handle {
        runtime: RefCell::new(runtime),
        ops,
        guest_active: Cell::new(false),
        operation_active: Cell::new(false),
        result: RefCell::new(Vec::new()),
    }))
    .cast()
}

/// # Safety
/// runtime is live; driver storage and callback validity last through destruction.
#[no_mangle]
pub unsafe extern "C" fn pocket_runtime_set_package_source(
    runtime: *mut PocketRuntime,
    source: *const PocketPackageSourceV1,
    context: *mut c_void,
) -> i32 {
    // Adapter construction is delayed until the runtime borrow is acquired.
    unsafe {
        modify(runtime, |runtime| {
            let source = CPackageSource::new(source, context).map_err(adapter_runtime_error)?;
            runtime.set_package_source(Box::new(source))
        })
    }
}
/// # Safety
/// runtime is live.
#[no_mangle]
pub unsafe extern "C" fn pocket_runtime_set_texture_budget(
    runtime: *mut PocketRuntime,
    bytes: usize,
) -> i32 {
    unsafe { modify(runtime, |runtime| runtime.set_texture_budget(bytes)) }
}
/// # Safety
/// runtime is live; guest/context obey the callback and borrowing contracts.
#[no_mangle]
pub unsafe extern "C" fn pocket_runtime_set_guest(
    pointer: *mut PocketRuntime,
    guest: *const PocketGuestV1,
    context: *mut c_void,
) -> i32 {
    unsafe {
        modify(pointer, |runtime| {
            runtime.set_guest(Box::new(
                CGuest::new(guest, context, pointer).map_err(adapter_runtime_error)?,
            ))
        })
    }
}
/// # Safety
/// runtime is live; renderer/context obey the C driver contract until destruction.
#[no_mangle]
pub unsafe extern "C" fn pocket_runtime_add_renderer(
    pointer: *mut PocketRuntime,
    renderer: *const PocketRendererV1,
    context: *mut c_void,
) -> u32 {
    let Some(handle) = (unsafe { handle(pointer) }) else {
        return POCKET_RENDERER_INVALID;
    };
    if invalidate(handle).is_err() || handle.operation_active.get() {
        return POCKET_RENDERER_INVALID;
    }
    let Ok(mut runtime) = handle.runtime.try_borrow_mut() else {
        return POCKET_RENDERER_INVALID;
    };
    let Ok(renderer) = (unsafe { CRenderer::new(renderer, context) }) else {
        return POCKET_RENDERER_INVALID;
    };
    runtime
        .add_renderer(renderer)
        .map(|id| id.as_raw())
        .unwrap_or(POCKET_RENDERER_INVALID)
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
    unsafe {
        modify(runtime, |runtime| {
            runtime
                .add_display(
                    CDisplay::new(display, context).map_err(adapter_runtime_error)?,
                    RendererId::from_raw(renderer),
                )
                .map(|_| ())
        })
    }
}
/// # Safety
/// runtime is live; source/context obey the C input contract until destruction.
#[no_mangle]
pub unsafe extern "C" fn pocket_runtime_add_input_source(
    runtime: *mut PocketRuntime,
    source: *const PocketInputSourceV1,
    context: *mut c_void,
) -> i32 {
    unsafe {
        modify(runtime, |runtime| {
            runtime.add_input_source(Box::new(
                CInputSource::new(source, context).map_err(adapter_runtime_error)?,
            ))
        })
    }
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
        modify(runtime, |runtime| {
            let provider = COpProvider::new(provider, context, operations, operation_count)
                .map_err(adapter_runtime_error)?;
            runtime.add_provider(Box::new(provider))
        })
    }
}
/// A boot failure names its cause in the host log: the status alone does not
/// tell package admission from guest evaluation or the first present, and
/// the guest's error text covers evaluation only.
fn report_boot_failure(error: RuntimeError) -> RuntimeError {
    let message = alloc::format!("boot failed: {error:?}");
    // SAFETY: the message bytes are live for the call.
    unsafe { pocket_host_log(0, message.as_ptr().cast(), message.len()) };
    error
}
/// # Safety
/// runtime is a live instance on its owning thread.
#[no_mangle]
pub unsafe extern "C" fn pocket_runtime_boot(runtime: *mut PocketRuntime) -> i32 {
    unsafe {
        modify(runtime, |runtime| {
            runtime.boot().map_err(report_boot_failure)
        })
    }
}
/// # Safety
/// runtime is a live instance on its owning thread.
#[no_mangle]
pub unsafe extern "C" fn pocket_runtime_boot_deferred(runtime: *mut PocketRuntime) -> i32 {
    unsafe {
        modify(runtime, |runtime| {
            runtime.boot_deferred().map_err(report_boot_failure)
        })
    }
}
/// # Safety
/// runtime is a live instance on its owning thread.
#[no_mangle]
pub unsafe extern "C" fn pocket_runtime_present(runtime: *mut PocketRuntime) -> i32 {
    unsafe { modify(runtime, Runtime::present) }
}
/// # Safety
/// runtime is a live instance on its owning thread.
#[no_mangle]
pub unsafe extern "C" fn pocket_runtime_complete_presentation(runtime: *mut PocketRuntime) -> i32 {
    unsafe { modify(runtime, Runtime::complete_presentation) }
}
/// # Safety
/// runtime is a live instance on its owning thread.
#[no_mangle]
pub unsafe extern "C" fn pocket_runtime_tick(runtime: *mut PocketRuntime) -> i32 {
    unsafe { modify(runtime, Runtime::tick) }
}
/// # Safety
/// runtime is a live instance on its owning thread; out provides its
/// announced writable prefix.
#[no_mangle]
pub unsafe extern "C" fn pocket_runtime_get_timing(
    runtime: *const PocketRuntime,
    out: *mut PocketRuntimeTiming,
) -> i32 {
    let Some(handle) = (unsafe { handle(runtime) }) else {
        return POCKET_STATUS_INVALID;
    };
    let Ok(runtime) = handle.runtime.try_borrow() else {
        return POCKET_STATUS_FAILED;
    };
    let Some(timing) = runtime.timing() else {
        return POCKET_STATUS_INVALID;
    };
    let value = PocketRuntimeTiming {
        tick_hz: timing.tick_hz,
        cadence_hz: timing.cadence_hz,
        core_ticks: timing.core_ticks(),
        ..PocketRuntimeTiming::empty()
    };
    if unsafe { value.write_prefix(out) } {
        POCKET_STATUS_OK
    } else {
        POCKET_STATUS_INVALID
    }
}
/// # Safety
/// runtime is a live instance on its owning thread.
#[no_mangle]
pub unsafe extern "C" fn pocket_runtime_supports_op(runtime: *const PocketRuntime, op: u16) -> u32 {
    unsafe { handle(runtime) }
        .map(|handle| u32::from(handle.ops.supports_op(op)))
        .unwrap_or(0)
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
    let Some(handle) = (unsafe { handle(runtime) }) else {
        return POCKET_STATUS_INVALID;
    };
    if let Err(status) = invalidate(handle) {
        return status;
    }
    if handle.operation_active.get() || handle.guest_active.get() {
        return POCKET_STATUS_FAILED;
    }
    let bytes = match unsafe { crate::adapters::borrowed(pixels, length) } {
        Ok(bytes) => bytes,
        Err(error) => return error.status(),
    };
    match handle.ops.core_mut() {
        Ok(mut core) => {
            if core
                .ui
                .update_texture_rect(texture, x, y, width, height, bytes)
            {
                POCKET_STATUS_OK
            } else {
                POCKET_STATUS_INVALID
            }
        }
        Err(error) => status(error),
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
    let Some(handle) = (unsafe { handle(runtime) }) else {
        return POCKET_STATUS_INVALID;
    };
    if let Err(status) = invalidate(handle) {
        return status;
    }
    if !unsafe { PocketResult::empty().write_prefix(out) } {
        return POCKET_STATUS_INVALID;
    }
    // Runtime holds a mutable borrow during callbacks. Only guest callbacks
    // may reenter dispatch; render/input/display callbacks cannot mutate Ui.
    if handle.operation_active.get()
        || !handle.guest_active.get() && handle.runtime.try_borrow().is_err()
    {
        return POCKET_STATUS_FAILED;
    }
    let arguments = match unsafe { arguments(args, length) } {
        Ok(args) => args,
        Err(error) => return error.status(),
    };
    struct OperationGuard<'a>(&'a Cell<bool>);
    impl Drop for OperationGuard<'_> {
        fn drop(&mut self) {
            self.0.set(false);
        }
    }
    handle.operation_active.set(true);
    let _operation = OperationGuard(&handle.operation_active);
    let result = match handle.ops.dispatch(op, &arguments) {
        Ok(result) => result,
        Err(error) => return status(error),
    };
    let mut output = PocketResult::empty();
    match result {
        OpResult::None => output.tag = POCKET_RESULT_NONE,
        OpResult::Integer(value) => {
            output.tag = POCKET_RESULT_I64;
            output.integer = value;
        }
        OpResult::Real(value) => {
            output.tag = POCKET_RESULT_F64;
            output.real = value;
        }
        OpResult::Bytes(bytes) => {
            let Ok(mut storage) = handle.result.try_borrow_mut() else {
                return POCKET_STATUS_FAILED;
            };
            *storage = bytes;
            output.tag = POCKET_RESULT_BYTES;
            output.bytes = storage.as_ptr();
            output.byte_length = storage.len();
        }
    }
    if unsafe { output.write_prefix(out) } {
        POCKET_STATUS_OK
    } else {
        POCKET_STATUS_INVALID
    }
}
/// Decode the canonical extensible UI argument records for native embedders.
///
/// # Safety
/// The record span and every referenced payload remain readable for the
/// returned lifetime, with no concurrent mutation.
pub unsafe fn arguments<'a>(
    pointer: *const c_void,
    length: usize,
) -> Result<Vec<OpArg<'a>>, AdapterError> {
    if length == 0 {
        return Ok(Vec::new());
    }
    if pointer.is_null()
        || length > isize::MAX as usize
        || (pointer as usize).checked_add(length).is_none()
    {
        return Err(AdapterError::Invalid);
    }
    let mut offset = 0usize;
    let mut args = Vec::new();
    while offset < length {
        if length - offset < mem::size_of::<usize>()
            || !(pointer as usize)
                .checked_add(offset)
                .is_some_and(|value| value.is_multiple_of(mem::align_of::<PocketOpArg>()))
        {
            return Err(AdapterError::Invalid);
        }
        let item = unsafe { pointer.cast::<u8>().add(offset).cast::<PocketOpArg>() };
        let size = unsafe { item.cast::<usize>().read_unaligned() };
        if size < mem::size_of::<usize>()
            || size > length - offset
            || !size.is_multiple_of(mem::align_of::<PocketOpArg>())
        {
            return Err(AdapterError::Invalid);
        }
        let raw = unsafe { PocketOpArg::read_prefix(item) }.ok_or(AdapterError::Invalid)?;
        let arg = match raw.tag {
            POCKET_ARG_INTEGER
                if size >= mem::offset_of!(PocketOpArg, integer) + mem::size_of::<i64>() =>
            {
                OpArg::Integer(raw.integer)
            }
            POCKET_ARG_REAL
                if size >= mem::offset_of!(PocketOpArg, real) + mem::size_of::<f64>() =>
            {
                OpArg::Real(raw.real)
            }
            POCKET_ARG_BYTES
                if size >= mem::offset_of!(PocketOpArg, byte_length) + mem::size_of::<usize>() =>
            {
                OpArg::Bytes(unsafe { borrowed(raw.bytes, raw.byte_length) }?)
            }
            _ => return Err(AdapterError::Invalid),
        };
        args.push(arg);
        offset += size;
    }
    Ok(args)
}
/// # Safety
/// runtime was returned by create and has not been destroyed. Reentrant
/// destruction is rejected; the caller can destroy after the active call ends.
#[no_mangle]
pub unsafe extern "C" fn pocket_runtime_destroy(pointer: *mut PocketRuntime) {
    let Some(handle) = (unsafe { handle(pointer) }) else {
        return;
    };
    if invalidate(handle).is_err() || handle.operation_active.get() {
        return;
    }
    {
        let Ok(mut runtime) = handle.runtime.try_borrow_mut() else {
            return;
        };
        let _ = runtime.shutdown();
    }
    unsafe {
        drop(Box::from_raw(pointer.cast::<Handle>()));
    }
}
fn adapter_runtime_error(error: AdapterError) -> RuntimeError {
    match error {
        AdapterError::Unsupported => RuntimeError::UnsupportedOperation,
        AdapterError::Invalid => RuntimeError::InvalidArgument,
        AdapterError::Failed => RuntimeError::InvalidState,
    }
}
