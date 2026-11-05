#[derive(Clone, Copy, Debug, Default)]
pub struct Pad {
    pub buttons: u32,
    pub lx: u8,
    pub ly: u8,
    pub rx: u8,
    pub ry: u8,
}

impl Pad {
    /// PocketJS's established left-stick packing used by external apps.
    #[inline]
    pub fn left_analog(self) -> i32 {
        ((self.lx as i32) << 8) | self.ly as i32
    }
}

#[cfg(test)]
mod tests {
    use super::Pad;

    #[test]
    fn packs_left_analog_for_the_pocketjs_frame_abi() {
        let pad = Pad {
            lx: 0x12,
            ly: 0x34,
            ..Pad::default()
        };

        assert_eq!(pad.left_analog(), 0x1234);
    }
}
