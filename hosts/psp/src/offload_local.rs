//! Device-local io.offload provider. The worker owns files and fixed caches;
//! it never touches QuickJS, Ui, GE, or the UI heap allocator. Runtime text
//! allocations belong to the worker's bounded private heap.
use alloc::{
    string::{String, ToString},
    vec::Vec,
};
use core::{
    cell::UnsafeCell,
    ffi::c_void,
    fmt::{self, Write},
    sync::atomic::{AtomicU32, AtomicUsize, Ordering::*},
};
use pocketjs_core::font_archive::{Archive, ReadAt};
use psp::sys::{self, IoOpenFlags, IoWhence, SceUid, ThreadAttributes};
const FREE: u32 = 0;
const QUEUED: u32 = 1;
const BUSY: u32 = 2;
const READY: u32 = 3;
#[derive(Clone, Copy)]
pub struct Request {
    pub id: u32,
    pub op: u8,
    pub path: [u8; 128],
    pub generation: u32,
    pub slot: u8,
    pub count: u8,
    pub cps: [u32; 4],
}
impl Request {
    pub const fn empty() -> Self {
        Self {
            id: 0,
            op: 0,
            path: [0; 128],
            generation: 0,
            slot: 0,
            count: 0,
            cps: [0; 4],
        }
    }
}
struct Data {
    epoch: u32,
    seq: u32,
    record_len: usize,
    record: [u8; 4096],
    len: usize,
    reply: [u8; 4096],
}
struct Slot {
    state: AtomicU32,
    data: UnsafeCell<Data>,
}
unsafe impl Sync for Slot {}
impl Slot {
    const fn new() -> Self {
        Self {
            state: AtomicU32::new(FREE),
            data: UnsafeCell::new(Data {
                epoch: 0,
                seq: 0,
                record_len: 0,
                record: [0; 4096],
                len: 0,
                reply: [0; 4096],
            }),
        }
    }
}
static SLOTS: [Slot; 8] = [const { Slot::new() }; 8];
static EPOCH: AtomicU32 = AtomicU32::new(1);
static ONLINE: AtomicU32 = AtomicU32::new(0);
static FAILED: AtomicU32 = AtomicU32::new(0);
static UI_THREAD: AtomicU32 = AtomicU32::new(0);
static PAK_SEQUENCE: AtomicU32 = AtomicU32::new(0);
static PAK_POINTER: AtomicUsize = AtomicUsize::new(0);
static PAK_LENGTH: AtomicUsize = AtomicUsize::new(0);
static mut STARTED: bool = false;
static FRAMES: AtomicU32 = AtomicU32::new(0);
static FRAME_US: AtomicU32 = AtomicU32::new(0);
static MAX_FRAME_US: AtomicU32 = AtomicU32::new(0);
static mut LAST_FRAME: u32 = 0;
static mut SEQUENCE: u32 = 0;
static mut SENT: bool = false;
static mut TAKEN: bool = false;
pub unsafe fn start() {
    if STARTED {
        return;
    }
    STARTED = true;
    UI_THREAD.store(sys::sceKernelGetThreadId() as u32, Release);
    if !crate::worker_heap::reserve() {
        FAILED.store(1, Release);
        return;
    }
    let th = sys::sceKernelCreateThread(
        b"pocket-local-io\0".as_ptr(),
        worker,
        0x30,
        256 * 1024,
        ThreadAttributes::empty(),
        core::ptr::null_mut(),
    );
    if th.0 >= 0 {
        if sys::sceKernelStartThread(th, 0, core::ptr::null_mut()) < 0 {
            FAILED.store(1, Release);
        }
    } else {
        FAILED.store(1, Release);
    }
}
pub fn session() -> i32 {
    if FAILED.load(Acquire) != 0 {
        return 0;
    }
    let e = EPOCH.load(Acquire);
    if ONLINE.load(Acquire) == e {
        e as i32
    } else {
        0
    }
}
pub unsafe fn frame() {
    SENT = false;
    TAKEN = false;
    let now = sys::sceKernelGetSystemTimeLow();
    if LAST_FRAME != 0 {
        let elapsed = now.wrapping_sub(LAST_FRAME);
        FRAME_US.store(elapsed, Relaxed);
        MAX_FRAME_US.fetch_max(elapsed, Relaxed);
    }
    LAST_FRAME = now;
    FRAMES.fetch_add(1, Relaxed);
}
pub unsafe fn reset() {
    EPOCH.fetch_add(1, AcqRel);
}
/// Publish immutable package storage; the worker snapshots it without reading
/// the UI-owned pak registry. The sequence fences pointer/length as a pair.
pub unsafe fn install_pak(pak: &'static [u8]) {
    PAK_SEQUENCE.fetch_add(1, SeqCst);
    PAK_POINTER.store(pak.as_ptr() as usize, SeqCst);
    PAK_LENGTH.store(pak.len(), SeqCst);
    PAK_SEQUENCE.fetch_add(1, SeqCst);
    reset();
}
fn pak_snapshot() -> &'static [u8] {
    loop {
        let sequence = PAK_SEQUENCE.load(SeqCst);
        if sequence & 1 != 0 {
            continue;
        }
        let pointer = PAK_POINTER.load(SeqCst);
        let length = PAK_LENGTH.load(SeqCst);
        if sequence == PAK_SEQUENCE.load(SeqCst) {
            return if pointer == 0 {
                &[]
            } else {
                unsafe { core::slice::from_raw_parts(pointer as *const u8, length) }
            };
        }
    }
}
/// Terminal worker OOM leaves the UI running and turns outstanding client jobs
/// into bounded session-loss errors. It cannot fall through to the UI heap.
pub fn allocation_failed() -> ! {
    FAILED.store(1, Release);
    ONLINE.store(0, Release);
    loop {
        unsafe {
            sys::sceKernelDelayThread(1_000_000);
        }
    }
}
pub unsafe fn submit(record: &[u8]) -> bool {
    if SENT || session() <= 0 || record.is_empty() || record.len() > 4096 {
        return false;
    }
    for slot in &SLOTS {
        if slot.state.load(Acquire) == FREE {
            let d = &mut *slot.data.get();
            d.epoch = EPOCH.load(Acquire);
            SEQUENCE = SEQUENCE.wrapping_add(1);
            d.seq = SEQUENCE;
            d.record_len = record.len();
            d.record[..record.len()].copy_from_slice(record);
            slot.state.store(QUEUED, Release);
            SENT = true;
            return true;
        }
    }
    false
}
pub unsafe fn take() -> Option<alloc::string::String> {
    if TAKEN {
        return None;
    }
    for slot in &SLOTS {
        if slot.state.load(Acquire) == READY {
            let d = &*slot.data.get();
            let result = if d.epoch == EPOCH.load(Acquire) {
                core::str::from_utf8(&d.reply[..d.len])
                    .ok()
                    .map(alloc::string::String::from)
            } else {
                None
            };
            slot.state.store(FREE, Release);
            if result.is_some() {
                TAKEN = true;
                return result;
            }
        }
    }
    None
}
struct File(SceUid);
impl Drop for File {
    fn drop(&mut self) {
        unsafe {
            sys::sceIoClose(self.0);
        }
    }
}
impl ReadAt for File {
    fn read_at(&mut self, offset: u32, out: &mut [u8]) -> bool {
        unsafe {
            if sys::sceIoLseek32(self.0, offset as i32, IoWhence::Set) != offset as i32 {
                return false;
            }
            let mut done = 0;
            while done < out.len() {
                let n = sys::sceIoRead(
                    self.0,
                    out.as_mut_ptr().add(done) as *mut c_void,
                    (out.len() - done).min(4096) as u32,
                );
                if n <= 0 {
                    return false;
                }
                done += n as usize;
            }
            true
        }
    }
}
fn open(path: &[u8; 128]) -> Result<(File, u32), &'static str> {
    let n = path.iter().position(|c| *c == 0).ok_or("Path too long")?;
    let path = &path[..n];
    if path.is_empty()
        || path[0] == b'/'
        || path.windows(2).any(|s| s == b"..")
        || path
            .iter()
            .any(|c| !c.is_ascii_alphanumeric() && !b"/._-".contains(c))
    {
        return Err("Invalid local path");
    }
    let mut full = [0u8; 192];
    let root = b"ms0:/PSP/COMMON/pocketjs/";
    full[..root.len()].copy_from_slice(root);
    full[root.len()..root.len() + n].copy_from_slice(path);
    unsafe {
        let fd = sys::sceIoOpen(full.as_ptr(), IoOpenFlags::RD_ONLY, 0);
        if fd.0 < 0 {
            return Err("Local file unavailable");
        }
        let f = File(fd);
        let len = sys::sceIoLseek32(fd, 0, IoWhence::End);
        if len < 0 {
            return Err("Local file size unavailable");
        }
        Ok((f, len as u32))
    }
}
struct Buffer<'a> {
    bytes: &'a mut [u8],
    len: usize,
}
impl Write for Buffer<'_> {
    fn write_str(&mut self, s: &str) -> fmt::Result {
        if self.len + s.len() > self.bytes.len() {
            return Err(fmt::Error);
        }
        self.bytes[self.len..self.len + s.len()].copy_from_slice(s.as_bytes());
        self.len += s.len();
        Ok(())
    }
}
fn quote(out: &mut Buffer<'_>, s: &str) -> fmt::Result {
    out.write_char('"')?;
    for c in s.chars() {
        match c {
            '"' => out.write_str("\\\"")?,
            '\\' => out.write_str("\\\\")?,
            '\n' => out.write_str("\\n")?,
            '\r' => out.write_str("\\r")?,
            '\t' => out.write_str("\\t")?,
            c if c < ' ' => write!(out, "\\u{:04x}", c as u32)?,
            c => out.write_char(c)?,
        }
    }
    out.write_char('"')
}
fn run(
    request: &Request,
    archive: &mut Option<Archive<File>>,
    generation: &mut u32,
    payload: &mut Buffer<'_>,
) -> Result<(), &'static str> {
    match request.op {
        1 => {
            let (f, len) = open(&request.path)?;
            let face = Archive::open(f, len).map_err(|e| e.message())?;
            *generation = generation.wrapping_add(1).max(1);
            write!(payload, "{{\"generation\":{},\"identity\":\"", generation)
                .map_err(|_| "Reply overflow")?;
            for b in face.identity {
                write!(payload, "{:02x}", b).map_err(|_| "Reply overflow")?;
            }
            payload
                .write_str("\",\"strikes\":[")
                .map_err(|_| "Reply overflow")?;
            for (i, s) in face.strikes[..face.count].iter().enumerate() {
                write!(
                    payload,
                    "{}[{},{},{},{},{},{},{},{}]",
                    if i > 0 { "," } else { "" },
                    s.slot,
                    s.width,
                    s.height,
                    s.baseline,
                    s.line_height,
                    s.advance,
                    s.density,
                    s.count
                )
                .map_err(|_| "Reply overflow")?;
            }
            payload.write_str("]}").map_err(|_| "Reply overflow")?;
            *archive = Some(face);
        }
        2 => {
            if request.generation != *generation {
                return Err("Stale font generation");
            }
            let face = archive.as_mut().ok_or("Font archive not open")?;
            let mut bytes = [0; 1250];
            let n = face
                .batch(
                    *generation,
                    request.slot,
                    &request.cps[..request.count as usize],
                    &mut bytes,
                )
                .map_err(|e| e.message())?;
            for b in &bytes[..n] {
                write!(payload, "{:02x}", b).map_err(|_| "Reply overflow")?;
            }
        }
        3 => {
            let s = archive.as_ref().ok_or("Font archive not open")?.stats;
            write!(payload,"{{\"reads\":{},\"bytes\":{},\"indexHits\":{},\"glyphs\":{},\"missing\":{},\"failures\":{},\"frames\":{},\"frameUs\":{},\"maxFrameUs\":{}}}",s.reads,s.bytes,s.index_hits,s.glyphs,s.missing,s.failures,FRAMES.load(Relaxed),FRAME_US.load(Relaxed),MAX_FRAME_US.load(Relaxed)).map_err(|_|"Reply overflow")?;
        }
        4 => {
            let (mut f, n) = open(&request.path)?;
            if n > 1536 {
                return Err("Text file exceeds 1536 bytes");
            }
            let mut b = [0; 1536];
            if !f.read_at(0, &mut b[..n as usize]) {
                return Err("Text read failed");
            }
            payload
                .write_str(core::str::from_utf8(&b[..n as usize]).map_err(|_| "Text is not UTF-8")?)
                .map_err(|_| "Reply overflow")?;
        }
        5 => {
            *archive = None;
            payload.write_str("closed").map_err(|_| "Reply overflow")?;
        }
        _ => return Err("Unsupported local capability"),
    }
    Ok(())
}

fn legacy_request(id: u32, method: &str, payload: &str) -> Result<Request, &'static str> {
    let mut request = Request::empty();
    request.id = id;
    request.op = match method {
        "font.open" => 1,
        "font.glyphs" => 2,
        "font.stats" => 3,
        "fs.read-text" => 4,
        "font.close" => 5,
        _ => return Err("Unsupported local capability"),
    };
    if request.op == 1 || request.op == 4 {
        if payload.len() >= 128 {
            return Err("Path too long");
        }
        request.path[..payload.len()].copy_from_slice(payload.as_bytes());
    }
    if request.op == 2 {
        let v: serde_json::Value =
            serde_json::from_str(payload).map_err(|_| "Invalid glyph request")?;
        request.generation = v["generation"]
            .as_u64()
            .filter(|n| *n <= u32::MAX as u64)
            .ok_or("Invalid font generation")? as u32;
        request.slot = v["slot"]
            .as_u64()
            .filter(|n| *n < 24)
            .ok_or("Invalid slot")? as u8;
        let cps = v["scalars"]
            .as_array()
            .filter(|v| !v.is_empty() && v.len() <= 4)
            .ok_or("Invalid glyph count")?;
        request.count = cps.len() as u8;
        for (at, value) in cps.iter().enumerate() {
            request.cps[at] = value
                .as_u64()
                .filter(|n| *n <= 0x10ffff)
                .ok_or("Invalid scalar")? as u32;
        }
    }
    Ok(request)
}
fn load_runtime_file(path: &str, limit: usize) -> Result<Vec<u8>, String> {
    if path.len() >= 128 {
        return Err("Font path too long".into());
    }
    let mut confined = [0; 128];
    confined[..path.len()].copy_from_slice(path.as_bytes());
    let (mut file, length) = open(&confined).map_err(String::from)?;
    if length as usize > limit || length < 12 {
        return Err("Font source budget exceeded".into());
    }
    let mut bytes = Vec::new();
    bytes
        .try_reserve_exact(length as usize)
        .map_err(|_| "Font worker allocation budget exceeded")?;
    bytes.resize(length as usize, 0);
    if !file.read_at(0, &mut bytes) {
        return Err("Font read failed".into());
    }
    Ok(bytes)
}
unsafe extern "C" fn worker(_: usize, _: *mut c_void) -> i32 {
    crate::worker_heap::attach();
    let mut archive = None;
    let mut text = None;
    let mut generation = 0;
    let mut epoch = 0;
    loop {
        let current = EPOCH.load(Acquire);
        if current != epoch {
            archive = None;
            // Drop the previous service before allocating the replacement.
            drop(text.take());
            text = Some(crate::local_text::LocalText::new(pak_snapshot()));
            epoch = current;
            for s in &SLOTS {
                s.state.store(FREE, Release);
            }
            ONLINE.store(epoch, Release);
        }
        let next = SLOTS
            .iter()
            .filter(|s| s.state.load(Acquire) == QUEUED)
            .min_by_key(|s| (*s.data.get()).seq);
        if let Some(slot) = next {
            slot.state.store(BUSY, Release);
            let d = &mut *slot.data.get();
            let mut id = 0u64;
            let result: Result<String, String> = (|| {
                let record: serde_json::Value = serde_json::from_slice(&d.record[..d.record_len])
                    .map_err(|_| "Invalid request")?;
                id = record["id"]
                    .as_u64()
                    .filter(|id| *id > 0 && *id <= 9007199254740991)
                    .ok_or("Invalid request id")?;
                if record["v"] != 1 {
                    return Err("Invalid protocol version".into());
                }
                let method = record["method"].as_str().ok_or("Invalid method")?;
                let input = record["payload"].as_str().ok_or("Invalid payload")?;
                if input.encode_utf16().count() > 2500 {
                    return Err("Payload budget exceeded".into());
                }
                if method == "runtime.memory" {
                    let (capacity, used, peak, failures) = crate::worker_heap::stats();
                    return Ok(serde_json::json!({"capacity":capacity,"used":used,"peak":peak,"failures":failures,
                        "workerThreadId":sys::sceKernelGetThreadId(),"uiThreadId":UI_THREAD.load(Acquire),
                        "frames":FRAMES.load(Relaxed),"frameUs":FRAME_US.load(Relaxed),"maxFrameUs":MAX_FRAME_US.load(Relaxed)}).to_string());
                }
                if method.starts_with("runtime.") {
                    return text.as_mut().ok_or("Text service unavailable")?.dispatch(
                        method,
                        input,
                        load_runtime_file,
                    );
                }
                let request = legacy_request(id as u32, method, input).map_err(String::from)?;
                let mut raw = [0; 2500];
                let mut payload = Buffer {
                    bytes: &mut raw,
                    len: 0,
                };
                run(&request, &mut archive, &mut generation, &mut payload).map_err(String::from)?;
                Ok(core::str::from_utf8(&payload.bytes[..payload.len])
                    .map_err(|_| "Invalid payload UTF8")?
                    .to_string())
            })();
            let mut reply = Buffer {
                bytes: &mut d.reply,
                len: 0,
            };
            let _ = write!(reply, "{{\"id\":{},", id);
            let ok = match result {
                Ok(payload) if payload.len() <= 2500 => reply
                    .write_str("\"payload\":")
                    .and_then(|_| quote(&mut reply, &payload)),
                Ok(_) => reply
                    .write_str("\"error\":")
                    .and_then(|_| quote(&mut reply, "Result budget exceeded")),
                Err(e) => reply
                    .write_str("\"error\":")
                    .and_then(|_| quote(&mut reply, &e)),
            };
            if ok.is_ok() && reply.write_str("}").is_ok() {
                d.len = reply.len;
            } else {
                reply.len = 0;
                let _ = write!(
                    reply,
                    "{{\"id\":{},\"error\":\"Result budget exceeded\"}}",
                    id
                );
                d.len = reply.len;
            }
            slot.state.store(READY, Release);
        } else {
            sys::sceKernelDelayThread(1000);
        }
    }
}
