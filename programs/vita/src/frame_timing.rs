//! Where a Vita frame's CPU time goes, averaged over the last 120 frames, in microseconds.
//! `Runtime::render_with_overlay` records segment 1 (`gpu_wait`, begin_frame waiting for the
//! previous scene's GPU work) and segment 2 (`render`, building and submitting the DrawList). A
//! program loop that reports timing records segment 0 (`advance`, the guest turn and core tick)
//! around `frame_with_input` and calls `end_frame` once per loop iteration (`frame`).
use core::sync::atomic::{AtomicU32, AtomicU64, Ordering};

const SEGMENTS: usize = 3;
const WINDOW: u32 = 120;
static ACC: [AtomicU64; SEGMENTS] = [const { AtomicU64::new(0) }; SEGMENTS];
static AVG: [AtomicU32; SEGMENTS + 1] = [const { AtomicU32::new(0) }; SEGMENTS + 1];
static FRAMES: AtomicU32 = AtomicU32::new(0);
static WINDOW_START: AtomicU64 = AtomicU64::new(0);

/// The last completed window's averages, in microseconds.
#[derive(Clone, Copy, Debug, Default)]
pub struct Averages {
    pub advance: u32,
    pub gpu_wait: u32,
    pub render: u32,
    pub frame: u32,
}

pub fn now_us() -> u64 {
    unsafe { vitasdk_sys::sceKernelGetProcessTimeWide() }
}

pub fn add(segment: usize, us: u64) {
    ACC[segment].fetch_add(us, Ordering::Relaxed);
}

pub fn end_frame() {
    let n = FRAMES.fetch_add(1, Ordering::Relaxed) + 1;
    if n < WINDOW {
        return;
    }
    let now = now_us();
    for i in 0..SEGMENTS {
        AVG[i].store(
            (ACC[i].swap(0, Ordering::Relaxed) / WINDOW as u64) as u32,
            Ordering::Relaxed,
        );
    }
    let start = WINDOW_START.swap(now, Ordering::Relaxed);
    if start != 0 {
        AVG[SEGMENTS].store(((now - start) / WINDOW as u64) as u32, Ordering::Relaxed);
    }
    FRAMES.store(0, Ordering::Relaxed);
}

pub fn averages() -> Averages {
    let v = |i: usize| AVG[i].load(Ordering::Relaxed);
    Averages { advance: v(0), gpu_wait: v(1), render: v(2), frame: v(3) }
}
