//! Where a Vita frame's CPU time goes, averaged over the last 120 frames and reported in the USB
//! status as `frameTiming` (microseconds): `advance` is the guest turn and core tick, `gpuWait` is
//! begin_frame waiting for the previous scene's GPU work, `render` builds and submits the DrawList,
//! `frame` is the whole loop iteration.
use core::sync::atomic::{AtomicU32, AtomicU64, Ordering};

const SEGMENTS: usize = 3;
const WINDOW: u32 = 120;
static ACC: [AtomicU64; SEGMENTS] = [const { AtomicU64::new(0) }; SEGMENTS];
static AVG: [AtomicU32; SEGMENTS + 1] = [const { AtomicU32::new(0) }; SEGMENTS + 1];
static FRAMES: AtomicU32 = AtomicU32::new(0);
static WINDOW_START: AtomicU64 = AtomicU64::new(0);

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

pub fn json() -> serde_json::Value {
    let v = |i: usize| AVG[i].load(Ordering::Relaxed);
    serde_json::json!({ "advance": v(0), "gpuWait": v(1), "render": v(2), "frame": v(3) })
}
