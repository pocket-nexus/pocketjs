//! The AUDIO MODULE for the PSP host — the console adoption of
//! contracts/spec/audio.ts (constants in pocket_spec::audio).
//!
//! This is the module's native embodiment, distinct from `audio.rs` (the
//! video plane's single-ring PCM path): up to MAX_STREAMS guest-owned
//! streams, each an SPSC stereo ring at its SOURCE rate, mixed by one
//! dedicated thread into a NORMAL 44.1 kHz hardware channel. Every
//! hardware rule is inherited from audio.rs, where it was earned on real
//! units: normal channel (the SRC resampler sizzles), integer-only
//! upsample with linear interpolation, dcache writeback before every
//! submit, channel reserved AND released on the main thread, starved
//! thread sleeps instead of queueing silence.
//!
//! Spec semantics on the real clock:
//!   - the mixer consumes on the device clock and NEVER touches the guest;
//!     it publishes facts as per-stream atomic edges (underrun, ended) and
//!     the read cursor itself;
//!   - `poll()` (main thread, inside the guest's single turn) turns those
//!     facts into the spec's JSON events by state-diffing: ended edge,
//!     underrun edge, then credit whenever free-frames drifted from the
//!     last value the guest saw. One event per call, slot order — the
//!     tick-batching rule falls out of the guest's own poll cadence;
//!   - `writePcm` copies out of the borrowed guest buffer before returning
//!     (mono is upmixed to stereo at write, same as audio.rs push).

use core::ffi::c_void;
use core::sync::atomic::{AtomicBool, AtomicI32, AtomicU32, AtomicUsize, Ordering};

use alloc::format;
use alloc::string::String;
use pocket_spec::audio as spec;
use psp::sys::{self, AudioFormat, ThreadAttributes};
use psp::Align16;

const MAX_STREAMS: usize = spec::MAX_STREAMS;
const RING_FRAMES: usize = spec::RING_FRAMES;
/// Output frames per hardware submit at 44.1 kHz (~23 ms per block).
const BLOCK_OUT: usize = 1024;

/// Per-stream stereo rings at the SOURCE rate (mono upmixed at write).
/// 16384 frames x 2 ch x 2 B x 4 streams = 256 KB of bss.
static mut RINGS: [[i16; RING_FRAMES * 2]; MAX_STREAMS] = [[0; RING_FRAMES * 2]; MAX_STREAMS];
static mut OUT: Align16<[i16; BLOCK_OUT * 2]> = Align16([0; BLOCK_OUT * 2]);
static mut MIX: [i32; BLOCK_OUT * 2] = [0; BLOCK_OUT * 2];
/// Interpolation carry per stream (audio thread only).
static mut PREV: [[i32; 2]; MAX_STREAMS] = [[0; 2]; MAX_STREAMS];
/// Last credit value the guest saw, per slot (main thread only).
static mut LAST_FREE: [usize; MAX_STREAMS] = [RING_FRAMES; MAX_STREAMS];

const ZERO_USIZE: AtomicUsize = AtomicUsize::new(0);
const ZERO_U32: AtomicU32 = AtomicU32::new(0);
const FULL_VOLUME: AtomicI32 = AtomicI32::new(256);
const FALSE: AtomicBool = AtomicBool::new(false);

/// Slot allocated (guest holds a live handle). Set LAST, with Release, at
/// createStream; cleared FIRST at destroy so the mixer skips the slot.
static LIVE: [AtomicBool; MAX_STREAMS] = [FALSE; MAX_STREAMS];
/// Handle generation per slot (stale-handle defense, ui node-id style).
static GEN: [AtomicU32; MAX_STREAMS] = [ZERO_U32; MAX_STREAMS];
/// Integer upsample factor to 44.1 kHz (1/2/4).
static UPSAMPLE: [AtomicUsize; MAX_STREAMS] = [ZERO_USIZE; MAX_STREAMS];
static CHANNELS: [AtomicUsize; MAX_STREAMS] = [ZERO_USIZE; MAX_STREAMS];
/// Absolute SOURCE frame counters (write: main thread; read: audio thread).
static WRITE_POS: [AtomicUsize; MAX_STREAMS] = [ZERO_USIZE; MAX_STREAMS];
static READ_POS: [AtomicUsize; MAX_STREAMS] = [ZERO_USIZE; MAX_STREAMS];
static PLAYING: [AtomicBool; MAX_STREAMS] = [FALSE; MAX_STREAMS];
static END_FLAGGED: [AtomicBool; MAX_STREAMS] = [FALSE; MAX_STREAMS];
static STARVED: [AtomicBool; MAX_STREAMS] = [FALSE; MAX_STREAMS];
/// Facts crossing audio thread -> main thread (edge-triggered, swap-cleared
/// by poll()).
static UNDERRUN_EDGE: [AtomicBool; MAX_STREAMS] = [FALSE; MAX_STREAMS];
static ENDED_EDGE: [AtomicBool; MAX_STREAMS] = [FALSE; MAX_STREAMS];
/// Volume as 0..=256 fixed point, applied at mix time on the audio thread.
static VOLUME: [AtomicI32; MAX_STREAMS] = [FULL_VOLUME; MAX_STREAMS];

// Engine (one hardware channel + one mixer thread for all streams).
static RUN: AtomicBool = AtomicBool::new(false);
static THREAD_LIVE: AtomicBool = AtomicBool::new(false);
static RESERVED: AtomicBool = AtomicBool::new(false);
static CHANNEL: AtomicI32 = AtomicI32::new(-1);

fn upsample_factor(sample_rate: u32) -> Option<usize> {
    match sample_rate {
        44100 => Some(1),
        22050 => Some(2),
        11025 => Some(4),
        _ => None,
    }
}

const fn handle_of(slot: usize, gen: u32) -> i32 {
    ((gen as i32) << 3) | slot as i32
}

/// Validate a guest handle -> slot. Stale generations and dead slots fail.
fn slot_of(handle: i32) -> Option<usize> {
    if handle < 0 {
        return None;
    }
    let slot = (handle & 7) as usize;
    if slot >= MAX_STREAMS || !LIVE[slot].load(Ordering::Acquire) {
        return None;
    }
    if GEN[slot].load(Ordering::Relaxed) != (handle >> 3) as u32 {
        return None;
    }
    Some(slot)
}

// ---------------------------------------------------------------------------
// mixer thread (the module's native clock)
// ---------------------------------------------------------------------------

unsafe extern "C" fn mixer_thread(_argc: usize, _argv: *mut c_void) -> i32 {
    while RUN.load(Ordering::Acquire) {
        MIX.fill(0);
        let mut contributed = false;
        for slot in 0..MAX_STREAMS {
            if !LIVE[slot].load(Ordering::Acquire) || !PLAYING[slot].load(Ordering::Acquire) {
                continue;
            }
            let k = UPSAMPLE[slot].load(Ordering::Relaxed).max(1);
            let need = BLOCK_OUT / k;
            let read = READ_POS[slot].load(Ordering::Relaxed);
            let avail = WRITE_POS[slot].load(Ordering::Acquire).wrapping_sub(read);
            let take = avail.min(need);
            let vol = VOLUME[slot].load(Ordering::Relaxed);
            for i in 0..take {
                let src = ((read + i) % RING_FRAMES) * 2;
                let l = (RINGS[slot][src] as i32 * vol) >> 8;
                let r = (RINGS[slot][src + 1] as i32 * vol) >> 8;
                // k output frames per source frame, stepping FROM the
                // previous frame so upsampled blocks join without a step.
                for step in 0..k {
                    let t = step as i32 + 1;
                    let o = (i * k + step) * 2;
                    MIX[o] += (PREV[slot][0] * (k as i32 - t) + l * t) / k as i32;
                    MIX[o + 1] += (PREV[slot][1] * (k as i32 - t) + r * t) / k as i32;
                }
                PREV[slot][0] = l;
                PREV[slot][1] = r;
            }
            READ_POS[slot].store(read.wrapping_add(take), Ordering::Release);
            if take > 0 {
                contributed = true;
            }
            if take < need {
                if END_FLAGGED[slot].load(Ordering::Acquire) && avail == take {
                    // Drained after endStream: auto-pause + one ended fact.
                    PLAYING[slot].store(false, Ordering::Release);
                    END_FLAGGED[slot].store(false, Ordering::Relaxed);
                    ENDED_EDGE[slot].store(true, Ordering::Release);
                } else if !STARVED[slot].swap(true, Ordering::AcqRel) {
                    UNDERRUN_EDGE[slot].store(true, Ordering::Release);
                }
            } else {
                STARVED[slot].store(false, Ordering::Relaxed);
            }
        }
        if !contributed {
            // Nothing to say: sleep instead of queueing silence, so resume
            // latency is one block, not a queue of hush (audio.rs rule).
            sys::sceKernelDelayThread(4_000);
            continue;
        }
        for i in 0..BLOCK_OUT * 2 {
            OUT.0[i] = MIX[i].clamp(i16::MIN as i32, i16::MAX as i32) as i16;
        }
        // The hardware may DMA straight from this buffer (audio.rs rule).
        sys::sceKernelDcacheWritebackRange(
            OUT.0.as_ptr() as *const c_void,
            (BLOCK_OUT * 2 * 2) as u32,
        );
        let ch = CHANNEL.load(Ordering::Relaxed);
        sys::sceAudioOutputPannedBlocking(
            ch,
            sys::AUDIO_VOLUME_MAX as i32,
            sys::AUDIO_VOLUME_MAX as i32,
            OUT.0.as_mut_ptr() as *mut c_void,
        );
    }
    THREAD_LIVE.store(false, Ordering::Release);
    sys::sceKernelExitDeleteThread(0);
    0
}

/// Reserve the channel + start the mixer on first use. Main thread only.
unsafe fn ensure_engine() -> bool {
    if THREAD_LIVE.load(Ordering::Acquire) {
        return true;
    }
    if !RESERVED.load(Ordering::Acquire) {
        let ch = sys::sceAudioChReserve(
            sys::AUDIO_NEXT_CHANNEL,
            BLOCK_OUT as i32,
            AudioFormat::Stereo,
        );
        if ch < 0 {
            return false;
        }
        CHANNEL.store(ch, Ordering::Relaxed);
        RESERVED.store(true, Ordering::Release);
    }
    RUN.store(true, Ordering::Release);
    let id = sys::sceKernelCreateThread(
        b"pocketjs_audio_mod\0".as_ptr(),
        mixer_thread,
        16, // above the JS worker: a missed block is audible, a late frame is not
        32 * 1024,
        ThreadAttributes::USER,
        core::ptr::null_mut(),
    );
    if id.0 < 0 {
        RUN.store(false, Ordering::Release);
        return false;
    }
    THREAD_LIVE.store(true, Ordering::Release);
    sys::sceKernelStartThread(id, 0, core::ptr::null_mut());
    true
}

// ---------------------------------------------------------------------------
// guest-facing ops (main thread — called from the ffi table)
// ---------------------------------------------------------------------------

pub unsafe fn create_stream(sample_rate: u32, channels: u32) -> i32 {
    let Some(k) = upsample_factor(sample_rate) else {
        return -1;
    };
    if channels < 1 || channels > spec::MAX_CHANNELS {
        return -1;
    }
    let Some(slot) = (0..MAX_STREAMS).find(|&s| !LIVE[s].load(Ordering::Acquire)) else {
        return -1;
    };
    if !ensure_engine() {
        return -1;
    }
    WRITE_POS[slot].store(0, Ordering::Relaxed);
    READ_POS[slot].store(0, Ordering::Relaxed);
    PLAYING[slot].store(false, Ordering::Relaxed);
    END_FLAGGED[slot].store(false, Ordering::Relaxed);
    STARVED[slot].store(false, Ordering::Relaxed);
    UNDERRUN_EDGE[slot].store(false, Ordering::Relaxed);
    ENDED_EDGE[slot].store(false, Ordering::Relaxed);
    UPSAMPLE[slot].store(k, Ordering::Relaxed);
    CHANNELS[slot].store(channels as usize, Ordering::Relaxed);
    VOLUME[slot].store(256, Ordering::Relaxed);
    PREV[slot] = [0; 2];
    LAST_FREE[slot] = RING_FRAMES;
    let gen = GEN[slot].fetch_add(1, Ordering::Relaxed).wrapping_add(1);
    LIVE[slot].store(true, Ordering::Release);
    handle_of(slot, gen)
}

pub unsafe fn destroy_stream(handle: i32) {
    let Some(slot) = slot_of(handle) else { return };
    PLAYING[slot].store(false, Ordering::Release);
    LIVE[slot].store(false, Ordering::Release);
}

/// Copy interleaved s16 at the SOURCE rate into the slot's ring (borrow
/// semantics: fully consumed before return). Returns frames accepted.
pub unsafe fn write_pcm(handle: i32, pcm: &[i16]) -> i32 {
    let Some(slot) = slot_of(handle) else {
        return 0;
    };
    let ch = CHANNELS[slot].load(Ordering::Relaxed).max(1);
    let frames = pcm.len() / ch;
    let write = WRITE_POS[slot].load(Ordering::Relaxed);
    let queued = write.wrapping_sub(READ_POS[slot].load(Ordering::Acquire));
    let n = frames.min(RING_FRAMES - queued.min(RING_FRAMES));
    for i in 0..n {
        let dst = ((write + i) % RING_FRAMES) * 2;
        if ch == 1 {
            RINGS[slot][dst] = pcm[i];
            RINGS[slot][dst + 1] = pcm[i];
        } else {
            RINGS[slot][dst] = pcm[i * 2];
            RINGS[slot][dst + 1] = pcm[i * 2 + 1];
        }
    }
    WRITE_POS[slot].store(write.wrapping_add(n), Ordering::Release);
    // Keep the credit mirror honest. LAST_FREE models "the free count the
    // guest last saw", and the guest subtracts what it wrote from its own
    // mirror (music.ts `this.free -= accepted`). Without this line the two
    // mirrors diverge by every accepted frame, and when the mixer happens to
    // drain the ring completely between two polls, poll() reads
    // free == LAST_FREE == RING_FRAMES both times, sends no credit, and the
    // guest's mirror decays monotonically until `want <= 0` and it stops
    // feeding — silently, forever. Symptom: audio plays for a couple of
    // seconds and stops. Only reachable when the guest actually writes PCM.
    LAST_FREE[slot] = LAST_FREE[slot].saturating_sub(n);
    n as i32
}

pub unsafe fn play(handle: i32) {
    if let Some(slot) = slot_of(handle) {
        STARVED[slot].store(false, Ordering::Relaxed);
        PLAYING[slot].store(true, Ordering::Release);
    }
}

pub unsafe fn pause(handle: i32) {
    if let Some(slot) = slot_of(handle) {
        PLAYING[slot].store(false, Ordering::Release);
    }
}

/// Pause + flush (writer-side cursor jump; the racing-reader block is the
/// same benign race audio.rs::flush documents).
pub unsafe fn stop(handle: i32) {
    if let Some(slot) = slot_of(handle) {
        PLAYING[slot].store(false, Ordering::Release);
        READ_POS[slot].store(WRITE_POS[slot].load(Ordering::Relaxed), Ordering::Release);
        END_FLAGGED[slot].store(false, Ordering::Relaxed);
        STARVED[slot].store(false, Ordering::Relaxed);
    }
}

pub unsafe fn set_volume(handle: i32, volume: f64) {
    if let Some(slot) = slot_of(handle) {
        let v = (volume.clamp(0.0, 1.0) * 256.0) as i32;
        VOLUME[slot].store(v, Ordering::Relaxed);
    }
}

pub unsafe fn end_stream(handle: i32) {
    if let Some(slot) = slot_of(handle) {
        END_FLAGGED[slot].store(true, Ordering::Release);
    }
}

/// One spec event per call (svcPoll convention): slot order, within a slot
/// ended > underrun > credit-drift. None = batch drained.
pub unsafe fn poll() -> Option<String> {
    for slot in 0..MAX_STREAMS {
        if !LIVE[slot].load(Ordering::Acquire) {
            continue;
        }
        let h = handle_of(slot, GEN[slot].load(Ordering::Relaxed));
        if ENDED_EDGE[slot].swap(false, Ordering::AcqRel) {
            return Some(format!("{{\"t\":\"ended\",\"h\":{}}}", h));
        }
        if UNDERRUN_EDGE[slot].swap(false, Ordering::AcqRel) {
            return Some(format!("{{\"t\":\"underrun\",\"h\":{}}}", h));
        }
        let queued = WRITE_POS[slot]
            .load(Ordering::Relaxed)
            .wrapping_sub(READ_POS[slot].load(Ordering::Acquire));
        let free = RING_FRAMES - queued.min(RING_FRAMES);
        if free != LAST_FREE[slot] {
            LAST_FREE[slot] = free;
            return Some(format!(
                "{{\"t\":\"credit\",\"h\":{},\"free\":{}}}",
                h, free
            ));
        }
    }
    None
}

/// Guest swap teardown: every stream dies with its guest. The mixer thread
/// and the channel stay for the next guest (the thread idles at 4 ms/loop).
pub fn reset() {
    for slot in 0..MAX_STREAMS {
        PLAYING[slot].store(false, Ordering::Release);
        LIVE[slot].store(false, Ordering::Release);
    }
}
