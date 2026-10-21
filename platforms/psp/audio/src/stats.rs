use core::sync::atomic::{AtomicI32, AtomicU32};
pub static AUDIO_STARVED: AtomicU32 = AtomicU32::new(0);
pub static AUDIO_RESERVE_GIVEUPS: AtomicU32 = AtomicU32::new(0);
pub static AUDIO_LAST_RESERVE_ERR: AtomicI32 = AtomicI32::new(0);
pub static AUDIO_RELEASE_TIMEOUTS: AtomicU32 = AtomicU32::new(0);
pub static AUDIO_PUSHED_FRAMES: AtomicU32 = AtomicU32::new(0);
