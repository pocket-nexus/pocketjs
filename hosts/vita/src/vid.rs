//! The video plane (spec ops 34..37) over the RAM `.pkst` ring (net.rs).
//!
//! Identical reader semantics to the PSP's file-backed vid.rs — the ring
//! image IS a `.pkst` file image (stream_rx.rs), parsed by the same
//! pocketjs_core::stream readers — minus the IO budget: "reads" are memcpys
//! under a short-held mutex, so a whole slot stages in one tick.
//!
//! The GXM discipline mirrors the PSP's GE one: videoTick only STAGES a
//! validated frame; present() commits it to the plane texture inside the
//! GPU-idle window (Runtime::render calls it right after begin_frame, whose
//! ensure_rendering_done() guarantees the previous scene finished sampling).

use pocketjs_core::spec::stream as st;
use pocketjs_core::spec::{img, psm};
use pocketjs_core::stream::{
    chunk_offset, parse_chunk_header, parse_header_block, parse_slot_header, slot_offset,
    StreamHeaders,
};
use pocketjs_core::Ui;

use crate::{audio, graphics, net, stats};

/// Whole audio chunks copied per tick (the RAM ring absorbs jitter).
const AUDIO_CHUNKS_PER_TICK: u32 = 4;

struct Session {
    /// Geometry pinned at open; per-tick reads refresh cursors/epoch/flags.
    geo: StreamHeaders,
    epoch: u32,
    /// The plane texture (core handle, PSM_T8 w x h, linear).
    tex: i32,
    /// palette + indices of a validated frame awaiting the GPU-idle window.
    staging: Vec<u8>,
    presented_seq: u32,
    presented_frame: i32,
    staged_frame: i32,
    staged_seq: u32,
    pending: bool,
    /// Next audio chunk seq to copy; 0 = sync to the writer's tail first.
    audio_next: u32,
    audio_on: bool,
}

static mut SESSION: Option<Session> = None;

/// spec op 34: bind to the announced RAM stream. The single ordered
/// connection guarantees streamOpen preceded the ctrl line that carried
/// `rel`, so the first try succeeds (the app does not retry videoOpen).
pub unsafe fn open(ui: &mut Ui, rel: &str) -> bool {
    close(ui);
    let Some(geo) = net::with_stream(|path, ram| {
        if path != rel {
            crate::vita_log(format_args!("[PocketJS vid] open {rel} vs announced {path}"));
        }
        parse_header_block(ram.buf())
    })
    .flatten() else {
        return false;
    };
    let (w, h) = (geo.video.w, geo.video.h);
    let px = (w * h) as usize;
    // Opaque black start (palette entry 0); linear — the plane draws scaled.
    let mut init = vec![0u8; 1024 + px];
    init[3] = 0xff;
    let tex = ui.upload_texture_flags(&init, w, h, psm::PSM_T8, img::FLAG_LINEAR);
    if tex < 0 {
        return false;
    }
    let audio_on = audio::start(geo.audio.sample_rate);
    SESSION = Some(Session {
        epoch: geo.epoch,
        geo,
        tex,
        staging: vec![0u8; 1024 + px],
        presented_seq: 0,
        presented_frame: -1,
        staged_frame: -1,
        staged_seq: 0,
        pending: false,
        audio_next: 0,
        audio_on,
    });
    true
}

/// spec op 36.
pub unsafe fn texture() -> i32 {
    SESSION.as_ref().map_or(-1, |s| s.tex)
}

/// spec op 35: the per-frame pump. Returns the presented source frame
/// index, -1 before the first one.
pub unsafe fn tick(_ui: &mut Ui) -> i32 {
    use core::sync::atomic::Ordering::Relaxed;
    let Some(s) = SESSION.as_mut() else { return -1 };

    let staged = net::with_stream(|_path, ram| {
        let buf = ram.buf();
        let Some(now) = parse_header_block(buf) else {
            return false;
        };

        // Discontinuity: drop queued audio + staged frame, resync to tail
        // (same reasoning as the PSP path — seq gates rewind on seeks).
        if now.epoch != s.epoch {
            s.epoch = now.epoch;
            s.presented_seq = 0;
            s.pending = false;
            s.audio_next = 0;
            audio::flush();
            stats::VID_EPOCHS.fetch_add(1, Relaxed);
        }

        // Audio top-up: whole chunks straight out of the ring image.
        if s.audio_on {
            let a = &now.audio;
            if s.audio_next == 0 && a.latest_seq > 0 {
                s.audio_next = a.latest_seq.saturating_sub(1).max(1);
            }
            if s.audio_next != 0 && a.latest_seq >= s.audio_next.saturating_add(a.chunk_count) {
                s.audio_next = a.latest_seq; // lapped: rejoin at the tail
                audio::flush();
            }
            for _ in 0..AUDIO_CHUNKS_PER_TICK {
                if s.audio_next == 0
                    || s.audio_next > a.latest_seq
                    || audio::free_frames() < a.chunk_frames as usize
                {
                    break;
                }
                let Some(off) = chunk_offset(&now, s.audio_next) else { break };
                let off = off as usize;
                match parse_chunk_header(&buf[off..]) {
                    Some(ch) if ch.seq == s.audio_next => {
                        let pcm_at = off + st::CHUNK_HEADER_SIZE;
                        let samples = (a.chunk_frames * a.channels) as usize;
                        let pcm = core::slice::from_raw_parts(
                            buf.as_ptr().add(pcm_at) as *const i16,
                            samples,
                        );
                        audio::push(pcm, a.channels);
                        s.audio_next += 1;
                    }
                    _ => {
                        s.audio_next = 0;
                        break;
                    }
                }
            }
        }

        // Video: stage the newest unpresented slot (one memcpy; no torn
        // reads over TCP, but the seq/geometry validation stays — it is the
        // shared contract, and epoch races remain real).
        let v = &now.video;
        if s.pending || v.latest_seq == 0 || v.latest_seq <= s.presented_seq {
            return false;
        }
        let seq = v.latest_seq;
        let Some(off) = slot_offset(&now, seq) else { return false };
        let off = off as usize;
        let Some(sh) = parse_slot_header(&buf[off..], &s.geo.video) else {
            return false;
        };
        if sh.seq != seq {
            return false;
        }
        let payload = &buf[off + st::SLOT_HEADER_SIZE..off + st::SLOT_HEADER_SIZE + s.staging.len()];
        s.staging.copy_from_slice(payload);
        s.staged_seq = seq;
        s.staged_frame = sh.frame_index as i32;
        true
    })
    .unwrap_or(false);

    if staged {
        s.pending = true;
    }
    s.presented_frame
}

/// Commit the staged frame to core texture storage before the runtime builds
/// its DrawList. The GXM driver owns the GPU copy and only rewrites an idle
/// cached allocation; pending GPU references retain their previous revision.
pub unsafe fn present(ui: &mut Ui) {
    let Some(s) = SESSION.as_mut() else { return };
    if !s.pending {
        return;
    }
    s.pending = false;
    let pal = &s.staging[..1024];
    let px = &s.staging[1024..];
    if ui.update_texture_t8(s.tex, pal, px) {
        // Mark the mirrored revision stale. The renderer selects the bounded
        // idle-update path when no submission still references the allocation.
        graphics::update_texture_in_place(ui, s.tex);
        s.presented_seq = s.staged_seq;
        s.presented_frame = s.staged_frame;
        stats::VID_PRESENTED.fetch_add(1, core::sync::atomic::Ordering::Relaxed);
    }
}

/// spec op 37: stop audio, free the plane (core + GPU mirror).
pub unsafe fn close(ui: &mut Ui) {
    let Some(s) = SESSION.take() else { return };
    audio::stop();
    ui.free_texture(s.tex);
    graphics::free_texture(s.tex);
}
