//! Adapt the existing host C allocator to the six canonical runtime hooks.
use core::{
    ffi::{c_char, c_void},
    ptr,
};
const ALIGNMENT: usize = if cfg!(target_pointer_width = "64") {
    16
} else {
    8
};
extern "C" {
    fn abort() -> !;
}
#[cfg(not(feature = "host-allocator"))]
extern "C" {
    fn malloc(size: usize) -> *mut c_void;
    fn realloc(pointer: *mut c_void, size: usize) -> *mut c_void;
    fn free(pointer: *mut c_void);
}
#[cfg(feature = "host-allocator")]
extern "C" {
    fn pocket_legacy_host_alloc(size: usize) -> *mut c_void;
    fn pocket_legacy_host_realloc(pointer: *mut c_void, size: usize) -> *mut c_void;
    fn pocket_legacy_host_free(pointer: *mut c_void);
}
#[no_mangle]
pub unsafe extern "C" fn pocket_host_alloc(size: usize, align: usize) -> *mut c_void {
    if align > ALIGNMENT {
        return ptr::null_mut();
    }
    #[cfg(feature = "host-allocator")]
    {
        pocket_legacy_host_alloc(size.max(1))
    }
    #[cfg(not(feature = "host-allocator"))]
    {
        malloc(size.max(1))
    }
}
#[no_mangle]
pub unsafe extern "C" fn pocket_host_realloc(
    pointer: *mut c_void,
    _old_size: usize,
    align: usize,
    size: usize,
) -> *mut c_void {
    if align > ALIGNMENT {
        return ptr::null_mut();
    }
    #[cfg(feature = "host-allocator")]
    {
        pocket_legacy_host_realloc(pointer, size.max(1))
    }
    #[cfg(not(feature = "host-allocator"))]
    {
        realloc(pointer, size.max(1))
    }
}
#[no_mangle]
pub unsafe extern "C" fn pocket_host_free(pointer: *mut c_void, _size: usize, _align: usize) {
    #[cfg(feature = "host-allocator")]
    {
        pocket_legacy_host_free(pointer)
    }
    #[cfg(not(feature = "host-allocator"))]
    {
        free(pointer)
    }
}
#[no_mangle]
pub unsafe extern "C" fn pocket_host_panic(_message: *const c_char, _length: usize) -> ! {
    abort()
}
#[no_mangle]
pub unsafe extern "C" fn pocket_host_log(_level: i32, _message: *const c_char, _length: usize) {}
#[cfg(not(feature = "boot-stage"))]
#[no_mangle]
pub extern "C" fn pocket_host_boot_stage(_stage: i32) {}
