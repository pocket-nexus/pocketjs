//! `globalThis.pack` for the PSP host (contracts/spec/pack.ts, capability data.pack): read-only files
//! that stay on the memory stick until the guest asks for them, so a game's chapters do not count
//! against the 24 MB user partition the way a pak inside the EBOOT does.
//!
//! Path resolution, in order: the directory of argv[0]; the worker thread's current directory, when
//! no argv[0] arrived; ms0:/PSP/GAME/<POCKETJS_APP>/; host0:/. argv[0] names the program as loaded:
//! ms0:/PSP/GAME/<dir>/EBOOT.PBP from the XMB, host0:/<dir>/<name>.prx under PSPLINK. PPSSPP gives
//! ms0:/PSP/GAME/<dir>/EBOOT.PBP when the host path contains PSP/GAME/, otherwise umd0:/EBOOT.PBP
//! with umd0: mounted on the EBOOT's host directory (Core/PSPLoaders.cpp). worker_main (main.rs) also
//! enters that directory, because rust-psp's chdir applies to its own main thread only and PPSSPP
//! answers a relative path on a new thread with SCE_KERNEL_ERROR_NOCWD.
//!
//! Handles survive a suspend. Memory stick descriptors go stale across sleep on real units, so a
//! failed seek or read reopens the resolved path once and retries before reporting -1.
//!
//! The loadImg read buffer is retained and grows to the largest entry seen. The arena never coalesces
//! (platforms/psp/alloc/src/arena.rs: power-of-two classes), so dropping it would not return the
//! bytes to other classes; one buffer per program is the cheaper shape. Textures decode into their
//! own storage, and the guest releases them with the ui op freeTexture.
use alloc::{format, string::String, vec::Vec};
use core::ffi::c_void;
use libquickjs_sys::*;
use pocketjs_core::spec::pack as spec;
use psp::sys::{self, IoOpenFlags, IoWhence, SceUid};

use crate::service_bindings::{add_fn, arg_f64, arg_i32, buffer_mut};

extern "C" {
    fn JS_NewStringLen(ctx: *mut JSContext, text: *const u8, length: usize) -> JSValue;
}

const FALLBACK_ROOT: &str = concat!("ms0:/PSP/GAME/", env!("POCKETJS_APP"));
/// Handle = generation << 3 | slot, the audio module's stale-handle shape.
const SLOT_BITS: i32 = 3;
const SLOT_MASK: i32 = (1 << SLOT_BITS) - 1;
const _: () = assert!(spec::MAX_HANDLES <= 1 << SLOT_BITS);
/// Reads land 64-byte aligned, the memory stick driver's DMA alignment.
const READ_ALIGN: usize = 64;
const READ_BUF_MIN: usize = 64 * 1024;

struct PackFile {
    fd: SceUid,
    size: i64,
    /// Kernel file position, -1 when unknown. Sequential reads skip the seek.
    pos: i64,
    /// Resolved, NUL-terminated path for the reopen after a stale descriptor.
    path: Vec<u8>,
}

#[derive(Clone, Copy)]
struct Counters {
    opens: u32,
    reads: u32,
    read_bytes: u64,
    load_imgs: u32,
    read_us_last: u32,
    read_us_max: u32,
    read_us_sum: u64,
    load_img_us_last: u32,
    load_img_us_max: u32,
    load_img_us_sum: u64,
}

const NONE: Option<PackFile> = None;
static mut FILES: [Option<PackFile>; spec::MAX_HANDLES] = [NONE; spec::MAX_HANDLES];
static mut GENERATIONS: [i32; spec::MAX_HANDLES] = [0; spec::MAX_HANDLES];
static mut READ_BUF: Vec<u8> = Vec::new();
static mut STATS: Counters = Counters {
    opens: 0,
    reads: 0,
    read_bytes: 0,
    load_imgs: 0,
    read_us_last: 0,
    read_us_max: 0,
    read_us_sum: 0,
    load_img_us_last: 0,
    load_img_us_max: 0,
    load_img_us_sum: 0,
};
static mut LAST_ROOT: &str = "";
/// Directory of argv[0] with its trailing '/', NUL-terminated. Empty until set_program_path.
static mut PROGRAM_DIR: [u8; 256] = [0; 256];

/// Keep the directory of argv[0]. Runs on rust-psp's main thread before the allocator exists.
///
/// # Safety
/// `argv` points at `length` readable bytes holding the module's argument block.
pub unsafe fn set_program_path(argv: *const u8, length: usize) {
    let block = core::slice::from_raw_parts(argv, length);
    let path = &block[..block.iter().position(|&b| b == 0).unwrap_or(length)];
    let Some(slash) = path.iter().rposition(|&b| b == b'/') else {
        return;
    };
    if slash + 1 < PROGRAM_DIR.len() {
        PROGRAM_DIR[..=slash].copy_from_slice(&path[..=slash]);
        PROGRAM_DIR[slash + 1] = 0;
    }
}

/// Enter the program's directory on the calling thread.
///
/// # Safety
/// PSP thread context; called before the thread opens a relative path.
pub unsafe fn enter_program_dir() {
    if PROGRAM_DIR[0] != 0 {
        sys::sceIoChdir(PROGRAM_DIR.as_ptr());
    }
}

fn nul(s: &str) -> Vec<u8> {
    let mut v = Vec::with_capacity(s.len() + 1);
    v.extend_from_slice(s.as_bytes());
    v.push(0);
    v
}

/// The grammar of packValidPath in contracts/spec/pack.ts.
fn valid(path: &str) -> bool {
    if path.is_empty() || path.len() > spec::MAX_PATH_BYTES || path.contains(':') || path.contains('\\') {
        return false;
    }
    let mut depth = 0;
    for segment in path.split('/') {
        depth += 1;
        if depth > spec::MAX_DEPTH
            || segment.is_empty()
            || segment == "."
            || segment == ".."
            || segment.len() > spec::MAX_SEGMENT_BYTES
        {
            return false;
        }
    }
    true
}

unsafe fn file_mut(handle: i32) -> Option<&'static mut PackFile> {
    if handle < 0 {
        return None;
    }
    let slot = (handle & SLOT_MASK) as usize;
    if slot >= spec::MAX_HANDLES || GENERATIONS[slot] != handle >> SLOT_BITS {
        return None;
    }
    FILES[slot].as_mut()
}

/// The first root holding `path`: the descriptor, its resolved NUL-terminated path, the root's name.
unsafe fn open_resolved(path: &str) -> Option<(SceUid, Vec<u8>, &'static str)> {
    let dir_len = PROGRAM_DIR.iter().position(|&b| b == 0).unwrap_or(0);
    let mut candidates: [Option<(Vec<u8>, &'static str)>; 3] = [None, None, None];
    if dir_len > 0 {
        let mut full = Vec::with_capacity(dir_len + path.len() + 1);
        full.extend_from_slice(&PROGRAM_DIR[..dir_len]);
        full.extend_from_slice(path.as_bytes());
        full.push(0);
        candidates[0] = Some((full, "program"));
    } else {
        candidates[0] = Some((nul(path), "cwd"));
    }
    if FALLBACK_ROOT.len() > "ms0:/PSP/GAME/".len() {
        candidates[1] = Some((nul(&format!("{}/{}", FALLBACK_ROOT, path)), "fallback"));
    }
    if !PROGRAM_DIR.starts_with(b"host0:") {
        candidates[2] = Some((nul(&format!("host0:/{}", path)), "host0"));
    }
    for (full, root) in candidates.into_iter().flatten() {
        let fd = sys::sceIoOpen(full.as_ptr(), IoOpenFlags::RD_ONLY, 0);
        if fd.0 >= 0 {
            return Some((fd, full, root));
        }
    }
    None
}

unsafe fn open_file(path: &str) -> i32 {
    if !valid(path) {
        return spec::OPEN_MISSING;
    }
    let Some(slot) = (0..spec::MAX_HANDLES).find(|&s| FILES[s].is_none()) else {
        return spec::OPEN_MISSING;
    };
    let Some((fd, resolved, root)) = open_resolved(path) else {
        return spec::OPEN_MISSING;
    };
    let size = sys::sceIoLseek(fd, 0, IoWhence::End);
    if size < 0 {
        sys::sceIoClose(fd);
        return spec::OPEN_MISSING;
    }
    FILES[slot] = Some(PackFile { fd, size, pos: size, path: resolved });
    GENERATIONS[slot] = (GENERATIONS[slot] + 1) & 0x00ff_ffff;
    STATS.opens = STATS.opens.wrapping_add(1);
    LAST_ROOT = root;
    (GENERATIONS[slot] << SLOT_BITS) | slot as i32
}

unsafe fn reopen(file: &mut PackFile) -> bool {
    sys::sceIoClose(file.fd);
    file.fd = sys::sceIoOpen(file.path.as_ptr(), IoOpenFlags::RD_ONLY, 0);
    file.pos = -1;
    file.fd.0 >= 0
}

/// Read until `dst` is full or the file ends. None on an I/O error the reopen did not cure.
unsafe fn read_at(file: &mut PackFile, offset: i64, dst: *mut u8, capacity: usize) -> Option<usize> {
    if offset < 0 {
        return None;
    }
    let want = (file.size - offset).clamp(0, capacity as i64) as usize;
    let mut got = 0usize;
    let mut retried = false;
    while got < want {
        let at = offset + got as i64;
        let mut failed = false;
        if file.pos != at {
            if sys::sceIoLseek(file.fd, at, IoWhence::Set) == at {
                file.pos = at;
            } else {
                failed = true;
            }
        }
        if !failed {
            let n = sys::sceIoRead(file.fd, dst.add(got) as *mut c_void, (want - got) as u32);
            if n > 0 {
                got += n as usize;
                file.pos += n as i64;
                continue;
            }
            if n == 0 {
                break; // the file shrank under us; report what arrived
            }
            failed = true;
        }
        if failed && (retried || !reopen(file)) {
            return None;
        }
        retried = true;
    }
    Some(got)
}

fn elapsed_us(start: u32) -> u32 {
    unsafe { sys::sceKernelGetSystemTimeLow() }.wrapping_sub(start)
}

/// The retained loadImg buffer, READ_ALIGN-aligned, at least `length` bytes.
unsafe fn read_buffer(length: usize) -> *mut u8 {
    let need = length + READ_ALIGN;
    if READ_BUF.capacity() < need {
        // Replace rather than grow: the old contents are dead, so skip realloc's copy.
        READ_BUF = Vec::new();
        READ_BUF.reserve_exact(need.next_power_of_two().max(READ_BUF_MIN));
    }
    let base = READ_BUF.as_mut_ptr();
    base.add(base.align_offset(READ_ALIGN))
}

// ---- QuickJS glue --------------------------------------------------------------------------------
unsafe extern "C" fn js_open(ctx: *mut JSContext, _t: JSValue, argc: i32, argv: *mut JSValue) -> JSValue {
    if argc < 1 {
        return JS_NewInt32(ctx, spec::OPEN_MISSING);
    }
    let mut len: size_t = 0;
    let text = JS_ToCStringLen2(ctx, &mut len, *argv, 0);
    if text.is_null() {
        JS_FreeValue(ctx, JS_GetException(ctx));
        return JS_NewInt32(ctx, spec::OPEN_MISSING);
    }
    let handle = match core::str::from_utf8(core::slice::from_raw_parts(text as *const u8, len)) {
        Ok(path) => open_file(path),
        Err(_) => spec::OPEN_MISSING,
    };
    JS_FreeCString(ctx, text);
    JS_NewInt32(ctx, handle)
}

unsafe extern "C" fn js_size(ctx: *mut JSContext, _t: JSValue, argc: i32, argv: *mut JSValue) -> JSValue {
    let size = file_mut(arg_i32(ctx, argc, argv, 0)).map_or(-1.0, |file| file.size as f64);
    JS_NewFloat64(ctx, size)
}

unsafe extern "C" fn js_read(ctx: *mut JSContext, _t: JSValue, argc: i32, argv: *mut JSValue) -> JSValue {
    let handle = arg_i32(ctx, argc, argv, 0);
    let offset = arg_f64(ctx, argc, argv, 1);
    let Some(file) = file_mut(handle) else {
        return JS_NewInt32(ctx, -1);
    };
    if argc < 3 {
        return JS_NewInt32(ctx, -1);
    }
    let Some(dst) = buffer_mut(ctx, *argv.offset(2)) else {
        return JS_NewInt32(ctx, -1);
    };
    let start = sys::sceKernelGetSystemTimeLow();
    let got = read_at(file, offset as i64, dst.as_mut_ptr(), dst.len());
    let us = elapsed_us(start);
    STATS.reads = STATS.reads.wrapping_add(1);
    STATS.read_us_last = us;
    STATS.read_us_max = STATS.read_us_max.max(us);
    STATS.read_us_sum += us as u64;
    match got {
        Some(n) => {
            STATS.read_bytes += n as u64;
            JS_NewInt32(ctx, n as i32)
        }
        None => JS_NewInt32(ctx, -1),
    }
}

unsafe extern "C" fn js_load_img(ctx: *mut JSContext, _t: JSValue, argc: i32, argv: *mut JSValue) -> JSValue {
    let handle = arg_i32(ctx, argc, argv, 0);
    let offset = arg_f64(ctx, argc, argv, 1);
    let length = arg_f64(ctx, argc, argv, 2);
    let Some(file) = file_mut(handle) else {
        return JS_NewInt32(ctx, -1);
    };
    if !(offset >= 0.0) || !(length >= 8.0) || length > spec::MAX_IMG_BYTES as f64 || offset + length > file.size as f64 {
        return JS_NewInt32(ctx, -1);
    }
    let length = length as usize;
    let start = sys::sceKernelGetSystemTimeLow();
    let buffer = read_buffer(length);
    if read_at(file, offset as i64, buffer, length) != Some(length) {
        return JS_NewInt32(ctx, -1);
    }
    let blob = core::slice::from_raw_parts(buffer, length);
    let texture = crate::instance::with_ui(ctx, |ui| ui.upload_img_entry(blob)).unwrap_or(-1);
    let us = elapsed_us(start);
    STATS.load_imgs = STATS.load_imgs.wrapping_add(1);
    STATS.load_img_us_last = us;
    STATS.load_img_us_max = STATS.load_img_us_max.max(us);
    STATS.load_img_us_sum += us as u64;
    JS_NewInt32(ctx, texture)
}

unsafe extern "C" fn js_close(ctx: *mut JSContext, _t: JSValue, argc: i32, argv: *mut JSValue) -> JSValue {
    let handle = arg_i32(ctx, argc, argv, 0);
    if file_mut(handle).is_some() {
        let slot = (handle & SLOT_MASK) as usize;
        if let Some(file) = FILES[slot].take() {
            sys::sceIoClose(file.fd);
        }
    }
    JS_UNDEFINED
}

unsafe extern "C" fn js_stats(ctx: *mut JSContext, _t: JSValue, _argc: i32, _argv: *mut JSValue) -> JSValue {
    let s = STATS;
    let line: String = format!(
        concat!(
            "{{\"opens\":{},\"reads\":{},\"readBytes\":{},\"loadImgs\":{},",
            "\"readUsLast\":{},\"readUsMax\":{},\"readUsSum\":{},",
            "\"loadImgUsLast\":{},\"loadImgUsMax\":{},\"loadImgUsSum\":{},",
            "\"readBufBytes\":{},\"root\":\"{}\"}}"
        ),
        s.opens,
        s.reads,
        s.read_bytes,
        s.load_imgs,
        s.read_us_last,
        s.read_us_max,
        s.read_us_sum,
        s.load_img_us_last,
        s.load_img_us_max,
        s.load_img_us_sum,
        READ_BUF.capacity(),
        LAST_ROOT,
    );
    JS_NewStringLen(ctx, line.as_ptr(), line.len())
}

/// Install `globalThis.pack`. # Safety: QuickJS context alive, worker thread.
pub unsafe fn register_pack(ctx: *mut JSContext, global: JSValue) {
    let pack = JS_NewObject(ctx);
    add_fn(ctx, pack, b"open\0", js_open, 1);
    add_fn(ctx, pack, b"size\0", js_size, 1);
    add_fn(ctx, pack, b"read\0", js_read, 3);
    add_fn(ctx, pack, b"loadImg\0", js_load_img, 3);
    add_fn(ctx, pack, b"close\0", js_close, 1);
    add_fn(ctx, pack, b"stats\0", js_stats, 0);
    JS_SetPropertyStr(ctx, global, b"pack\0".as_ptr() as *const _, pack);
}

/// Guest teardown: every file dies with its guest (the next guest's handles start over).
pub unsafe fn reset() {
    for slot in 0..spec::MAX_HANDLES {
        if let Some(file) = FILES[slot].take() {
            sys::sceIoClose(file.fd);
        }
    }
}
