//! Checked byte accounting for the native GU command allocation.
pub(crate) const LIST_BYTES: usize = 1024 * 1024;
// With pinned rust-psp 2cbaf8c, begin_pass emits at most 84 bytes (including
// the normal clear's 24-byte inline vertex pair and 8-byte allocation jump),
// T8 bind 60, draw 16, clip 8, and end_pass 16. No FAST_CLEAR is used; draw
// vertices and CLUT data live outside the list. Keep a conservative 1 KiB
// per operation plus the next query's two words and four terminal words.
pub(crate) const CALL_RESERVE: usize = 1024 + 8 + 16;

pub(crate) fn has_room(start: usize, cursor: usize) -> bool {
    let start = start | 0x4000_0000;
    cursor
        .checked_sub(start)
        .is_some_and(|used| used <= LIST_BYTES - CALL_RESERVE)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cursor_uses_byte_offsets_and_preserves_query_and_terminal_space() {
        let cached = 0x0890_0000;
        let uncached = cached | 0x4000_0000;
        assert!(has_room(cached, uncached + 8));
        assert!(has_room(uncached, uncached + 8));
        assert!(has_room(cached, uncached + LIST_BYTES - CALL_RESERVE));
        assert!(!has_room(cached, uncached + LIST_BYTES - CALL_RESERVE + 4));
        assert!(!has_room(cached, uncached - 4));
        assert!(!has_room(cached, usize::MAX));
        // Even the largest allowed operation and the next query leave enough
        // room to terminate when that next query rejects another operation.
        let after_call_and_query = LIST_BYTES - CALL_RESERVE + 1024 + 8;
        assert_eq!(LIST_BYTES - after_call_and_query, 16);
        assert!(!has_room(cached, uncached + after_call_and_query));
    }
}
