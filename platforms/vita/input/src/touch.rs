/// Controller report copied from the SDK; independent of generated FFI layouts.
#[derive(Clone, Copy, Debug, Default)]
pub struct TouchReport {
    pub id: u8,
    pub x: i16,
    pub y: i16,
}

pub const MAX_TOUCHES: usize = 8;

#[derive(Clone, Copy, Debug)]
pub struct TouchPanel {
    min_x: i32,
    min_y: i32,
    max_x: i32,
    max_y: i32,
}

impl Default for TouchPanel {
    fn default() -> Self {
        // Documented Vita front-panel display coordinates. Real hardware and
        // Vita3K normally provide the same values through GetPanelInfo.
        Self {
            min_x: 0,
            min_y: 0,
            max_x: 1919,
            max_y: 1087,
        }
    }
}

impl TouchPanel {
    pub fn new(bounds: [i32; 4]) -> Self {
        let panel = Self {
            min_x: bounds[0],
            min_y: bounds[1],
            max_x: bounds[2],
            max_y: bounds[3],
        };
        if panel.max_x > panel.min_x && panel.max_y > panel.min_y {
            panel
        } else {
            Self::default()
        }
    }

    fn logical_axis(raw: i16, min: i32, max: i32, logical: i32) -> u32 {
        if logical <= 1 || max <= min {
            return 0;
        }
        let span = max as i64 - min as i64;
        let offset = (raw as i32).clamp(min, max) as i64 - min as i64;
        ((offset * (logical.clamp(1, 512) - 1) as i64 + span / 2) / span) as u32
    }

    pub fn pack(self, report: TouchReport, logical_w: i32, logical_h: i32) -> u32 {
        let x = Self::logical_axis(report.x, self.min_x, self.max_x, logical_w) & 0x1ff;
        let y = Self::logical_axis(report.y, self.min_y, self.max_y, logical_h) & 0x1ff;
        ((report.id as u32) << 18) | (y << 9) | x
    }
}

#[derive(Clone, Copy, Debug)]
pub struct TouchSnapshot {
    packed: [u32; MAX_TOUCHES],
    len: usize,
}

impl TouchSnapshot {
    pub const EMPTY: Self = Self {
        packed: [0; MAX_TOUCHES],
        len: 0,
    };

    pub fn from_reports(panel: TouchPanel, reports: &[TouchReport], logical: [i32; 2]) -> Self {
        let mut snapshot = Self::EMPTY;
        snapshot.len = reports.len().min(MAX_TOUCHES);
        for (index, report) in reports.iter().take(snapshot.len).enumerate() {
            snapshot.packed[index] = panel.pack(*report, logical[0], logical[1]);
        }
        snapshot
    }

    /** Construct a deterministic snapshot from logical viewport contacts.
     * Capture guests and custom hosts use this instead of fabricating Vita
     * panel coordinates; production hardware continues through from_reports. */
    pub fn from_logical(contacts: &[(u8, u16, u16)], logical: [i32; 2]) -> Self {
        let mut snapshot = Self::EMPTY;
        snapshot.len = contacts.len().min(MAX_TOUCHES);
        let max_x = (logical[0].clamp(1, 512) - 1) as u32;
        let max_y = (logical[1].clamp(1, 512) - 1) as u32;
        for (index, (id, x, y)) in contacts.iter().take(snapshot.len).enumerate() {
            let x = (*x as u32).min(max_x) & 0x1ff;
            let y = (*y as u32).min(max_y) & 0x1ff;
            snapshot.packed[index] = ((*id as u32) << 18) | (y << 9) | x;
        }
        snapshot
    }

    pub fn packed(&self) -> &[u32] {
        &self.packed[..self.len]
    }
}

#[cfg(test)]
mod tests {
    use super::TouchPanel;
    use super::TouchReport;
    fn panel_info() -> [i32; 4] {
        [0, 0, 1919, 1087]
    }
    fn report(id: u8, x: i16, y: i16) -> TouchReport {
        TouchReport { id, x, y }
    }

    #[test]
    fn maps_panel_endpoints_to_logical_viewport() {
        let panel = TouchPanel::new(panel_info());
        let top_left = panel.pack(report(7, 0, 0), 480, 272);
        let bottom_right = panel.pack(report(9, 1919, 1087), 480, 272);
        assert_eq!(top_left & 0x1ff, 0);
        assert_eq!((top_left >> 9) & 0x1ff, 0);
        assert_eq!(top_left >> 18, 7);
        assert_eq!(bottom_right & 0x1ff, 479);
        assert_eq!((bottom_right >> 9) & 0x1ff, 271);
        assert_eq!(bottom_right >> 18, 9);
    }

    #[test]
    fn clamps_reports_outside_the_display_area() {
        let panel = TouchPanel::new(panel_info());
        let packed = panel.pack(report(1, -200, 2000), 480, 272);
        assert_eq!(packed & 0x1ff, 0);
        assert_eq!((packed >> 9) & 0x1ff, 271);
    }

    #[test]
    fn logical_capture_contacts_use_the_same_wire_format() {
        let snapshot =
            super::TouchSnapshot::from_logical(&[(4, 120, 80), (9, 900, 900)], [480, 272]);
        assert_eq!(
            snapshot.packed(),
            &[4 << 18 | 80 << 9 | 120, 9 << 18 | 271 << 9 | 479]
        );
    }
    #[test]
    fn exported_logical_size_controls_packing_and_extremes_stay_bounded() {
        let report=report(3,1919,1087);
        let small=super::TouchSnapshot::from_reports(TouchPanel::default(), &[report], [240,136]);
        assert_eq!(small.packed(), &[3 << 18 | 135 << 9 | 239]);
        let extreme=TouchPanel::new([i32::MIN,i32::MIN,i32::MAX,i32::MAX]);
        let word=extreme.pack(report,i32::MAX,i32::MIN);
        assert_eq!((word >> 9) & 511,0);
        assert_eq!(word >> 18,3);
    }

}
