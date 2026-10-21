//! App host-service mailbox over the PSPLINK usbhostfs share (spec.ts SVC;
//! ops 30..33). The DevTools transport (dbg.rs) generalized for product
//! apps: a companion process on the tethered machine owns
//! `pocket-svc/<app>/` — control rides JSON lines (`in.jsonl` host->device,
//! `out.jsonl` device->host), bulk bytes ride side files the protocol names
//! (IMG entries for loadImgFile, .pkst streams for videoOpen). Roots probed
//! at svcOpen: `host0:` (real hardware under PSPLINK), then `ms0:` (PPSSPP
//! maps it to the memstick dir — the emulator path needs no PSPLINK).
//!
//! Side-file paths from JS are svc-dir-relative and validated here: the
//! device never opens a path outside its svc directory.

use alloc::string::String;
use alloc::vec::Vec;
use core::ffi::c_void;

use psp::sys::{self, IoOpenFlags, IoWhence};

/// `host0:/pocket-svc/<app>` (no trailing slash) once open() succeeded.
static mut ROOT: Option<String> = None;
/// Byte offset into in.jsonl of the first unconsumed byte.
static mut READ_OFF: i64 = 0;

fn nul(path: &str) -> Vec<u8> {
    let mut p = Vec::with_capacity(path.len() + 1);
    p.extend_from_slice(path.as_bytes());
    p.push(0);
    p
}

/// App names keep to the pocket.json id-segment alphabet — anything else
/// could splice the probe path.
fn valid_app(app: &str) -> bool {
    !app.is_empty()
        && app.len() <= 64
        && app
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// Probe for the app's mailbox (spec op svcOpen). Skips any commands already
/// in in.jsonl from a previous run (starts reading at the current EOF) —
/// same cold-boot contract as dbg::init.
pub unsafe fn open(app: &str) -> bool {
    if !valid_app(app) {
        return false;
    }
    for root in ["host0:", "ms0:"] {
        let dir = alloc::format!("{}/pocket-svc/{}", root, app);
        let enable = nul(&alloc::format!("{}/enable", dir));
        let fd = sys::sceIoOpen(enable.as_ptr(), IoOpenFlags::RD_ONLY, 0o777);
        if fd.0 < 0 {
            continue;
        }
        sys::sceIoClose(fd);
        READ_OFF = 0;
        let input = nul(&alloc::format!("{}/in.jsonl", dir));
        let fd = sys::sceIoOpen(input.as_ptr(), IoOpenFlags::RD_ONLY, 0o777);
        if fd.0 >= 0 {
            READ_OFF = sys::sceIoLseek(fd, 0, IoWhence::End);
            sys::sceIoClose(fd);
        }
        ROOT = Some(dir);
        return true;
    }
    false
}

pub unsafe fn active() -> bool {
    ROOT.is_some()
}

/// Guest teardown (docs/LAUNCHER.md switch): drop the mailbox binding so the next
/// guest's svcOpen probes fresh — offsets from one app's in.jsonl must never
/// leak into another's.
pub unsafe fn reset() {
    ROOT = None;
    READ_OFF = 0;
}

/// Resolve a svc-dir-relative side-file path to a NUL-terminated device path.
/// Rejects absolute paths, drive prefixes, and `..` traversal — the host owns
/// the directory, the device only ever reads inside it.
pub unsafe fn side_path(rel: &str) -> Option<Vec<u8>> {
    let root = ROOT.as_ref()?;
    if rel.is_empty()
        || rel.len() > 256
        || rel.starts_with('/')
        || rel.contains(':')
        || rel.contains('\\')
        || rel
            .split('/')
            .any(|seg| seg.is_empty() || seg == "." || seg == "..")
    {
        return None;
    }
    Some(nul(&alloc::format!("{}/{}", root, rel)))
}

/// New bytes from in.jsonl since the last poll, cut at the last complete
/// line (dbg::poll with the svc buffer size — search-result lines are bigger
/// than DevTools commands, side files carry anything bigger still).
pub unsafe fn poll() -> Option<String> {
    let root = ROOT.as_ref()?;
    let input = nul(&alloc::format!("{}/in.jsonl", root));
    let fd = sys::sceIoOpen(input.as_ptr(), IoOpenFlags::RD_ONLY, 0o777);
    if fd.0 < 0 {
        return None;
    }
    // A restarted host truncates in.jsonl; a stale offset would read past
    // EOF forever (the bridge has the mirror defense on out.jsonl).
    let end = sys::sceIoLseek(fd, 0, IoWhence::End);
    if end < READ_OFF {
        READ_OFF = 0;
        crate::stats::SVC_TRUNC_RESETS.fetch_add(1, core::sync::atomic::Ordering::Relaxed);
    }
    sys::sceIoLseek(fd, READ_OFF, IoWhence::Set);
    let mut buf: Vec<u8> = alloc::vec![0u8; pocket_spec::svc::POLL_BUF];
    let n = sys::sceIoRead(fd, buf.as_mut_ptr() as *mut c_void, buf.len() as u32);
    sys::sceIoClose(fd);
    if n <= 0 {
        return None;
    }
    let read = &buf[..n as usize];
    let complete = match read.iter().rposition(|&b| b == b'\n') {
        Some(i) => i + 1,
        None => return None, // partial line: retry next poll
    };
    READ_OFF += complete as i64;
    Some(String::from_utf8_lossy(&read[..complete]).into_owned())
}

/// Append one JSON line to out.jsonl (the newline is added here).
pub unsafe fn send(msg: &[u8]) {
    let Some(root) = ROOT.as_ref() else { return };
    let out = nul(&alloc::format!("{}/out.jsonl", root));
    let fd = sys::sceIoOpen(
        out.as_ptr(),
        IoOpenFlags::WR_ONLY | IoOpenFlags::CREAT | IoOpenFlags::APPEND,
        0o777,
    );
    if fd.0 < 0 {
        return;
    }
    sys::sceIoWrite(fd, msg.as_ptr() as *const c_void, msg.len());
    sys::sceIoWrite(fd, b"\n".as_ptr() as *const c_void, 1);
    sys::sceIoClose(fd);
}

/// Read a whole side file (spec op loadImgFile's byte source), refusing
/// anything larger than `max` — oversize assets belong in the pak or a
/// stream, not a synchronous frame-path read.
pub unsafe fn read_side_file(rel: &str, max: usize) -> Option<Vec<u8>> {
    let path = side_path(rel)?;
    let fd = sys::sceIoOpen(path.as_ptr(), IoOpenFlags::RD_ONLY, 0o777);
    if fd.0 < 0 {
        return None;
    }
    let len = sys::sceIoLseek(fd, 0, IoWhence::End);
    if len <= 0 || len as usize > max {
        sys::sceIoClose(fd);
        return None;
    }
    sys::sceIoLseek(fd, 0, IoWhence::Set);
    let mut buf: Vec<u8> = alloc::vec![0u8; len as usize];
    let mut got = 0usize;
    while got < buf.len() {
        let n = sys::sceIoRead(
            fd,
            buf.as_mut_ptr().add(got) as *mut c_void,
            (buf.len() - got) as u32,
        );
        if n <= 0 {
            break;
        }
        got += n as usize;
    }
    sys::sceIoClose(fd);
    if got == buf.len() {
        Some(buf)
    } else {
        None
    }
}
