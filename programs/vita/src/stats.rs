//! Device diagnostic counters (spec OP.debugStats) — the PSP stats.rs shape
//! with a `net` section for the WiFi transport. Counters are u32 and
//! free-running; readers diff two snapshots over a known window. Field names
//! are the devtools wire contract — extend, never rename.

use core::sync::atomic::{AtomicU32, Ordering};

/// Frames committed to the plane texture (on-screen fps numerator).
pub static VID_PRESENTED: AtomicU32 = AtomicU32::new(0);
/// Epoch resyncs observed (seek/resume discontinuities).
pub static VID_EPOCHS: AtomicU32 = AtomicU32::new(0);

/// One JSON snapshot (the devtools "devStats" payload).
pub fn json() -> String {
    let r = |c: &AtomicU32| c.load(Ordering::Relaxed);
    format!(
        concat!(
            "{{\"app\":\"{}\",\"bundle\":\"{}\",",
            "\"audio\":{{\"starved\":{},\"lastReserveErr\":{},\"pushedFrames\":{}}},",
            "\"vid\":{{\"presented\":{},\"epochs\":{}}},",
            "\"net\":{{\"rxBytes\":{},\"txBytes\":{},\"reconnects\":{},",
            "\"slotsRx\":{},\"fileEvicts\":{}}}}}"
        ),
        env!("POCKETJS_APP_NAME"),
        env!("POCKETJS_BUNDLE_HASH"),
        r(&AUDIO_STARVED),
        AUDIO_LAST_RESERVE_ERR.load(Ordering::Relaxed),
        r(&AUDIO_PUSHED_FRAMES),
        r(&VID_PRESENTED),
        r(&VID_EPOCHS),
        r(&NET_RX_BYTES),
        r(&NET_TX_BYTES),
        r(&NET_RECONNECTS),
        r(&NET_SLOTS_RX),
        r(&FILE_CACHE_EVICTS),
    )
}

pub use pocket_vita_audio::stats::{AUDIO_LAST_RESERVE_ERR, AUDIO_PUSHED_FRAMES, AUDIO_STARVED};

pub use pocket_vita_net::stats::{
    FILE_CACHE_EVICTS, NET_RECONNECTS, NET_RX_BYTES, NET_SLOTS_RX, NET_TX_BYTES,
};
