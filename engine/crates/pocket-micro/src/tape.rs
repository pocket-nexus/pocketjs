//! Scripted input: `frame:mask,frame:mask` (decimal or hex masks), the same
//! format hosts/psp bakes for capture builds. The active mask is the last
//! threshold at or before the frame; frames past the last threshold return
//! `None`, so a device build hands control back to the real pad when the
//! tape ends.

/// Parse one unsigned number (decimal or `0x` hex) between `start` and `end`.
fn parse_u32(s: &[u8], mut i: usize, end: usize) -> Option<u32> {
    while i < end && (s[i] == b' ' || s[i] == b'\t') {
        i += 1;
    }
    if i >= end {
        return None;
    }
    let hex = i + 1 < end && s[i] == b'0' && (s[i + 1] == b'x' || s[i + 1] == b'X');
    if hex {
        i += 2;
    }
    let mut out = 0u32;
    let mut any = false;
    while i < end {
        let c = s[i];
        let d = match c {
            b'0'..=b'9' => c - b'0',
            b'a'..=b'f' if hex => c - b'a' + 10,
            b'A'..=b'F' if hex => c - b'A' + 10,
            b' ' | b'\t' => break,
            _ => return None,
        };
        out = out
            .saturating_mul(if hex { 16 } else { 10 })
            .saturating_add(d as u32);
        any = true;
        i += 1;
    }
    if any {
        Some(out)
    } else {
        None
    }
}

/// The mask the tape holds at `frame`, or `None` when the tape is empty or
/// has ended (its last threshold is before `frame`).
pub fn mask_at(tape: &str, frame: u32) -> Option<u32> {
    let s = tape.as_bytes();
    if s.is_empty() {
        return None;
    }
    let mut i = 0usize;
    let mut best: Option<(u32, u32)> = None;
    let mut last_frame = 0u32;
    while i < s.len() {
        while i < s.len() && matches!(s[i], b',' | b';' | b' ' | b'\t') {
            i += 1;
        }
        let frame_start = i;
        while i < s.len() && s[i] != b':' && s[i] != b',' && s[i] != b';' {
            i += 1;
        }
        if i >= s.len() || s[i] != b':' {
            break;
        }
        let frame_end = i;
        i += 1;
        let mask_start = i;
        while i < s.len() && s[i] != b',' && s[i] != b';' {
            i += 1;
        }
        if let (Some(at), Some(mask)) = (
            parse_u32(s, frame_start, frame_end),
            parse_u32(s, mask_start, i),
        ) {
            last_frame = last_frame.max(at);
            if at <= frame && best.map_or(true, |(b, _)| at >= b) {
                best = Some((at, mask));
            }
        }
    }
    if frame > last_frame {
        return None;
    }
    best.map(|(_, mask)| mask)
}

#[cfg(test)]
mod tests {
    use super::mask_at;

    #[test]
    fn thresholds_and_end() {
        let tape = "0:0,5:0x40,6:0,20:0x2000,21:0";
        assert_eq!(mask_at(tape, 0), Some(0));
        assert_eq!(mask_at(tape, 4), Some(0));
        assert_eq!(mask_at(tape, 5), Some(0x40));
        assert_eq!(mask_at(tape, 6), Some(0));
        assert_eq!(mask_at(tape, 20), Some(0x2000));
        assert_eq!(mask_at(tape, 21), Some(0));
        assert_eq!(mask_at(tape, 22), None);
        assert_eq!(mask_at("", 0), None);
    }
}
