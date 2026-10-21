//! The video plane (spec ops 34..37): a host-written .pkst stream file
//! (spec.ts "STREAM container", parsed by pocketjs_core::stream) presented
//! as ONE core texture updated in place plus the audio ring (audio.rs).
//!
//! videoTick is a bounded per-frame IO pump on the JS/main thread — every
//! usbhostfs round trip happens here, never on the audio thread (one USB
//! pipe, one owner):
//!   1. one 96-byte header-block read (the writer's cursors + epoch),
//!   2. top up the PCM ring (whole chunks, capped per tick),
//!   3. continue the current video slot read (a 33 KB frame arrives over a
//!      few ticks; IO_BUDGET keeps the worst tick inside the 60 Hz frame),
//!   4. on completion validate the slot (seq re-read: a lapped slot is
//!      discarded, never presented) and overwrite the plane texture.
//!
//! All buffers are ordinary Vecs in cached main RAM — the usbhostfs DMA
//! constraint dbg::shot documents (VRAM addresses hang the device) is about
//! bulk writes, but reads stay in main RAM too: the GE-visible texture is
//! core-owned and dcache-written-back after each update.

use alloc::vec::Vec;
use core::ffi::c_void;

use pocketjs_core::spec::stream as st;
use pocketjs_core::spec::{img, psm};
use pocketjs_core::stream::{
    chunk_offset, chunk_size, parse_chunk_header, parse_header_block, parse_slot_header,
    slot_offset, StreamHeaders,
};
use pocketjs_core::Ui;
use psp::sys::{self, IoOpenFlags, IoWhence, SceUid};

use crate::{audio, ge, svc};

/// File-IO budget per tick, bytes. ~15 KB is the steady state for the tuned
/// stream (512x128@12 + 22.05 kHz stereo ≈ 0.87 MB/s); 26 KB drains a 65 KB
/// slot in three ticks so presentation keeps pace with the writer. Hardware
/// tuning knob (#9 on the wire).
const IO_BUDGET: usize = 26 * 1024;
/// Whole audio chunks read per tick, max.
const AUDIO_CHUNKS_PER_TICK: u32 = 2;

struct Session {
    fd: SceUid,
    /// Geometry pinned at open (w/h/rings never change within one file);
    /// per-tick reads refresh only cursors/epoch/flags.
    geo: StreamHeaders,
    epoch: u32,
    /// The plane texture (core handle, PSM_T8 w x h, linear).
    tex: i32,
    /// Slot bytes actually carried per frame (header + CLUT + w*h) — the
    /// slot's tail padding is never read.
    slot_bytes: usize,
    staging: Vec<u8>,
    staged: usize,
    /// Slot seq currently being read; 0 = idle.
    target_seq: u32,
    presented_seq: u32,
    presented_frame: i32,
    /// A validated frame sits in `staging` awaiting the GE-idle window
    /// (present() runs between sceGuSync and the next list — the GE samples
    /// the plane texture ASYNCHRONOUSLY through the whole JS frame, so an
    /// in-place update from tick() races the raster: with per-frame
    /// median-cut palettes any torn read renders as full-color noise,
    /// observed on hardware as constant flicker below the raster position).
    staged_seq: u32,
    staged_frame: i32,
    pending: bool,
    /// Next audio chunk seq to read; 0 = sync to the writer's tail first.
    audio_next: u32,
    chunk_buf: Vec<u8>,
    audio_on: bool,
}

static mut SESSION: Option<Session> = None;

/// Positional read: seek + read until `buf` is full. False on any short or
/// failed read (the stream file is preallocated to its full ring size by the
/// writer, so short reads are transport errors, not EOF semantics).
unsafe fn pread(fd: SceUid, off: u32, buf: &mut [u8]) -> bool {
    if sys::sceIoLseek(fd, off as i64, IoWhence::Set) != off as i64 {
        return false;
    }
    let mut got = 0usize;
    while got < buf.len() {
        let n = sys::sceIoRead(
            fd,
            buf.as_mut_ptr().add(got) as *mut c_void,
            (buf.len() - got) as u32,
        );
        if n <= 0 {
            return false;
        }
        got += n as usize;
    }
    crate::stats::VID_BYTES.fetch_add(buf.len() as u32, core::sync::atomic::Ordering::Relaxed);
    true
}

/// Open a stream (spec op videoOpen): svc-relative path, header validation,
/// plane allocation, audio spin-up. Any prior session is closed first.
pub unsafe fn open(ui: &mut Ui, rel: &str) -> bool {
    close(ui);
    if !svc::active() {
        return false;
    }
    let Some(path) = svc::side_path(rel) else { return false };
    let fd = sys::sceIoOpen(path.as_ptr(), IoOpenFlags::RD_ONLY, 0o777);
    if fd.0 < 0 {
        return false;
    }
    let mut hdr = [0u8; st::HEADER_BLOCK_SIZE];
    if !pread(fd, 0, &mut hdr) {
        sys::sceIoClose(fd);
        return false;
    }
    let Some(geo) = parse_header_block(&hdr) else {
        sys::sceIoClose(fd);
        return false;
    };
    let (w, h) = (geo.video.w, geo.video.h);
    let px = (w * h) as usize;
    // The plane starts as opaque black (palette entry 0) so the app can show
    // it immediately; linear sampling because the plane is drawn scaled.
    let mut init = alloc::vec![0u8; 1024 + px];
    init[3] = 0xff;
    let tex = ui.upload_texture_flags(&init, w, h, psm::PSM_T8, img::FLAG_LINEAR);
    if tex < 0 {
        sys::sceIoClose(fd);
        return false;
    }
    ge::writeback_texture(ui, tex);
    let slot_bytes = st::SLOT_HEADER_SIZE + 1024 + px;
    let chunk = chunk_size(geo.audio.chunk_frames, geo.audio.channels)
        .expect("validated by parse_header_block") as usize;
    let audio_on = audio::start(geo.audio.sample_rate);
    SESSION = Some(Session {
        fd,
        epoch: geo.epoch,
        geo,
        tex,
        slot_bytes,
        staging: alloc::vec![0u8; slot_bytes],
        staged: 0,
        target_seq: 0,
        presented_seq: 0,
        presented_frame: -1,
        staged_seq: 0,
        staged_frame: -1,
        pending: false,
        audio_next: 0,
        chunk_buf: alloc::vec![0u8; chunk],
        audio_on,
    });
    true
}

/// The plane texture handle (-1 when no stream is open).
pub unsafe fn texture() -> i32 {
    SESSION.as_ref().map_or(-1, |s| s.tex)
}

/// The per-frame pump (spec op videoTick). Returns the source frame index of
/// the presented frame, -1 before the first one. IO failures are treated as
/// transient (a stalled host shows the last good frame, the mailbox tells
/// the app more).
pub unsafe fn tick(ui: &mut Ui) -> i32 {
    let Some(s) = SESSION.as_mut() else { return -1 };
    let mut budget = IO_BUDGET;

    use core::sync::atomic::Ordering::Relaxed;

    // 1. Writer cursors.
    let mut hdr = [0u8; st::HEADER_BLOCK_SIZE];
    if !pread(s.fd, 0, &mut hdr) {
        crate::stats::VID_HDR_FAILS.fetch_add(1, Relaxed);
        return s.presented_frame;
    }
    budget -= st::HEADER_BLOCK_SIZE;
    let Some(now) = parse_header_block(&hdr) else { return s.presented_frame };

    // 2. Discontinuity: drop queued audio and in-flight reads, resync to tail.
    //    presented_seq resets too — slot seqs are source-frame indices, so a
    //    BACKWARD seek rewinds them, and gating on the old watermark would
    //    freeze the plane until playback re-passed it (observed on hardware:
    //    ◁ then pause/resume looked like "resume is broken").
    if now.epoch != s.epoch {
        s.epoch = now.epoch;
        s.target_seq = 0;
        s.staged = 0;
        s.presented_seq = 0;
        s.pending = false; // a staged pre-seek frame must not present
        s.audio_next = 0;
        audio::flush();
        crate::stats::VID_EPOCHS.fetch_add(1, Relaxed);
    }

    // 3. Audio top-up (whole chunks; the RAM ring absorbs jitter).
    if s.audio_on {
        let a = &now.audio;
        if s.audio_next == 0 && a.latest_seq > 0 {
            // Join near the tail: one chunk of history primes the ring
            // without replaying the past.
            s.audio_next = a.latest_seq.saturating_sub(1).max(1);
        }
        if s.audio_next != 0 && a.latest_seq >= s.audio_next.saturating_add(a.chunk_count) {
            // Lapped (long USB stall): skip to the freshest chunk.
            s.audio_next = a.latest_seq;
            audio::flush();
        }
        let chunk = s.chunk_buf.len();
        for _ in 0..AUDIO_CHUNKS_PER_TICK {
            if s.audio_next == 0
                || s.audio_next > a.latest_seq
                || budget < chunk
                || audio::free_frames() < a.chunk_frames as usize
            {
                break;
            }
            let Some(off) = chunk_offset(&now, s.audio_next) else { break };
            if !pread(s.fd, off, &mut s.chunk_buf) {
                break;
            }
            budget -= chunk;
            match parse_chunk_header(&s.chunk_buf) {
                Some(ch) if ch.seq == s.audio_next => {
                    let pcm = core::slice::from_raw_parts(
                        s.chunk_buf.as_ptr().add(st::CHUNK_HEADER_SIZE) as *const i16,
                        (a.chunk_frames * a.channels) as usize,
                    );
                    audio::push(pcm, a.channels);
                    s.audio_next += 1;
                }
                // Torn/lapped chunk: rejoin at the tail next tick.
                _ => {
                    s.audio_next = 0;
                    break;
                }
            }
        }
    }

    // 4. Video slot pump. While a validated frame awaits present() the
    //    staging buffer is spoken for — hold off on the next slot (at most
    //    one host-frame of extra latency at 60 Hz).
    let v = &now.video;
    if s.target_seq != 0 && v.latest_seq >= s.target_seq.saturating_add(v.slot_count) {
        // The writer lapped the slot mid-read; its bytes are torn. Restart.
        s.target_seq = 0;
        s.staged = 0;
        crate::stats::VID_LAPPED.fetch_add(1, Relaxed);
    }
    if !s.pending && s.target_seq == 0 && v.latest_seq > s.presented_seq {
        s.target_seq = v.latest_seq;
        s.staged = 0;
    }
    if !s.pending && s.target_seq != 0 {
        if let Some(base) = slot_offset(&now, s.target_seq) {
            let want = (s.slot_bytes - s.staged).min(budget);
            if want > 0 {
                let staged = s.staged;
                if pread(s.fd, base + staged as u32, &mut s.staging[staged..staged + want]) {
                    s.staged += want;
                }
            }
            if s.staged == s.slot_bytes {
                // Complete: validate the header we started with, then re-read
                // the live seq — if the writer touched this slot during our
                // chunked read, the frame is torn and must not be presented.
                let parsed = parse_slot_header(&s.staging, &s.geo.video)
                    .filter(|sh| sh.seq == s.target_seq);
                let mut live_seq = [0u8; 4];
                let fresh = parsed.is_some()
                    && pread(s.fd, base, &mut live_seq)
                    && u32::from_le_bytes(live_seq) == s.target_seq;
                if fresh {
                    let sh = parsed.expect("checked by fresh");
                    // Do NOT touch the texture here: the GE is still
                    // executing the previous list and samples the plane
                    // asynchronously. present() commits from staging inside
                    // the GE-idle window.
                    s.staged_seq = s.target_seq;
                    s.staged_frame = sh.frame_index as i32;
                    s.pending = true;
                } else {
                    crate::stats::VID_TORN.fetch_add(1, Relaxed);
                }
                s.target_seq = 0;
                s.staged = 0;
            }
        } else {
            s.target_seq = 0;
            s.staged = 0;
        }
    }

    s.presented_frame
}

/// Commit the staged frame to the plane texture. MUST be called with the GE
/// idle (main.rs invokes it between sceGuSync and the next sceGuStart) — the
/// texture is sampled in place, so this is the only race-free window.
pub unsafe fn present(ui: &mut Ui) {
    let Some(s) = SESSION.as_mut() else { return };
    if !s.pending {
        return;
    }
    s.pending = false;
    let pal = &s.staging[st::SLOT_HEADER_SIZE..st::SLOT_HEADER_SIZE + 1024];
    let px = &s.staging[st::SLOT_HEADER_SIZE + 1024..s.slot_bytes];
    if ui.update_texture_t8(s.tex, pal, px) {
        ge::writeback_texture(ui, s.tex);
        s.presented_seq = s.staged_seq;
        s.presented_frame = s.staged_frame;
        crate::stats::VID_PRESENTED.fetch_add(1, core::sync::atomic::Ordering::Relaxed);
    }
}

/// Tear down (spec op videoClose): stop audio, close the file, free the
/// plane (a still-mounted image node holding the stale handle draws nothing
/// — the generation tag covers the app's teardown order).
pub unsafe fn close(ui: &mut Ui) {
    let Some(s) = SESSION.take() else { return };
    audio::stop();
    sys::sceIoClose(s.fd);
    ui.free_texture(s.tex);
}
