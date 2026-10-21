use crate::{
    adapters::{borrowed, AdapterError, CDisplay, CInputSource, CPackageSource, CRenderer},
    guest::CGuest,
    provider::COpProvider,
};
use alloc::{boxed::Box, vec::Vec};
use core::{
    cell::{Cell, RefCell},
    ffi::c_void,
    mem, ptr,
};
use pocket_drivers::abi::*;
use pocket_runtime::{
    OpArg, OpContext, OpResult, RendererId, Runtime, RuntimeConfig, RuntimeError,
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

/// # Safety
/// config and its borrowed profile data provide their announced readable bytes.
#[no_mangle]
pub unsafe extern "C" fn pocket_runtime_create(
    config: *const PocketRuntimeConfig,
) -> *mut PocketRuntime {
    let Some(config) = (unsafe { PocketRuntimeConfig::read_prefix(config) }) else {
        return ptr::null_mut();
    };
    let Ok(profile_json) = (unsafe { borrowed(config.profile_json, config.profile_json_length) })
    else {
        return ptr::null_mut();
    };
    let config = RuntimeConfig {
        profile_hash: config.profile_hash,
        host_abi: config.host_abi,
        tick_hz: config.tick_hz,
        heap_limit: config.heap_limit,
        frame_buffer_budget: config.frame_buffer_budget,
        profile_json: profile_json.to_vec(),
    };
    let Ok(runtime) = Runtime::new(config) else {
        return ptr::null_mut();
    };
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
/// # Safety
/// runtime is a live instance on its owning thread.
#[no_mangle]
pub unsafe extern "C" fn pocket_runtime_boot(runtime: *mut PocketRuntime) -> i32 {
    unsafe { modify(runtime, Runtime::boot) }
}
/// # Safety
/// runtime is a live instance on its owning thread.
#[no_mangle]
pub unsafe extern "C" fn pocket_runtime_tick(runtime: *mut PocketRuntime) -> i32 {
    unsafe { modify(runtime, Runtime::tick) }
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
