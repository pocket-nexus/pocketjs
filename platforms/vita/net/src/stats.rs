use core::sync::atomic::AtomicU32;
pub static NET_RX_BYTES: AtomicU32 = AtomicU32::new(0);
pub static NET_TX_BYTES: AtomicU32 = AtomicU32::new(0);
pub static NET_RECONNECTS: AtomicU32 = AtomicU32::new(0);
pub static NET_SLOTS_RX: AtomicU32 = AtomicU32::new(0);
pub static FILE_CACHE_EVICTS: AtomicU32 = AtomicU32::new(0);
