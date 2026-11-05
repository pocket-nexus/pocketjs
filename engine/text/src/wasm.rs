//! Single-worker ABI. Input allocations belong to the caller; reply bytes are
//! borrowed until the next request/reset. This module is never instantiated on
//! the browser UI thread.
#![allow(static_mut_refs)]
use super::Engine;
static mut ENGINE: Option<Engine> = None;
static mut REPLY: Vec<u8> = Vec::new();
#[no_mangle]
pub extern "C" fn text_init() {
    unsafe {
        ENGINE = Some(Engine::new());
        REPLY.clear();
    }
}
#[no_mangle]
pub extern "C" fn text_alloc(len: usize) -> *mut u8 {
    let mut bytes = vec![0u8; len].into_boxed_slice();
    let ptr = bytes.as_mut_ptr();
    std::mem::forget(bytes);
    ptr
}
#[no_mangle]
pub unsafe extern "C" fn text_free(ptr: *mut u8, len: usize) {
    drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr, len)));
}
#[no_mangle]
pub unsafe extern "C" fn text_load_pak(ptr: *const u8, len: usize) {
    ENGINE
        .as_mut()
        .unwrap()
        .load_pak(std::slice::from_raw_parts(ptr, len));
}
#[no_mangle]
pub unsafe extern "C" fn text_load_font(ptr: *const u8, len: usize) -> bool {
    ENGINE
        .as_mut()
        .unwrap()
        .load_font(std::slice::from_raw_parts(ptr, len))
}
#[no_mangle]
pub unsafe extern "C" fn text_request(ptr: *const u8, len: usize) -> *const u8 {
    let text = std::str::from_utf8(std::slice::from_raw_parts(ptr, len)).unwrap_or("");
    REPLY = ENGINE.as_mut().unwrap().reply(text).into_bytes();
    REPLY.as_ptr()
}
#[no_mangle]
pub extern "C" fn text_reply_len() -> usize {
    unsafe { REPLY.len() }
}
