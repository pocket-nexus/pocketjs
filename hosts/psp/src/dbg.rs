//! DevTools mailbox transport over the PSPLINK usbhostfs share (docs/DEVTOOLS.md
//! §3). The desktop bridge (tools/devtools-psp.ts) appends JSON lines to
//! `pocketjs-dbg/in.jsonl` and tails `pocketjs-dbg/out.jsonl`; we read the
//! former from a running offset and append to the latter. Roots probed at
//! boot: `host0:` (real hardware under PSPLINK), then `ms0:` (PPSSPP GUI
//! maps it to the memstick dir). Active only if `pocketjs-dbg/enable`
//! exists — otherwise boot costs two failed sceIoOpen calls and the app
//! never touches IO again. QuickJS sees this as `ui.__dbgPoll/__dbgSend`
//! (ffi.rs); the JS shim rate-limits polls to every ~10 frames.

use alloc::string::String;
use alloc::vec::Vec;
use core::ffi::c_void;

use psp::sys::{self, IoOpenFlags, IoWhence};

const H0_ENABLE: &[u8] = b"host0:/pocketjs-dbg/enable\0";
const H0_IN: &[u8] = b"host0:/pocketjs-dbg/in.jsonl\0";
const H0_OUT: &[u8] = b"host0:/pocketjs-dbg/out.jsonl\0";
const MS_ENABLE: &[u8] = b"ms0:/pocketjs-dbg/enable\0";
const MS_IN: &[u8] = b"ms0:/pocketjs-dbg/in.jsonl\0";
const MS_OUT: &[u8] = b"ms0:/pocketjs-dbg/out.jsonl\0";
const H0_SHOT: &[u8] = b"host0:/pocketjs-dbg/shot.raw\0";
const MS_SHOT: &[u8] = b"ms0:/pocketjs-dbg/shot.raw\0";

/// Max bytes consumed per poll; longer backlogs drain over several polls.
const POLL_BUF: usize = 4096;

static mut ACTIVE: bool = false;
static mut USE_MS0: bool = false;
/// Byte offset into in.jsonl of the first unconsumed byte.
static mut READ_OFF: i64 = 0;

/// Probe for the mailbox once at boot. Skips any commands already in
/// in.jsonl from a previous run (starts reading at the current EOF).
pub unsafe fn init() -> bool {
    for (enable, input, ms0) in [(H0_ENABLE, H0_IN, false), (MS_ENABLE, MS_IN, true)] {
        let fd = sys::sceIoOpen(enable.as_ptr(), IoOpenFlags::RD_ONLY, 0o777);
        if fd.0 >= 0 {
            sys::sceIoClose(fd);
            ACTIVE = true;
            USE_MS0 = ms0;
            let fd = sys::sceIoOpen(input.as_ptr(), IoOpenFlags::RD_ONLY, 0o777);
            if fd.0 >= 0 {
                READ_OFF = sys::sceIoLseek(fd, 0, IoWhence::End);
                sys::sceIoClose(fd);
            }
            return true;
        }
    }
    false
}

pub unsafe fn active() -> bool {
    ACTIVE
}

/// New bytes from in.jsonl since the last poll, cut at the last complete
/// line (a line the bridge is mid-writing stays for the next poll).
pub unsafe fn poll() -> Option<String> {
    if !ACTIVE {
        return None;
    }
    let path = if USE_MS0 { MS_IN } else { H0_IN };
    let fd = sys::sceIoOpen(path.as_ptr(), IoOpenFlags::RD_ONLY, 0o777);
    if fd.0 < 0 {
        return None;
    }
    sys::sceIoLseek(fd, READ_OFF, IoWhence::Set);
    let mut buf: Vec<u8> = alloc::vec![0u8; POLL_BUF];
    let n = sys::sceIoRead(fd, buf.as_mut_ptr() as *mut c_void, POLL_BUF as u32);
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

/// On-demand screenshot (docs/DEVTOOLS.md): dump the just-presented display
/// framebuffer to `pocketjs-dbg/shot.raw` (512-stride RGBA top-down, read
/// via the uncached VRAM mirror — same technique as main.rs cap_dump_frame).
/// The desktop bridge converts it to PNG; the ~550 KB never crosses the
/// JSON mailbox. Returns true on success.
///
/// The pixels MUST bounce through main RAM: usbhostfs's send path runs
/// sceKernelDcacheWritebackRange + USB bulk DMA straight on the caller's
/// buffer (psplinkusb usbhostfs/main.c), and neither survives a VRAM
/// address — writing the 0x4xxxxxxx mirror directly wedges the first 64 KB
/// block and hangs the device (verified on hardware: shot.raw created,
/// zero bytes ever arrived). cap_dump_frame gets away with VRAM-direct
/// writes only because ms0: is the Memory Stick driver, not usbhostfs.
pub unsafe fn shot() -> bool {
    if !ACTIVE {
        return false;
    }
    let path = if USE_MS0 { MS_SHOT } else { H0_SHOT };
    let fd = sys::sceIoOpen(
        path.as_ptr(),
        IoOpenFlags::CREAT | IoOpenFlags::WR_ONLY | IoOpenFlags::TRUNC,
        0o777,
    );
    if fd.0 < 0 {
        return false;
    }
    // 16 rows per chunk: a 32 KB cached-RAM bounce buffer, 17 writes total.
    const ROW: usize = 512 * 4;
    const CHUNK_ROWS: usize = 16;
    let mut buf: Vec<u8> = alloc::vec![0u8; ROW * CHUNK_ROWS];
    let mut row = 0usize;
    let mut ok = true;
    while row < 272 {
        let rows = CHUNK_ROWS.min(272 - row);
        let n = ROW * rows;
        if !crate::host::read_display_rows_rgba(row, rows, &mut buf[..n]) {
            ok = false;
            break;
        }
        if sys::sceIoWrite(fd, buf.as_ptr() as *const c_void, n) != n as i32 {
            ok = false;
            break;
        }
        row += rows;
    }
    sys::sceIoClose(fd);
    ok
}

/// Append one JSON line to out.jsonl (the newline is added here).
pub unsafe fn send(msg: &[u8]) {
    if !ACTIVE {
        return;
    }
    let path = if USE_MS0 { MS_OUT } else { H0_OUT };
    let fd = sys::sceIoOpen(
        path.as_ptr(),
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
