//! Pocket Link over the PSPLINK share (contracts/spec/link.ts "USB carrier"):
//! `globalThis.net` and `globalThis.link` on a PSP whose companion serves
//! host0:. The companion beats `host0:/pocket-link/ready`; requests go out as
//! `net<i>.req` records and come back as `net<i>.res` records whose JSON is
//! the NET event itself.
//!
//! A lower-priority worker owns every host0 operation, so a slow USB round
//! trip never lands in a frame. The QuickJS thread builds each request record,
//! allocates the reply buffers, and frees them; the worker only reads and
//! writes inside buffers it was handed, because the global allocator is
//! single-threaded. Slot ownership moves by release/acquire state changes,
//! as in offload.rs.
//!
//! The link is a host service: the program starts it when it installs the
//! namespaces and it survives guest switches; `reset()` cancels the outgoing
//! guest's requests.

use alloc::string::String;
use alloc::vec::Vec;
use core::{
    cell::UnsafeCell,
    ffi::c_void,
    sync::atomic::{
        AtomicU32,
        Ordering::{Acquire, Relaxed, Release},
    },
};

use psp::sys::{self, IoOpenFlags, SceUid};

// contracts/spec/link.ts (USB carrier) and contracts/spec/net.ts.
const MAGIC: u32 = 0x554c4b50;
const HEADER: usize = 64;
const KIND_READY: u32 = 1;
const KIND_HELLO: u32 = 2;
const KIND_REQUEST: u32 = 3;
const KIND_CANCEL: u32 = 4;
const KIND_REPLY: u32 = 5;
const KIND_MEDIA: u32 = 6;
const SLOTS: usize = 2;
const MAX_JSON: usize = 16 * 1024;
const BEAT_US: u32 = 500_000;
const SILENCE_US: u32 = 3_000_000;
const MAX_REQUEST_BYTES: usize = 64 * 1024;
const DEFAULT_RESPONSE_BYTES: u64 = 128 * 1024;
const MAX_RESPONSE_BYTES: u64 = 256 * 1024;
const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const MAX_TIMEOUT_MS: u64 = 120_000;
/// Past the request's own timeout, the time the companion gets to report it.
const GRACE_MS: u64 = 5_000;
/// The companion's `ready` JSON, at most.
const STATUS_MAX: usize = 1024;

// Slot states. The QuickJS thread owns FREE, READY, DONE, CANCELLED and LOST;
// the worker owns QUEUED, SENT and CANCEL.
const FREE: u32 = 0;
/// Record built, not yet written.
const QUEUED: u32 = 1;
/// Record written, waiting for the reply.
const SENT: u32 = 2;
/// Reply read into the slot's buffers.
const READY: u32 = 3;
/// The guest cancelled (or the request timed out) while the worker held it.
const CANCEL: u32 = 4;
/// The worker is done with a cancelled slot.
const CANCELLED: u32 = 5;
/// The companion's session ended under the request (restart or silence).
const LOST: u32 = 6;
/// The done event went out; the body waits for take().
const DONE: u32 = 7;

/// What the QuickJS thread hands the worker with QUEUED, and what the worker
/// hands back with READY.
struct Shared {
    generation: u32,
    seq: u32,
    record: *mut u8,
    record_len: usize,
    json: *mut u8,
    json_cap: usize,
    json_len: usize,
    body: *mut u8,
    body_cap: usize,
    body_len: usize,
    /// The reply did not fit the buffers (the companion broke maxBytes).
    oversize: bool,
}

struct Slot {
    state: AtomicU32,
    data: UnsafeCell<Shared>,
}

// A release/acquire state change hands `data` to its next owner.
unsafe impl Sync for Slot {}

impl Slot {
    const fn new() -> Self {
        Self {
            state: AtomicU32::new(FREE),
            data: UnsafeCell::new(Shared {
                generation: 0,
                seq: 0,
                record: core::ptr::null_mut(),
                record_len: 0,
                json: core::ptr::null_mut(),
                json_cap: 0,
                json_len: 0,
                body: core::ptr::null_mut(),
                body_cap: 0,
                body_len: 0,
                oversize: false,
            }),
        }
    }
}

static SLOTS_STATE: [Slot; SLOTS] = [const { Slot::new() }; SLOTS];
/// The worker's session generation while a companion beats; 0 while none does.
static SESSION: AtomicU32 = AtomicU32::new(0);
/// The beating companion's epoch; 0 while none beats.
static EPOCH: AtomicU32 = AtomicU32::new(0);
/// The companion's `ready` JSON (a seqlock: odd while the worker writes it).
struct Status(UnsafeCell<[u8; STATUS_MAX]>);
unsafe impl Sync for Status {}
static STATUS: Status = Status(UnsafeCell::new([0; STATUS_MAX]));
static STATUS_LEN: AtomicU32 = AtomicU32::new(0);
static STATUS_SEQ: AtomicU32 = AtomicU32::new(0);

/// The buffers a slot's request owns: QuickJS-thread memory the worker
/// borrows through `Shared`. Freed only on this thread.
struct Owned {
    handle: i32,
    record: Vec<u8>,
    json: Vec<u8>,
    body: Vec<u8>,
    deadline: u32,
    /// An event (done, error, timeout) already went to the guest, or the
    /// guest cancelled: nothing more is reported for this request.
    reported: bool,
}

// QuickJS-thread state.
static mut STARTED: bool = false;
static mut BOOT: u32 = 0;
static mut NEXT_ID: u32 = 1;
static mut SEQ: [u32; SLOTS] = [0; SLOTS];
static mut OWNED: [Option<Owned>; SLOTS] = [const { None }; SLOTS];
static mut LAST_ERROR: String = String::new();
static mut DEVICE_ID: [u8; 16] = [b'0'; 16];
/// The `hello` record body the worker writes (built once at start).
static mut HELLO: [u8; 256] = [0; 256];
static mut HELLO_LEN: usize = 0;
/// The session start() found, handed to the worker before it runs.
static mut FIRST_EPOCH: u32 = 0;
static mut FIRST_BEAT: u32 = 0;

fn now() -> u32 {
    unsafe { sys::sceKernelGetSystemTimeLow() }
}

pub fn fnv1a32(bytes: &[u8]) -> u32 {
    bytes
        .iter()
        .fold(2166136261u32, |h, b| (h ^ *b as u32).wrapping_mul(16777619))
}

fn word(b: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]])
}

fn put(b: &mut [u8], at: usize, value: u32) {
    b[at..at + 4].copy_from_slice(&value.to_le_bytes());
}

fn push_json_str(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 => {
                let hex = b"0123456789abcdef";
                out.push_str("\\u00");
                out.push(hex[(c as u32 >> 4) as usize] as char);
                out.push(hex[(c as u32 & 0xf) as usize] as char);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

/// The raw value of a top-level member of a JSON object (`{…}`), or None.
/// Enough JSON for records this module and the companion write.
fn member<'a>(object: &'a [u8], key: &str) -> Option<&'a [u8]> {
    let mut i = object.iter().position(|b| *b == b'{')? + 1;
    loop {
        while i < object.len() && matches!(object[i], b' ' | b'\n' | b'\r' | b'\t' | b',') {
            i += 1;
        }
        if i >= object.len() || object[i] != b'"' {
            return None;
        }
        let name_end = skip_value(object, i)?;
        let name = &object[i + 1..name_end - 1];
        i = name_end;
        while i < object.len() && matches!(object[i], b' ' | b'\n' | b'\r' | b'\t' | b':') {
            i += 1;
        }
        let end = skip_value(object, i)?;
        if name == key.as_bytes() {
            return Some(&object[i..end]);
        }
        i = end;
    }
}

/// The index past the JSON value starting at `i`.
fn skip_value(s: &[u8], mut i: usize) -> Option<usize> {
    match *s.get(i)? {
        b'"' => {
            i += 1;
            while i < s.len() {
                match s[i] {
                    b'\\' => i += 2,
                    b'"' => return Some(i + 1),
                    _ => i += 1,
                }
            }
            None
        }
        b'{' | b'[' => {
            let mut depth = 0usize;
            while i < s.len() {
                match s[i] {
                    b'"' => {
                        i = skip_value(s, i)?;
                        continue;
                    }
                    b'{' | b'[' => depth += 1,
                    b'}' | b']' => {
                        depth -= 1;
                        if depth == 0 {
                            return Some(i + 1);
                        }
                    }
                    _ => {}
                }
                i += 1;
            }
            None
        }
        _ => {
            while i < s.len() && !matches!(s[i], b',' | b'}' | b']' | b' ' | b'\n' | b'\r' | b'\t') {
                i += 1;
            }
            Some(i)
        }
    }
}

fn number(value: Option<&[u8]>) -> Option<u64> {
    let digits = value?;
    if digits.is_empty() || !digits.iter().all(|b| b.is_ascii_digit()) || digits.len() > 12 {
        return None;
    }
    Some(digits.iter().fold(0u64, |n, b| n * 10 + (b - b'0') as u64))
}

/// Start the link once per process (it serves every guest); `target` is the
/// profile id the `hello` record names. The first `ready` read happens here,
/// on the QuickJS thread before a guest runs, so a request at mount finds the
/// session already up.
pub unsafe fn start(target: &str) {
    if STARTED {
        return;
    }
    STARTED = true;
    BOOT = now().max(1);
    let mut mac = [0u8; 8];
    if sys::sceWlanGetEtherAddr(mac.as_mut_ptr()) >= 0 {
        let hex = b"0123456789abcdef";
        for (i, b) in mac[..6].iter().enumerate() {
            DEVICE_ID[4 + i * 2] = hex[(b >> 4) as usize];
            DEVICE_ID[5 + i * 2] = hex[(b & 0xf) as usize];
        }
    }
    let id = core::str::from_utf8(&DEVICE_ID).unwrap_or("0000000000000000");
    let mut hello = String::from("{\"t\":\"hello\",\"device\":");
    push_json_str(&mut hello, id);
    hello.push_str(",\"name\":\"PSP\",\"model\":\"PSP\",\"target\":");
    push_json_str(&mut hello, target);
    hello.push('}');
    let len = hello.len().min(HELLO.len());
    HELLO[..len].copy_from_slice(&hello.as_bytes()[..len]);
    HELLO_LEN = len;
    let mut status = [0u8; STATUS_MAX];
    if let Some((epoch, beat, len)) = read_ready(&mut status) {
        publish_status(&status[..len]);
        FIRST_EPOCH = epoch;
        FIRST_BEAT = beat;
        SESSION.store(1, Release);
        EPOCH.store(epoch, Release);
    }
    let th = sys::sceKernelCreateThread(
        b"pocket-link\0".as_ptr(),
        worker,
        0x30,
        16384,
        sys::ThreadAttributes::USER,
        core::ptr::null_mut(),
    );
    if th.0 >= 0 {
        sys::sceKernelStartThread(th, 0, core::ptr::null_mut());
    }
}

fn set_error(code: &str, message: &str) {
    unsafe {
        LAST_ERROR.clear();
        LAST_ERROR.push_str(code);
        LAST_ERROR.push_str(": ");
        LAST_ERROR.push_str(message);
    }
}

/// Release a slot's buffers (QuickJS thread, the slot in a thread-owned state).
unsafe fn release(index: usize) {
    OWNED[index] = None;
    SLOTS_STATE[index].state.store(FREE, Release);
}

/// spec net op start(metaJson, body) -> handle | -1.
pub unsafe fn net_start(meta: &[u8], body: &[u8], app: &str) -> i32 {
    LAST_ERROR.clear();
    if SESSION.load(Acquire) == 0 {
        set_error("unavailable", "no companion answers on the USB share");
        return -1;
    }
    if body.len() > MAX_REQUEST_BYTES {
        set_error("invalid_request", "request body exceeds 64 KiB");
        return -1;
    }
    let open = match meta.iter().position(|b| !matches!(b, b' ' | b'\n' | b'\r' | b'\t')) {
        Some(at) if meta[at] == b'{' && member(meta, "url").is_some() => at,
        _ => {
            set_error("invalid_request", "malformed request metadata");
            return -1;
        }
    };
    let index = match (0..SLOTS).find(|&i| {
        let state = SLOTS_STATE[i].state.load(Acquire);
        if state == CANCELLED {
            release(i);
        }
        SLOTS_STATE[i].state.load(Acquire) == FREE
    }) {
        Some(i) => i,
        None => {
            set_error("busy", "2 requests are already in flight");
            return -1;
        }
    };
    let max_bytes = match number(member(meta, "maxBytes")) {
        Some(n) if n > 0 && n <= MAX_RESPONSE_BYTES => n,
        Some(0) | None => DEFAULT_RESPONSE_BYTES,
        Some(_) => MAX_RESPONSE_BYTES,
    } as usize;
    let timeout_ms = match number(member(meta, "timeoutMs")) {
        Some(n) if n > 0 && n <= MAX_TIMEOUT_MS => n,
        Some(0) | None => DEFAULT_TIMEOUT_MS,
        Some(_) => MAX_TIMEOUT_MS,
    };

    let id = NEXT_ID;
    NEXT_ID = NEXT_ID.wrapping_add(1).max(1) & 0x7fff_ffff;
    SEQ[index] = SEQ[index].wrapping_add(1).max(1);
    // The guest's metadata object, extended with the link fields, exactly as
    // the TCP link sends it: {"t":"net","id":n,"app":"…","bytes":k, <meta>}.
    let mut json = String::from("{\"t\":\"net\",\"id\":");
    json.push_str(itoa(id).as_str());
    json.push_str(",\"app\":");
    push_json_str(&mut json, app);
    json.push_str(",\"bytes\":");
    json.push_str(itoa(body.len() as u32).as_str());
    let rest = &meta[open + 1..];
    let rest_at = rest.iter().position(|b| !matches!(b, b' ' | b'\n' | b'\r' | b'\t')).unwrap_or(rest.len());
    if rest_at < rest.len() && rest[rest_at] != b'}' {
        json.push(',');
    }
    let Ok(rest) = core::str::from_utf8(&rest[rest_at..]) else {
        set_error("invalid_request", "request metadata is not UTF-8");
        return -1;
    };
    json.push_str(rest);
    if json.len() > MAX_JSON {
        set_error("invalid_request", "request metadata exceeds 16 KiB");
        return -1;
    }

    let mut record: Vec<u8> = Vec::with_capacity(HEADER + json.len() + body.len());
    record.resize(HEADER, 0);
    record.extend_from_slice(json.as_bytes());
    record.extend_from_slice(body);
    // Epoch (word 4) is the worker's to fill when it writes the record.
    for (at, value) in [
        (0, MAGIC),
        (8, BOOT),
        (12, SEQ[index]),
        (16, KIND_REQUEST),
        (20, id),
        (32, json.len() as u32),
        (36, fnv1a32(json.as_bytes())),
        (40, body.len() as u32),
        (44, fnv1a32(body)),
    ] {
        put(&mut record, at, value);
    }
    let mut reply_json: Vec<u8> = Vec::with_capacity(MAX_JSON);
    let mut reply_body: Vec<u8> = Vec::with_capacity(max_bytes);
    let shared = &mut *SLOTS_STATE[index].data.get();
    *shared = Shared {
        generation: SESSION.load(Acquire),
        seq: SEQ[index],
        record: record.as_mut_ptr(),
        record_len: record.len(),
        json: reply_json.as_mut_ptr(),
        json_cap: reply_json.capacity(),
        json_len: 0,
        body: reply_body.as_mut_ptr(),
        body_cap: reply_body.capacity(),
        body_len: 0,
        oversize: false,
    };
    OWNED[index] = Some(Owned {
        handle: id as i32,
        record,
        json: reply_json,
        body: reply_body,
        deadline: now().wrapping_add(((timeout_ms + GRACE_MS) * 1000) as u32),
        reported: false,
    });
    SLOTS_STATE[index].state.store(QUEUED, Release);
    id as i32
}

/// `value` in decimal, written into `out` without allocating (the worker uses it).
fn decimal(value: u32, out: &mut [u8; 10]) -> &[u8] {
    let mut n = 10;
    let mut v = value;
    loop {
        n -= 1;
        out[n] = b'0' + (v % 10) as u8;
        v /= 10;
        if v == 0 {
            break;
        }
    }
    &out[n..]
}

fn itoa(value: u32) -> String {
    let mut digits = [0u8; 10];
    String::from(core::str::from_utf8(decimal(value, &mut digits)).unwrap_or("0"))
}

fn push_error_event(events: &mut String, handle: i32, code: &str, message: &str) {
    if events.len() > 1 {
        events.push(',');
    }
    events.push_str("{\"t\":\"error\",\"h\":");
    events.push_str(itoa(handle as u32).as_str());
    events.push_str(",\"code\":");
    push_json_str(events, code);
    events.push_str(",\"message\":");
    push_json_str(events, message);
    events.push('}');
}

/// spec net op poll() -> the tick's events as one JSON array, or None.
pub unsafe fn net_poll() -> Option<String> {
    let mut events = String::from("[");
    let t = now();
    for index in 0..SLOTS {
        let slot = &SLOTS_STATE[index];
        let Some(owned) = OWNED[index].as_mut() else { continue };
        match slot.state.load(Acquire) {
            READY => {
                let shared = &*slot.data.get();
                owned.record = Vec::new();
                if owned.reported {
                    release(index);
                    continue;
                }
                owned.reported = true;
                if shared.oversize {
                    push_error_event(&mut events, owned.handle, "response_too_large", "the reply exceeds maxBytes");
                    release(index);
                    continue;
                }
                owned.json.set_len(shared.json_len);
                owned.body.set_len(shared.body_len);
                let is_done = member(&owned.json, "t") == Some(b"\"done\"");
                if events.len() > 1 {
                    events.push(',');
                }
                events.push_str(core::str::from_utf8(&owned.json).unwrap_or("{}"));
                owned.json = Vec::new();
                if is_done {
                    slot.state.store(DONE, Release);
                } else {
                    release(index);
                }
            }
            LOST => {
                if !owned.reported {
                    push_error_event(&mut events, owned.handle, "unavailable", "the companion on the USB share went away");
                }
                release(index);
            }
            CANCELLED => release(index),
            QUEUED | SENT => {
                if !owned.reported && t.wrapping_sub(owned.deadline) < 0x8000_0000 {
                    owned.reported = true;
                    push_error_event(&mut events, owned.handle, "timeout", "the companion did not answer in time");
                    cancel_slot(index);
                }
            }
            _ => {}
        }
    }
    if events.len() == 1 {
        None
    } else {
        events.push(']');
        Some(events)
    }
}

/// spec net op take(handle, into) -> bytes copied | -1.
pub unsafe fn net_take(handle: i32, into: &mut [u8]) -> i32 {
    for index in 0..SLOTS {
        let Some(owned) = OWNED[index].as_ref() else { continue };
        if owned.handle != handle || SLOTS_STATE[index].state.load(Acquire) != DONE {
            continue;
        }
        if into.len() != owned.body.len() {
            return -1;
        }
        into.copy_from_slice(&owned.body);
        let n = into.len() as i32;
        release(index);
        return n;
    }
    -1
}

/// spec net op cancel(handle).
pub unsafe fn net_cancel(handle: i32) {
    for index in 0..SLOTS {
        let Some(owned) = OWNED[index].as_mut() else { continue };
        if owned.handle != handle {
            continue;
        }
        owned.reported = true;
        cancel_slot(index);
    }
}

/// Hand a slot back: CANCEL while the worker holds it (it writes the cancel
/// record and lets go), released here when this thread holds it.
unsafe fn cancel_slot(index: usize) {
    let slot = &SLOTS_STATE[index];
    loop {
        match slot.state.load(Acquire) {
            state @ (QUEUED | SENT) => {
                // A failure means the worker moved it on meanwhile: look again.
                if slot.state.compare_exchange(state, CANCEL, Release, Relaxed).is_ok() {
                    return;
                }
            }
            CANCEL => return,
            _ => return release(index),
        }
    }
}

pub unsafe fn net_last_error() -> &'static str {
    LAST_ERROR.as_str()
}

/// Guest teardown: the outgoing guest's requests are cancelled. The worker
/// and the companion's session carry on for the next guest.
pub unsafe fn reset() {
    for index in 0..SLOTS {
        if let Some(owned) = OWNED[index].as_mut() {
            owned.reported = true;
            cancel_slot(index);
        }
    }
    LAST_ERROR.clear();
}

/// spec link op status(): a LinkStatus JSON for the share's companion.
pub unsafe fn link_status() -> String {
    let mut status = [0u8; STATUS_MAX];
    let mut len;
    loop {
        let before = STATUS_SEQ.load(Acquire);
        len = STATUS_LEN.load(Acquire) as usize;
        if before & 1 == 0 {
            let shared = &*STATUS.0.get();
            status[..len].copy_from_slice(&shared[..len]);
            if STATUS_SEQ.load(Acquire) == before {
                break;
            }
        }
        sys::sceKernelDelayThread(100);
    }
    let ready = &status[..len];
    let linked = SESSION.load(Acquire) != 0 && len > 0;
    let device = core::str::from_utf8(&DEVICE_ID).unwrap_or("");
    let text = |value: Option<&[u8]>, fallback: &'static str| -> String {
        String::from(value.and_then(|v| core::str::from_utf8(v).ok()).unwrap_or(fallback))
    };
    let mut out = String::from("{\"state\":");
    out.push_str(if linked { "\"linked\"" } else { "\"searching\"" });
    let companion = if len > 0 {
        let mut c = String::from("{\"id\":");
        c.push_str(&text(member(ready, "id"), "\"\""));
        c.push_str(",\"name\":");
        c.push_str(&text(member(ready, "name"), "\"\""));
        c.push_str(",\"address\":\"usb\",\"port\":0}");
        Some(c)
    } else {
        None
    };
    out.push_str(",\"companion\":");
    match &companion {
        Some(c) if linked => out.push_str(c),
        _ => out.push_str("null"),
    }
    out.push_str(",\"paired\":[");
    if let Some(c) = &companion {
        out.push_str(c);
    }
    out.push_str("],\"device\":{\"id\":");
    push_json_str(&mut out, device);
    out.push_str(",\"name\":\"PSP\",\"model\":\"PSP\",\"address\":\"usb\"},\"pairing\":\"idle\",\"error\":");
    out.push_str(if linked || len == 0 { "\"\"" } else { "\"the companion on the USB share stopped answering\"" });
    out.push_str(",\"features\":");
    out.push_str(&if linked { text(member(ready, "features"), "[]") } else { String::from("[]") });
    out.push_str(",\"clock\":");
    out.push_str(&if len > 0 { text(member(ready, "clock"), "null") } else { String::from("null") });
    out.push('}');
    out
}

// ---- the worker ------------------------------------------------------------------

unsafe fn open(path: &[u8], write: bool) -> SceUid {
    sys::sceIoOpen(
        path.as_ptr(),
        if write {
            IoOpenFlags::WR_ONLY | IoOpenFlags::CREAT | IoOpenFlags::TRUNC
        } else {
            IoOpenFlags::RD_ONLY
        },
        0o666,
    )
}

unsafe fn read_all(fd: SceUid, into: *mut u8, len: usize) -> bool {
    let mut n = 0;
    while n < len {
        let k = sys::sceIoRead(fd, into.add(n) as *mut c_void, (len - n).min(32768) as u32);
        if k <= 0 {
            return false;
        }
        n += k as usize;
    }
    true
}

unsafe fn write_all(fd: SceUid, from: *const u8, len: usize) -> bool {
    let mut n = 0;
    while n < len {
        let k = sys::sceIoWrite(fd, from.add(n) as *const c_void, (len - n).min(32768));
        if k <= 0 {
            return false;
        }
        n += k as usize;
    }
    true
}

/// `host0:/pocket-link/<name>`, NUL-terminated.
pub fn path(name: &[u8]) -> [u8; 48] {
    let mut out = [0u8; 48];
    let prefix = b"host0:/pocket-link/";
    out[..prefix.len()].copy_from_slice(prefix);
    out[prefix.len()..prefix.len() + name.len()].copy_from_slice(name);
    out
}

fn slot_file(index: usize, reply: bool) -> [u8; 48] {
    let mut name = *b"net0.req";
    name[3] = b'0' + index as u8;
    if reply {
        name[5..8].copy_from_slice(b"res");
    }
    path(&name)
}

/// Write a record of `json` with no body: hello and cancel records.
unsafe fn write_small(file: &[u8], epoch: u32, seq: u32, kind: u32, id: u32, beat: u32, json: &[u8]) -> bool {
    let mut head = [0u8; HEADER];
    for (at, value) in [
        (0, MAGIC),
        (4, epoch),
        (8, BOOT),
        (12, seq),
        (16, kind),
        (20, id),
        (24, beat),
        (32, json.len() as u32),
        (36, fnv1a32(json)),
        (40, 0),
        (44, fnv1a32(&[])),
    ] {
        put(&mut head, at, value);
    }
    let fd = open(file, true);
    if fd.0 < 0 {
        return false;
    }
    let ok = write_all(fd, head.as_ptr(), HEADER) && write_all(fd, json.as_ptr(), json.len());
    sys::sceIoClose(fd);
    ok
}

/// The beating companion's epoch, 0 while none beats (any thread).
pub fn epoch() -> u32 {
    EPOCH.load(Acquire)
}

/// Write `media.req` (contracts/spec/link.ts "Media") for stream
/// `generation`: open the ticket `token` names, or close with None. Any
/// thread; false with no companion or when the write fails.
///
/// # Safety
/// After start().
pub unsafe fn media_request(generation: u32, token: Option<&[u8; 64]>) -> bool {
    let epoch = EPOCH.load(Acquire);
    if epoch == 0 {
        return false;
    }
    let mut json = [0u8; 96];
    let open = b"{\"t\":\"media\"";
    json[..open.len()].copy_from_slice(open);
    let mut len = open.len();
    if let Some(token) = token {
        let key = b",\"token\":\"";
        json[len..len + key.len()].copy_from_slice(key);
        len += key.len();
        json[len..len + 64].copy_from_slice(token);
        len += 64;
        json[len] = b'"';
        len += 1;
    }
    json[len] = b'}';
    len += 1;
    write_small(&path(b"media.req"), epoch, generation, KIND_MEDIA, 0, 0, &json[..len])
}

/// The companion's `ready` record into `status`: (epoch, beat, json length).
unsafe fn read_ready(status: &mut [u8; STATUS_MAX]) -> Option<(u32, u32, usize)> {
    let fd = open(&path(b"ready"), false);
    if fd.0 < 0 {
        return None;
    }
    let mut head = [0u8; HEADER];
    let mut out = None;
    if read_all(fd, head.as_mut_ptr(), HEADER) && word(&head, 0) == MAGIC && word(&head, 16) == KIND_READY {
        let len = word(&head, 32) as usize;
        if word(&head, 4) != 0 && len <= STATUS_MAX && read_all(fd, status.as_mut_ptr(), len) && fnv1a32(&status[..len]) == word(&head, 36) {
            out = Some((word(&head, 4), word(&head, 24), len));
        }
    }
    sys::sceIoClose(fd);
    out
}

unsafe fn publish_status(json: &[u8]) {
    STATUS_SEQ.fetch_add(1, Release);
    let shared = &mut *STATUS.0.get();
    shared[..json.len()].copy_from_slice(json);
    STATUS_LEN.store(json.len() as u32, Release);
    STATUS_SEQ.fetch_add(1, Release);
}

/// Every request the worker holds of an ended session is lost.
fn lose_requests() {
    for slot in &SLOTS_STATE {
        for state in [QUEUED, SENT] {
            let _ = slot.state.compare_exchange(state, LOST, Release, Relaxed);
        }
    }
}

/// The reply for a SENT slot, if the companion wrote it: true once READY.
unsafe fn read_reply(index: usize, epoch: u32) -> bool {
    let slot = &SLOTS_STATE[index];
    let shared = &mut *slot.data.get();
    let fd = open(&slot_file(index, true), false);
    if fd.0 < 0 {
        return false;
    }
    let mut head = [0u8; HEADER];
    let mut ready = false;
    if read_all(fd, head.as_mut_ptr(), HEADER)
        && word(&head, 0) == MAGIC
        && word(&head, 4) == epoch
        && word(&head, 8) == BOOT
        && word(&head, 12) == shared.seq
        && word(&head, 16) == KIND_REPLY
    {
        let json_len = word(&head, 32) as usize;
        let body_len = word(&head, 40) as usize;
        if json_len > shared.json_cap || body_len > shared.body_cap {
            shared.oversize = true;
            ready = true;
        } else if read_all(fd, shared.json, json_len)
            && read_all(fd, shared.body, body_len)
            && fnv1a32(core::slice::from_raw_parts(shared.json, json_len)) == word(&head, 36)
            && fnv1a32(core::slice::from_raw_parts(shared.body, body_len)) == word(&head, 44)
        {
            shared.json_len = json_len;
            shared.body_len = body_len;
            ready = true;
        }
    }
    sys::sceIoClose(fd);
    ready && slot.state.compare_exchange(SENT, READY, Release, Relaxed).is_ok()
}

unsafe extern "C" fn worker(_: usize, _: *mut c_void) -> i32 {
    let mut status = [0u8; STATUS_MAX];
    let mut epoch = FIRST_EPOCH;
    let mut beat = FIRST_BEAT;
    let mut beat_at = now();
    let mut ready_at = 0u32;
    let mut hello_at = 0u32;
    let mut hello_beat = 0u32;
    let mut hello_due = epoch != 0;
    let mut generation = if epoch != 0 { 1u32 } else { 0 };
    let mut written = [false; SLOTS];
    loop {
        let t = now();
        if t.wrapping_sub(ready_at) >= BEAT_US / 5 {
            ready_at = t;
            match read_ready(&mut status) {
                Some((e, b, len)) => {
                    if e != epoch {
                        epoch = e;
                        EPOCH.store(0, Release);
                        SESSION.store(0, Release);
                        lose_requests();
                        generation = (generation.wrapping_add(1)).max(1);
                        written = [false; SLOTS];
                        beat_at = t;
                        hello_due = true;
                        publish_status(&status[..len]);
                        SESSION.store(generation, Release);
                        EPOCH.store(epoch, Release);
                    }
                    if b != beat {
                        beat = b;
                        beat_at = t;
                        publish_status(&status[..len]);
                    }
                }
                None => {}
            }
            if epoch != 0 && t.wrapping_sub(beat_at) > SILENCE_US {
                epoch = 0;
                EPOCH.store(0, Release);
                SESSION.store(0, Release);
                lose_requests();
            }
        }
        if epoch != 0 && (hello_due || t.wrapping_sub(hello_at) >= 2 * BEAT_US) {
            hello_beat = hello_beat.wrapping_add(1);
            if write_small(&path(b"hello"), epoch, 0, KIND_HELLO, 0, hello_beat, &HELLO[..HELLO_LEN]) {
                hello_due = false;
                hello_at = t;
            }
        }
        for index in 0..SLOTS {
            let slot = &SLOTS_STATE[index];
            match slot.state.load(Acquire) {
                QUEUED if epoch != 0 => {
                    let shared = &mut *slot.data.get();
                    if shared.generation != generation {
                        let _ = slot.state.compare_exchange(QUEUED, LOST, Release, Relaxed);
                        continue;
                    }
                    let record = core::slice::from_raw_parts_mut(shared.record, shared.record_len);
                    put(record, 4, epoch);
                    let fd = open(&slot_file(index, false), true);
                    let ok = fd.0 >= 0 && write_all(fd, shared.record, shared.record_len);
                    if fd.0 >= 0 {
                        sys::sceIoClose(fd);
                    }
                    if ok {
                        written[index] = true;
                        let _ = slot.state.compare_exchange(QUEUED, SENT, Release, Relaxed);
                    }
                }
                SENT if epoch != 0 => {
                    read_reply(index, epoch);
                }
                CANCEL => {
                    let shared = &*slot.data.get();
                    if epoch != 0 && written[index] {
                        let id = word(core::slice::from_raw_parts(shared.record, HEADER), 20);
                        let mut json = [0u8; 40];
                        let head = b"{\"t\":\"net.cancel\",\"id\":";
                        json[..head.len()].copy_from_slice(head);
                        let mut digits = [0u8; 10];
                        let id_text = decimal(id, &mut digits);
                        json[head.len()..head.len() + id_text.len()].copy_from_slice(id_text);
                        let len = head.len() + id_text.len() + 1;
                        json[len - 1] = b'}';
                        write_small(&slot_file(index, false), epoch, shared.seq, KIND_CANCEL, id, 0, &json[..len]);
                    }
                    written[index] = false;
                    slot.state.store(CANCELLED, Release);
                }
                _ => {}
            }
        }
        sys::sceKernelDelayThread(5000);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn member_reads_top_level_values_only() {
        let json = br#"{"v":1,"id":"ab\"c","nested":{"id":"no"},"features":["net"],"clock":{"utc":5,"offsetMinutes":480},"maxBytes":4096}"#;
        assert_eq!(member(json, "id"), Some(&br#""ab\"c""#[..]));
        assert_eq!(member(json, "features"), Some(&br#"["net"]"#[..]));
        assert_eq!(member(json, "clock"), Some(&br#"{"utc":5,"offsetMinutes":480}"#[..]));
        assert_eq!(number(member(json, "maxBytes")), Some(4096));
        assert_eq!(member(json, "missing"), None);
    }

    #[test]
    fn fnv_matches_the_companion() {
        // The companion's fnv1a32 (tools/companion/usb.ts) gives the same values.
        assert_eq!(fnv1a32(b""), 2166136261);
        assert_eq!(fnv1a32(b"a"), 0xe40c292c);
    }
}
