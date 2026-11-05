//! PCM output for the video plane (spec.ts STREAM audio ring): one NORMAL
//! hardware channel at 44.1 kHz fed by a dedicated thread from an in-RAM
//! SPSC ring, with a software integer upsample from the stream's rate.
//!
//! Why not the SRC channel: the first hardware session produced a constant
//! sizzle under the (audible) audio — the SRC resampler path is a known
//! quirk pit on real units. The normal channel at the PSP's native 44.1 kHz
//! takes the hardware resampler out of the loop entirely; a 22.05 kHz
//! stream is exactly a 2x linear interpolation, done here in microseconds
//! per block. The output buffer is dcache-written-back before every submit
//! so the hardware never reads stale lines (same class of bug as the
//! usbhostfs DMA constraint dbg::shot documents).
//!
//! Split of labor: the MAIN thread does all usbhostfs file IO (vid.rs tops
//! this ring up from the stream file inside videoTick's budget — two threads
//! on one USB pipe would contend) and the AUDIO thread only ever moves RAM
//! into `sceAudioOutputPannedBlocking`, which parks it in the kernel until
//! the hardware drains each block.
//!
//! Single writer (the main thread for the video plane, the media worker for
//! media.playback, never both) + single reader (audio thread) over absolute
//! frame counters; release/acquire pairs publish the PCM bytes with the
//! counter. `flush()` (seek/epoch change) is writer-side: it advances the
//! read cursor, and a racing reader at worst outputs one already-consumed
//! block — a click, not corruption. The CHANNEL is reserved AND released on
//! the main thread: releasing from the audio thread failed persistently on
//! hardware and leaked the channel (observed as "audio worked once, then
//! silence for every later session").

use core::ffi::c_void;
use core::sync::atomic::{AtomicBool, AtomicI32, AtomicUsize, Ordering};

use psp::sys::{self, AudioFormat, ThreadAttributes};
use psp::Align16;

/// Output frames per hardware submit at 44.1 kHz (~23 ms per block).
const BLOCK_OUT: usize = 1024;
/// In-RAM ring capacity in SOURCE sample frames (~740 ms at 22.05 kHz).
const RING_FRAMES: usize = 16 * 1024;

static mut RING: [i16; RING_FRAMES * 2] = [0; RING_FRAMES * 2];
static mut OUT: Align16<[i16; BLOCK_OUT * 2]> = Align16([0; BLOCK_OUT * 2]);

/// Absolute SOURCE sample-frame counters (wrap-around via modulo; usize
/// wraps after ~54 years of audio, which outlives the battery).
static WRITE_POS: AtomicUsize = AtomicUsize::new(0);
static READ_POS: AtomicUsize = AtomicUsize::new(0);
static RUN: AtomicBool = AtomicBool::new(false);
static LIVE: AtomicBool = AtomicBool::new(false);
/// The hardware channel is held (reserve succeeded, release hasn't).
static RESERVED: AtomicBool = AtomicBool::new(false);
/// Reserved channel id (sceAudioChReserve result), -1 when none.
static CHANNEL: AtomicI32 = AtomicI32::new(-1);
/// Integer upsample factor to 44.1 kHz (44100 / stream rate).
static UPSAMPLE: AtomicUsize = AtomicUsize::new(1);
/// The output holds: queued PCM stays queued and the played position stops.
static PAUSED: AtomicBool = AtomicBool::new(false);
/// Channel volume, 0..=AUDIO_VOLUME_MAX.
static VOLUME: AtomicI32 = AtomicI32::new(sys::AUDIO_VOLUME_MAX as i32);

/// 44.1 kHz output covers the rates the hardware would have resampled from
/// anyway; only integer ratios are supported (the host streams 22.05 kHz).
fn upsample_factor(sample_rate: u32) -> Option<usize> {
    match sample_rate {
        44100 => Some(1),
        22050 => Some(2),
        11025 => Some(4),
        _ => None,
    }
}

unsafe extern "C" fn audio_thread(_argc: usize, _argv: *mut c_void) -> i32 {
    // Linear-interpolation carry: the last source frame of the previous
    // block, so upsampled blocks join without a step.
    let mut prev_l: i32 = 0;
    let mut prev_r: i32 = 0;
    crate::stats::AUDIO_THREADS.fetch_add(1, Ordering::Relaxed);
    while RUN.load(Ordering::Acquire) {
        if PAUSED.load(Ordering::Acquire) {
            sys::sceKernelDelayThread(4_000);
            continue;
        }
        let k = UPSAMPLE.load(Ordering::Relaxed).max(1);
        let need = BLOCK_OUT / k;
        let read = READ_POS.load(Ordering::Relaxed);
        let avail = WRITE_POS.load(Ordering::Acquire).wrapping_sub(read);
        if avail < need {
            // Starved (paused stream, USB stall): sleep instead of pushing
            // silence, so resume latency is one block, not a queue of hush.
            crate::stats::AUDIO_STARVED.fetch_add(1, Ordering::Relaxed);
            sys::sceKernelDelayThread(4_000);
            continue;
        }
        for i in 0..need {
            let src = ((read + i) % RING_FRAMES) * 2;
            let l = RING[src] as i32;
            let r = RING[src + 1] as i32;
            match k {
                1 => {
                    OUT.0[i * 2] = l as i16;
                    OUT.0[i * 2 + 1] = r as i16;
                }
                2 => {
                    // Midpoint first: it bridges FROM the previous frame.
                    OUT.0[i * 4] = ((prev_l + l) >> 1) as i16;
                    OUT.0[i * 4 + 1] = ((prev_r + r) >> 1) as i16;
                    OUT.0[i * 4 + 2] = l as i16;
                    OUT.0[i * 4 + 3] = r as i16;
                }
                _ => {
                    // k == 4: quarter steps from the previous frame.
                    for step in 0..4 {
                        let t = step as i32 + 1;
                        let o = (i * 4 + step) * 2;
                        OUT.0[o] = ((prev_l * (4 - t) + l * t) >> 2) as i16;
                        OUT.0[o + 1] = ((prev_r * (4 - t) + r * t) >> 2) as i16;
                    }
                }
            }
            prev_l = l;
            prev_r = r;
        }
        READ_POS.store(read.wrapping_add(need), Ordering::Release);
        // The hardware may DMA straight from this buffer — flush the dcache
        // or it reads whatever lines happened to be evicted (audible fizz).
        sys::sceKernelDcacheWritebackRange(
            OUT.0.as_ptr() as *const c_void,
            (BLOCK_OUT * 2 * 2) as u32,
        );
        let ch = CHANNEL.load(Ordering::Relaxed);
        let volume = VOLUME.load(Ordering::Relaxed);
        let result = sys::sceAudioOutputPannedBlocking(
            ch,
            volume,
            volume,
            OUT.0.as_mut_ptr() as *mut c_void,
        );
        crate::stats::AUDIO_OUTPUT_BLOCKS.fetch_add(1, Ordering::Relaxed);
        if result < 0 {
            crate::stats::AUDIO_OUTPUT_ERRORS.fetch_add(1, Ordering::Relaxed);
            crate::stats::AUDIO_LAST_OUTPUT_ERR.store(result, Ordering::Relaxed);
        }
    }
    // The channel release happens on the MAIN thread (stop()) once LIVE
    // drops — this thread only signals that it is done outputting. Freeing
    // the thread UID here too: a plain return parks the thread as STOPPED
    // forever and each session would leak one.
    crate::stats::AUDIO_THREADS.fetch_sub(1, Ordering::Relaxed);
    LIVE.store(false, Ordering::Release);
    sys::sceKernelExitDeleteThread(0);
    0
}

/// Release the hardware channel from the main thread, retrying across the
/// drain of the final queued blocks (release reports busy until they play
/// out — ~23 ms each; an ignored failure leaks the channel and mutes every
/// later session).
unsafe fn release_channel() {
    if !RESERVED.load(Ordering::Acquire) {
        return;
    }
    let ch = CHANNEL.load(Ordering::Relaxed);
    for _ in 0..250 {
        if sys::sceAudioChRelease(ch) >= 0 {
            RESERVED.store(false, Ordering::Release);
            CHANNEL.store(-1, Ordering::Relaxed);
            return;
        }
        sys::sceKernelDelayThread(2_000);
    }
    crate::stats::AUDIO_RELEASE_TIMEOUTS.fetch_add(1, Ordering::Relaxed);
}

/// Reserve a normal 44.1 kHz channel and start the output thread. Rates
/// without an integer path to 44.1 kHz are refused (the video still plays,
/// silently). Any previous session is stopped first.
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
    PAUSED.store(false, Ordering::Release);
    VOLUME.store(sys::AUDIO_VOLUME_MAX as i32, Ordering::Relaxed);
    // A stale hold (previous release timed out) blocks reserve forever —
    // clear it first, then give the reserve a grace window for the drain.
    release_channel();
    let mut ch = -1;
    for _ in 0..50 {
        ch = sys::sceAudioChReserve(
            sys::AUDIO_NEXT_CHANNEL,
            BLOCK_OUT as i32,
            AudioFormat::Stereo,
        );
        if ch >= 0 {
            break;
        }
        crate::stats::AUDIO_LAST_RESERVE_ERR.store(ch, Ordering::Relaxed);
        sys::sceKernelDelayThread(4_000);
    }
    if ch < 0 {
        crate::stats::AUDIO_RESERVE_GIVEUPS.fetch_add(1, Ordering::Relaxed);
        return false;
    }
    CHANNEL.store(ch, Ordering::Relaxed);
    RESERVED.store(true, Ordering::Release);
    RUN.store(true, Ordering::Release);
    let id = sys::sceKernelCreateThread(
        b"pocketjs_audio\0".as_ptr(),
        audio_thread,
        16, // above the JS worker (32): a missed block is audible, a late frame is not
        32 * 1024,
        ThreadAttributes::USER,
        core::ptr::null_mut(),
    );
    if id.0 < 0 {
        RUN.store(false, Ordering::Release);
        release_channel();
        return false;
    }
    LIVE.store(true, Ordering::Release);
    sys::sceKernelStartThread(id, 0, core::ptr::null_mut());
    true
}

/// Signal the thread down, wait for it to leave its last blocking output
/// (bounded: ~23 ms a block, give it a second), then release the channel
/// from THIS thread. A straggler thread just means the release happens on
/// the next start()'s stale-clear instead.
pub unsafe fn stop() {
    if LIVE.load(Ordering::Acquire) {
        RUN.store(false, Ordering::Release);
        for _ in 0..250 {
            if !LIVE.load(Ordering::Acquire) {
                break;
            }
            sys::sceKernelDelayThread(4_000);
        }
    }
    if !LIVE.load(Ordering::Acquire) {
        release_channel();
    }
}

/// SOURCE sample frames the ring can still accept (writer-side budgeting).
pub fn free_frames() -> usize {
    let queued = WRITE_POS
        .load(Ordering::Relaxed)
        .wrapping_sub(READ_POS.load(Ordering::Acquire));
    RING_FRAMES - queued.min(RING_FRAMES)
}

/// Queue interleaved s16 PCM at the SOURCE rate (mono is upmixed to both
/// ears). Frames beyond free_frames() are dropped — the writer checks
/// first, so a drop means a flush raced in, and losing stale audio is the
/// right outcome.
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
    crate::stats::AUDIO_PUSHED_FRAMES.fetch_add(n as u32, Ordering::Relaxed);
}

/// Fill the queue with silence up to a whole output block. The thread
/// outputs whole blocks, so a stream's last frames play only once the block
/// they start is complete (writer-side, after the stream's last push).
pub unsafe fn pad_to_block() {
    let need = BLOCK_OUT / UPSAMPLE.load(Ordering::Relaxed).max(1);
    let rest = queued() % need;
    if rest == 0 {
        return;
    }
    let n = (need - rest).min(free_frames());
    let write = WRITE_POS.load(Ordering::Relaxed);
    for i in 0..n {
        let dst = ((write + i) % RING_FRAMES) * 2;
        RING[dst] = 0;
        RING[dst + 1] = 0;
    }
    WRITE_POS.store(write.wrapping_add(n), Ordering::Release);
}

/// Drop everything queued (seek/epoch discontinuity): jump the read cursor
/// to the write cursor. See the module header for the benign race.
pub fn flush() {
    READ_POS.store(WRITE_POS.load(Ordering::Relaxed), Ordering::Release);
}

/// Hold or release the output. While held the hardware gets no block, so the
/// played position stops where it is.
pub fn set_paused(value: bool) {
    PAUSED.store(value, Ordering::Release);
}

/// Channel volume from 0.0 to 1.0.
pub fn set_volume(value: f32) {
    let value = if value.is_finite() { value.clamp(0.0, 1.0) } else { 0.0 };
    VOLUME.store((value * sys::AUDIO_VOLUME_MAX as f32) as i32, Ordering::Relaxed);
}

/// SOURCE sample frames handed to the hardware since start(); the media
/// clock (the block in flight counts as played).
pub fn played() -> usize {
    READ_POS.load(Ordering::Acquire)
}

/// SOURCE sample frames pushed since start() (writer-side).
pub fn written() -> usize {
    WRITE_POS.load(Ordering::Relaxed)
}

/// SOURCE sample frames queued and not yet played.
pub fn queued() -> usize {
    RING_FRAMES - free_frames()
}
