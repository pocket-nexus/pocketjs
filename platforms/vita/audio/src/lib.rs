#![allow(static_mut_refs)]
//! PCM output for the video plane: one BGM port at 44.1 kHz fed by a
//! dedicated thread from an in-RAM SPSC ring — the PSP audio.rs design with
//! sceAudioOut in place of sceAudioCh and std::thread in place of raw kernel
//! threads. The integer upsample path is kept (a PSP-profile 22.05 kHz
//! stream still plays if the host ever serves one); the Vita profile streams
//! native 44.1 kHz, so k = 1 and the interpolator is pass-through.
//!
//! Same disciplines that were earned on PSP hardware:
//!   - single writer (main thread, vid::tick) + single reader (audio thread)
//!     over absolute frame counters with release/acquire publication;
//!   - starvation sleeps instead of queueing silence (resume latency is one
//!     block, not a queue of hush);
//!   - the PORT is opened and released on the MAIN thread (the channel-leak
//!     class of bug: release-from-the-audio-thread left the channel held).

use core::ffi::c_void;
use core::sync::atomic::{AtomicBool, AtomicI32, AtomicUsize, Ordering};

use vitasdk_sys::{
    sceAudioOutOpenPort, sceAudioOutOutput, sceAudioOutReleasePort, sceKernelDelayThread,
    SCE_AUDIO_OUT_MODE_STEREO, SCE_AUDIO_OUT_PORT_TYPE_BGM,
};

pub mod stats;

/// Output frames per port submit at 44.1 kHz (~23 ms per block).
const BLOCK_OUT: usize = 1024;
/// In-RAM ring capacity in SOURCE sample frames (~743 ms at 44.1 kHz).
const RING_FRAMES: usize = 32 * 1024;

static mut RING: [i16; RING_FRAMES * 2] = [0; RING_FRAMES * 2];
static mut OUT: [i16; BLOCK_OUT * 2] = [0; BLOCK_OUT * 2];

static WRITE_POS: AtomicUsize = AtomicUsize::new(0);
static READ_POS: AtomicUsize = AtomicUsize::new(0);
static RUN: AtomicBool = AtomicBool::new(false);
static LIVE: AtomicBool = AtomicBool::new(false);
/// Open BGM port id (-1 = none). Owned by the main thread.
static PORT: AtomicI32 = AtomicI32::new(-1);
/// Integer upsample factor to 44.1 kHz.
static UPSAMPLE: AtomicUsize = AtomicUsize::new(1);

fn upsample_factor(sample_rate: u32) -> Option<usize> {
    match sample_rate {
        44100 => Some(1),
        22050 => Some(2),
        11025 => Some(4),
        _ => None,
    }
}

fn audio_thread() {
    let mut prev_l: i32 = 0;
    let mut prev_r: i32 = 0;
    while RUN.load(Ordering::Acquire) {
        let k = UPSAMPLE.load(Ordering::Relaxed).max(1);
        let need = BLOCK_OUT / k;
        let read = READ_POS.load(Ordering::Relaxed);
        let avail = WRITE_POS.load(Ordering::Acquire).wrapping_sub(read);
        if avail < need {
            stats::AUDIO_STARVED.fetch_add(1, Ordering::Relaxed);
            unsafe { sceKernelDelayThread(4_000) };
            continue;
        }
        unsafe {
            for i in 0..need {
                let src = ((read + i) % RING_FRAMES) * 2;
                let l = RING[src] as i32;
                let r = RING[src + 1] as i32;
                match k {
                    1 => {
                        OUT[i * 2] = l as i16;
                        OUT[i * 2 + 1] = r as i16;
                    }
                    2 => {
                        OUT[i * 4] = ((prev_l + l) >> 1) as i16;
                        OUT[i * 4 + 1] = ((prev_r + r) >> 1) as i16;
                        OUT[i * 4 + 2] = l as i16;
                        OUT[i * 4 + 3] = r as i16;
                    }
                    _ => {
                        for step in 0..4 {
                            let t = step as i32 + 1;
                            let o = (i * 4 + step) * 2;
                            OUT[o] = ((prev_l * (4 - t) + l * t) >> 2) as i16;
                            OUT[o + 1] = ((prev_r * (4 - t) + r * t) >> 2) as i16;
                        }
                    }
                }
                prev_l = l;
                prev_r = r;
            }
        }
        READ_POS.store(read.wrapping_add(need), Ordering::Release);
        let port = PORT.load(Ordering::Relaxed);
        if port >= 0 {
            // Blocking: parks this thread until the hardware drains a block.
            unsafe { sceAudioOutOutput(port, OUT.as_ptr() as *const c_void) };
        }
    }
    LIVE.store(false, Ordering::Release);
}

/// Open the BGM port and start the output thread. Rates without an integer
/// path to 44.1 kHz are refused (video still plays, silently).
pub unsafe fn start(sample_rate: u32) -> bool {
    let Some(k) = upsample_factor(sample_rate) else {
        return false;
    };
    if LIVE.load(Ordering::Acquire) {
        stop();
    }
    WRITE_POS.store(0, Ordering::Relaxed);
    READ_POS.store(0, Ordering::Relaxed);
    UPSAMPLE.store(k, Ordering::Relaxed);
    let port = sceAudioOutOpenPort(
        SCE_AUDIO_OUT_PORT_TYPE_BGM as _,
        BLOCK_OUT as i32,
        44100,
        SCE_AUDIO_OUT_MODE_STEREO as _,
    );
    if port < 0 {
        stats::AUDIO_LAST_RESERVE_ERR.store(port, Ordering::Relaxed);
        return false;
    }
    PORT.store(port, Ordering::Relaxed);
    RUN.store(true, Ordering::Release);
    match std::thread::Builder::new()
        .name("pjs-audio".into())
        .stack_size(32 * 1024)
        .spawn(audio_thread)
    {
        Ok(_) => {
            LIVE.store(true, Ordering::Release);
            true
        }
        Err(_) => {
            RUN.store(false, Ordering::Release);
            sceAudioOutReleasePort(port);
            PORT.store(-1, Ordering::Relaxed);
            false
        }
    }
}

/// Signal the thread down, wait out its final blocking block (~23 ms), then
/// release the port from THIS thread.
pub unsafe fn stop() {
    if LIVE.load(Ordering::Acquire) {
        RUN.store(false, Ordering::Release);
        for _ in 0..250 {
            if !LIVE.load(Ordering::Acquire) {
                break;
            }
            sceKernelDelayThread(4_000);
        }
    }
    if !LIVE.load(Ordering::Acquire) {
        let port = PORT.swap(-1, Ordering::Relaxed);
        if port >= 0 {
            sceAudioOutReleasePort(port);
        }
    }
}

/// SOURCE sample frames the ring can still accept.
pub fn free_frames() -> usize {
    let queued = WRITE_POS
        .load(Ordering::Relaxed)
        .wrapping_sub(READ_POS.load(Ordering::Acquire));
    RING_FRAMES - queued.min(RING_FRAMES)
}

/// Queue interleaved s16 PCM at the SOURCE rate (mono upmixes to both ears).
pub unsafe fn push(pcm: &[i16], channels: u32) {
    let frames = match channels {
        1 => pcm.len(),
        2 => pcm.len() / 2,
        _ => return,
    };
    let n = frames.min(free_frames());
    let write = WRITE_POS.load(Ordering::Relaxed);
    for i in 0..n {
        let dst = ((write + i) % RING_FRAMES) * 2;
        if channels == 1 {
            RING[dst] = pcm[i];
            RING[dst + 1] = pcm[i];
        } else {
            RING[dst] = pcm[i * 2];
            RING[dst + 1] = pcm[i * 2 + 1];
        }
    }
    WRITE_POS.store(write.wrapping_add(n), Ordering::Release);
    stats::AUDIO_PUSHED_FRAMES.fetch_add(n as u32, Ordering::Relaxed);
}

/// Drop everything queued (seek/epoch discontinuity).
pub fn flush() {
    READ_POS.store(WRITE_POS.load(Ordering::Relaxed), Ordering::Release);
}
