use core::sync::atomic::{AtomicI32, AtomicU32};
pub static AUDIO_STARVED: AtomicU32 = AtomicU32::new(0);
pub static AUDIO_RESERVE_GIVEUPS: AtomicU32 = AtomicU32::new(0);
pub static AUDIO_LAST_RESERVE_ERR: AtomicI32 = AtomicI32::new(0);
pub static AUDIO_RELEASE_TIMEOUTS: AtomicU32 = AtomicU32::new(0);
pub static AUDIO_PUSHED_FRAMES: AtomicU32 = AtomicU32::new(0);
/// Blocks handed to the hardware, failed outputs and the last failure, and
/// output threads alive (more than one would drain the ring twice as fast).
pub static AUDIO_OUTPUT_BLOCKS: AtomicU32 = AtomicU32::new(0);
pub static AUDIO_OUTPUT_ERRORS: AtomicU32 = AtomicU32::new(0);
pub static AUDIO_LAST_OUTPUT_ERR: AtomicI32 = AtomicI32::new(0);
pub static AUDIO_THREADS: AtomicI32 = AtomicI32::new(0);
