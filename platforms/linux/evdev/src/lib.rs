//! Bounded evdev packet decoding. State is published at SYN_REPORT; dropped
//! kernel packets cancel contacts once and require fresh device events.
use pocket_drivers::{CancelledContact, Contact, InputFrameBuilder, Pointer};
use pocket_spec::btn;
use std::io;
#[derive(Clone, Copy, Debug)]
pub struct AxisRange {
    pub min: i32,
    pub max: i32,
}
impl AxisRange {
    fn coordinate(self, value: i32, extent: u32) -> f32 {
        if self.max <= self.min {
            return 0.0;
        }
        (((i64::from(value) - i64::from(self.min)) as f64
            / (i64::from(self.max) - i64::from(self.min)) as f64)
            .clamp(0.0, 1.0)
            * f64::from(extent.saturating_sub(1))) as f32
    }
}
#[derive(Clone, Copy, Default)]
struct Touch {
    tracking: Option<i32>,
    id: Option<u32>,
    x: i32,
    y: i32,
}
#[derive(Clone)]
struct State {
    keys: [bool; 768],
    touches: [Touch; 16],
    pointer: [f32; 2],
    pointer_buttons: u32,
}
impl Default for State {
    fn default() -> Self {
        Self {
            keys: [false; 768],
            touches: [Touch::default(); 16],
            pointer: [0.0; 2],
            pointer_buttons: 0,
        }
    }
}
pub struct Decoder {
    extent: [u32; 2],
    ranges: [AxisRange; 2],
    first: u32,
    count: u32,
    surface: u32,
    current: State,
    published: State,
    slot: usize,
    multitouch: bool,
    accept_multitouch: bool,
    dropping: bool,
    retired: Vec<u32>,
    cancelled: Vec<CancelledContact>,
    pointer_enabled: bool,
}
impl Decoder {
    /// Contact IDs are reserved per device. Distinct devices must use disjoint
    /// ranges in 0..=255, the runtime wire's supported contact vocabulary.
    pub fn new(
        extent: [u32; 2],
        ranges: [AxisRange; 2],
        first: u32,
        count: u32,
    ) -> io::Result<Self> {
        if extent.contains(&0)
            || count == 0
            || count > 16
            || first.checked_add(count).is_none_or(|end| end > 256)
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid evdev viewport/contact range",
            ));
        }
        Ok(Self {
            extent,
            ranges,
            first,
            count,
            surface: 0,
            current: State::default(),
            published: State::default(),
            slot: 0,
            multitouch: false,
            accept_multitouch: true,
            dropping: false,
            retired: Vec::with_capacity(16),
            cancelled: Vec::with_capacity(16),
            pointer_enabled: false,
        })
    }
    fn release(&mut self, slot: usize, cancel: bool) {
        if let Some(id) = self.current.touches[slot].id.take() {
            if !self.retired.contains(&id) {
                self.retired.push(id);
            }
            if cancel && !self.cancelled.iter().any(|c| c.id == id) {
                self.cancelled.push(CancelledContact {
                    surface: self.surface,
                    id,
                });
            }
        }
        self.current.touches[slot].tracking = None;
    }
    fn assign_ids(&mut self) {
        for slot in 0..16 {
            if self.current.touches[slot].tracking.is_some()
                && self.current.touches[slot].id.is_none()
            {
                self.current.touches[slot].id = (self.first..self.first + self.count).find(|id| {
                    !self.retired.contains(id)
                        && !self.current.touches.iter().any(|t| t.id == Some(*id))
                });
            }
        }
    }
    pub fn event(&mut self, kind: u16, code: u16, value: i32) {
        if kind == 0 && code == 3 {
            self.disconnect();
            self.dropping = true;
            return;
        }
        if self.dropping {
            if kind == 0 && code == 0 {
                self.dropping = false;
            }
            return;
        }
        match (kind, code) {
            (3, 47 | 53 | 54 | 57) if !self.accept_multitouch => {}
            (0, 0) => {
                self.assign_ids();
                self.published = self.current.clone();
            }
            (1, 330) if !self.multitouch => {
                if value == 0 {
                    self.release(0, false);
                } else {
                    self.current.touches[0].tracking = Some(0);
                }
            }
            (1, 272..=274) => {
                self.pointer_enabled = true;
                let bit = 1 << (code - 272);
                if value == 0 {
                    self.current.pointer_buttons &= !bit;
                } else {
                    self.current.pointer_buttons |= bit;
                }
            }
            (1, key) if (key as usize) < self.current.keys.len() => {
                self.current.keys[key as usize] = value != 0
            }
            (2, 0..=1) => {
                self.pointer_enabled = true;
                let axis = code as usize;
                self.current.pointer[axis] = (self.current.pointer[axis] + value as f32)
                    .clamp(0.0, self.extent[axis].saturating_sub(1) as f32);
            }
            (3, 47) => {
                self.multitouch = true;
                self.slot = usize::try_from(value).unwrap_or(usize::MAX);
            }
            (3, 57) if self.slot < 16 => {
                self.multitouch = true;
                if self.current.touches[self.slot].tracking != Some(value) {
                    self.release(self.slot, false);
                    if value >= 0 {
                        self.current.touches[self.slot].tracking = Some(value);
                    }
                }
            }
            (3, 53 | 54) if self.slot < 16 => {
                self.multitouch = true;
                if code == 53 {
                    self.current.touches[self.slot].x = value;
                } else {
                    self.current.touches[self.slot].y = value;
                }
            }
            (3, 0 | 1) if !self.multitouch => {
                if code == 0 {
                    self.current.touches[0].x = value;
                } else {
                    self.current.touches[0].y = value;
                }
            }
            _ => {}
        }
    }
    pub fn disconnect(&mut self) {
        for touch in &self.published.touches {
            if let Some(id) = touch.id {
                if !self.cancelled.iter().any(|c| c.id == id) {
                    self.cancelled.push(CancelledContact {
                        surface: self.surface,
                        id,
                    });
                }
            }
        }
        for slot in 0..16 {
            self.release(slot, true);
        }
        self.current.keys.fill(false);
        self.current.pointer_buttons = 0;
        self.published = self.current.clone();
    }
    pub fn append(&mut self, frame: &mut InputFrameBuilder) {
        for slot in 0..16 {
            if self.published.touches[slot].tracking.is_some()
                && self.published.touches[slot].id.is_none()
            {
                let id = (self.first..self.first + self.count).find(|id| {
                    !self.retired.contains(id)
                        && !self
                            .published
                            .touches
                            .iter()
                            .chain(self.current.touches.iter())
                            .any(|t| t.id == Some(*id))
                });
                self.published.touches[slot].id = id;
                if self.current.touches[slot].tracking == self.published.touches[slot].tracking {
                    self.current.touches[slot].id = id;
                }
            }
        }
        let keys = &self.published.keys;
        for (codes, mask) in [
            (&[103u16, 544][..], btn::UP),
            (&[108, 545], btn::DOWN),
            (&[105, 546], btn::LEFT),
            (&[106, 547], btn::RIGHT),
            (&[28, 315], btn::START),
            // Escape and Backspace go back on a keyboard (the CardputerZero's
            // has no arrow keys on its first layer, but both of these).
            (&[57, 44, 304, 1, 14], btn::CROSS),
            (&[45, 305], btn::CIRCLE),
            (&[42, 307], btn::SQUARE),
            (&[46, 308], btn::TRIANGLE),
            (&[310], btn::LTRIGGER),
            (&[311], btn::RTRIGGER),
        ] {
            if codes.iter().any(|c| keys[*c as usize]) {
                frame.buttons |= mask;
            }
        }
        if self.pointer_enabled {
            frame.pointer = Some(Pointer {
                surface: self.surface,
                x: self.published.pointer[0],
                y: self.published.pointer[1],
                buttons: self.published.pointer_buttons,
            });
        }
        for touch in &self.published.touches {
            if let Some(id) = touch.id {
                frame.contacts.push(Contact {
                    surface: self.surface,
                    id,
                    x: self.ranges[0].coordinate(touch.x, self.extent[0]),
                    y: self.ranges[1].coordinate(touch.y, self.extent[1]),
                    cancelled: false,
                });
            }
        }
        frame.cancelled.append(&mut self.cancelled);
        self.retired.clear();
    }
}
/// Linux input_event timestamps use kernel long, followed by type/code/value.
/// The decoder accepts fragments without casting unaligned bytes to structs.
pub struct EventBytes {
    pending: Vec<u8>,
    long_bytes: usize,
}
impl EventBytes {
    pub fn new(long_bytes: usize) -> io::Result<Self> {
        if ![4, 8].contains(&long_bytes) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid kernel long size",
            ));
        }
        Ok(Self {
            pending: Vec::with_capacity(24),
            long_bytes,
        })
    }
    pub fn feed(&mut self, bytes: &[u8], decoder: &mut Decoder) {
        let length = self.long_bytes * 2 + 8;
        for byte in bytes {
            self.pending.push(*byte);
            if self.pending.len() == length {
                let at = self.long_bytes * 2;
                decoder.event(
                    u16::from_ne_bytes(self.pending[at..at + 2].try_into().unwrap()),
                    u16::from_ne_bytes(self.pending[at + 2..at + 4].try_into().unwrap()),
                    i32::from_ne_bytes(self.pending[at + 4..at + 8].try_into().unwrap()),
                );
                self.pending.clear();
            }
        }
    }
}
#[cfg(target_os = "linux")]
mod native;
#[cfg(target_os = "linux")]
pub use native::Evdev;

#[cfg(test)]
mod tests {
    use super::*;
    fn decoder() -> Decoder {
        Decoder::new(
            [101, 51],
            [
                AxisRange {
                    min: 100,
                    max: 1100,
                },
                AxisRange { min: -50, max: 50 },
            ],
            16,
            16,
        )
        .unwrap()
    }
    fn report(d: &mut Decoder) -> InputFrameBuilder {
        d.event(0, 0, 0);
        let mut f = InputFrameBuilder::new();
        d.append(&mut f);
        f
    }
    #[test]
    fn packets_are_atomic_and_alias_keys_stay_pressed() {
        let mut d = decoder();
        d.event(1, 44, 1);
        let mut f = InputFrameBuilder::new();
        d.append(&mut f);
        assert_eq!(f.buttons, 0);
        assert_eq!(report(&mut d).buttons, btn::CROSS);
        d.event(1, 57, 1);
        d.event(1, 44, 0);
        assert_eq!(report(&mut d).buttons, btn::CROSS);
        d.event(1, 57, 0);
        for key in [1, 14] {
            d.event(1, key, 1);
            assert_eq!(report(&mut d).buttons, btn::CROSS);
            d.event(1, key, 0);
            assert_eq!(report(&mut d).buttons, 0);
        }
    }
    #[test]
    fn touch_ranges_and_drop_cancellation_once() {
        let mut d = decoder();
        d.event(3, 47, 0);
        d.event(3, 57, 44);
        d.event(3, 53, 600);
        d.event(3, 54, 50);
        let f = report(&mut d);
        assert_eq!(
            (f.contacts[0].id, f.contacts[0].x, f.contacts[0].y),
            (16, 50.0, 50.0)
        );
        d.event(0, 3, 0);
        let f = report(&mut d);
        assert!(f.contacts.is_empty());
        assert_eq!(f.cancelled, [CancelledContact { surface: 0, id: 16 }]);
        assert!(report(&mut d).cancelled.is_empty());
    }
    #[test]
    fn fragments_and_invalid_slots_do_not_corrupt_contacts() {
        let mut d = decoder();
        let mut b = EventBytes::new(8).unwrap();
        let mut bytes = vec![0; 16];
        bytes.extend(1u16.to_ne_bytes());
        bytes.extend(28u16.to_ne_bytes());
        bytes.extend(1i32.to_ne_bytes());
        for c in bytes.chunks(3) {
            b.feed(c, &mut d);
        }
        assert_eq!(report(&mut d).buttons, btn::START);
        d.event(3, 47, i32::MAX);
        d.event(3, 57, 9);
        assert!(report(&mut d).contacts.is_empty());
        assert!(Decoder::new([1, 1], [AxisRange { min: 0, max: 1 }; 2], 255, 2).is_err());
    }
    #[test]
    fn replacement_tracking_id_cannot_reuse_id_within_snapshot() {
        let mut d = decoder();
        d.event(3, 47, 0);
        d.event(3, 57, 1);
        assert_eq!(report(&mut d).contacts[0].id, 16);
        d.event(3, 57, -1);
        d.event(3, 57, 2);
        assert_eq!(report(&mut d).contacts[0].id, 17);
    }
    #[test]
    fn dropped_packet_cancels_published_contact_even_after_unpublished_release() {
        let mut d = decoder();
        d.event(3, 47, 0);
        d.event(3, 57, 9);
        assert_eq!(report(&mut d).contacts.len(), 1);
        d.event(3, 57, -1);
        d.event(0, 3, 0);
        let mut frame = InputFrameBuilder::new();
        d.append(&mut frame);
        assert_eq!(frame.cancelled, [CancelledContact { surface: 0, id: 16 }]);
        frame.clear();
        d.append(&mut frame);
        assert!(frame.cancelled.is_empty());
    }
    #[test]
    fn one_id_range_releases_before_reusing_without_needing_motion() {
        let mut d = Decoder::new([10, 10], [AxisRange { min: 0, max: 10 }; 2], 0, 1).unwrap();
        d.event(3, 47, 0);
        d.event(3, 57, 1);
        assert_eq!(report(&mut d).contacts.len(), 1);
        d.event(3, 57, -1);
        d.event(3, 57, 2);
        assert!(report(&mut d).contacts.is_empty());
        let mut frame = InputFrameBuilder::new();
        d.append(&mut frame);
        assert_eq!(frame.contacts.len(), 1);
    }
}
