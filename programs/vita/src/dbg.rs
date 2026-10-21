//! Vita DevTools transport placeholder. The core inspection ops are exposed,
//! while the PSPLink mailbox is PSP-specific and deliberately reports idle.

pub fn active() -> bool {
    false
}

pub fn poll() -> Option<String> {
    None
}

pub fn send(_bytes: &[u8]) {}

pub fn shot() -> bool {
    false
}
