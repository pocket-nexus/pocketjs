//! Bounded evdev packet decoding. State is published at SYN_REPORT; dropped
//! kernel packets cancel contacts once and require fresh device events.
//!
//! A keyboard's keys are reported twice: as the buttons their positions
//! stand for (`append`), and as text events that name each key the way
//! `KeyboardEvent.key` does (`a`, `A`, `Enter`, `ArrowLeft`, `Control+z`),
//! published with the SYN_REPORT that carries the key change. A device whose
//! kernel keymap puts characters on other key codes (the CardputerZero's
//! symbol layer) names them through `set_symbols`, which wins over the US
//! layout.
use pocket_drivers::input::TextEvent;
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
    /// Text events of the report being read; moved to `published_text` at
    /// its SYN_REPORT.
    text: Vec<TextEvent>,
    published_text: Vec<TextEvent>,
    /// Key codes the device's own keymap names: looked up before the US
    /// layout.
    symbols: Vec<(u16, String)>,
    caps_lock: bool,
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
            text: Vec::new(),
            published_text: Vec::new(),
            symbols: Vec::new(),
            caps_lock: false,
        })
    }
    /// Name the characters the device's keymap puts on `codes`; each entry
    /// is a key code and the text it types (the CardputerZero's symbol layer
    /// arrives on codes the US layout gives other meanings).
    pub fn set_symbols(&mut self, symbols: Vec<(u16, String)>) {
        self.symbols = symbols;
    }
    fn held(&self, codes: &[u16]) -> bool {
        codes.iter().any(|code| self.current.keys[*code as usize])
    }
    /// The text event a key change produces, named as KeyboardEvent.key
    /// names keys. None for a key this layout does not know.
    fn key_text(&self, code: u16, pressed: bool, repeat: bool) -> Option<TextEvent> {
        // A modifier's own event carries no prefix.
        if let Some(name) = modifier_name(code) {
            return Some(TextEvent::Key {
                key: name.to_string(),
                pressed,
                repeat,
            });
        }
        let shift = self.held(&[42, 54]);
        let control = self.held(&[29, 97]);
        let alt = self.held(&[56, 100]);
        let (name, character): (String, bool) = if let Some((_, text)) =
            self.symbols.iter().find(|(symbol, _)| *symbol == code)
        {
            (text.clone(), true)
        } else if let Some(name) = named_key(code) {
            (name.to_string(), false)
        } else {
            let (plain, shifted) = character_key(code)?;
            let letter = plain.len() == 1 && plain.as_bytes()[0].is_ascii_alphabetic();
            let upper = letter && (shift ^ self.caps_lock);
            let text = if upper || (shift && !letter) {
                shifted
            } else {
                plain
            };
            (text.to_string(), true)
        };
        let mut key = String::new();
        if control {
            key.push_str("Control+");
        }
        if alt {
            key.push_str("Alt+");
        }
        if shift && !character {
            key.push_str("Shift+");
        }
        key.push_str(&name);
        Some(TextEvent::Key {
            key,
            pressed,
            repeat,
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
                self.published_text.append(&mut self.text);
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
                let was = self.current.keys[key as usize];
                let pressed = value != 0;
                let repeat = value == 2;
                if (pressed && (!was || repeat)) || (!pressed && was) {
                    if key == 58 && pressed && !repeat {
                        self.caps_lock = !self.caps_lock;
                    }
                    if let Some(event) = self.key_text(key, pressed, repeat) {
                        self.text.push(event);
                    }
                }
                self.current.keys[key as usize] = pressed
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
        self.text.clear();
        self.published_text.clear();
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
        frame.text.append(&mut self.published_text);
        self.retired.clear();
    }
}

/// Modifier keys, named as KeyboardEvent.key names them.
fn modifier_name(code: u16) -> Option<&'static str> {
    Some(match code {
        42 | 54 => "Shift",
        29 | 97 => "Control",
        56 | 100 => "Alt",
        125 | 126 => "Meta",
        58 => "CapsLock",
        464 => "Fn",
        _ => return None,
    })
}

/// Editing and function keys of the US layout, named as KeyboardEvent.key
/// names them. KEY_HOMEPAGE (172) reads as Home: the CardputerZero's launcher
/// labels that key HOME.
fn named_key(code: u16) -> Option<&'static str> {
    Some(match code {
        1 => "Escape",
        14 => "Backspace",
        15 => "Tab",
        28 | 96 => "Enter",
        59 => "F1",
        60 => "F2",
        61 => "F3",
        62 => "F4",
        63 => "F5",
        64 => "F6",
        65 => "F7",
        66 => "F8",
        67 => "F9",
        68 => "F10",
        87 => "F11",
        88 => "F12",
        102 | 172 => "Home",
        103 => "ArrowUp",
        104 => "PageUp",
        105 => "ArrowLeft",
        106 => "ArrowRight",
        107 => "End",
        108 => "ArrowDown",
        109 => "PageDown",
        110 => "Insert",
        111 => "Delete",
        113 => "AudioVolumeMute",
        114 => "AudioVolumeDown",
        115 => "AudioVolumeUp",
        116 => "Power",
        224 => "BrightnessDown",
        225 => "BrightnessUp",
        _ => return None,
    })
}

/// Character keys of the US layout: the plain and the shifted text.
fn character_key(code: u16) -> Option<(&'static str, &'static str)> {
    const DIGITS: [(&str, &str); 10] = [
        ("1", "!"),
        ("2", "@"),
        ("3", "#"),
        ("4", "$"),
        ("5", "%"),
        ("6", "^"),
        ("7", "&"),
        ("8", "*"),
        ("9", "("),
        ("0", ")"),
    ];
    const ROW1: [(&str, &str); 10] = [
        ("q", "Q"),
        ("w", "W"),
        ("e", "E"),
        ("r", "R"),
        ("t", "T"),
        ("y", "Y"),
        ("u", "U"),
        ("i", "I"),
        ("o", "O"),
        ("p", "P"),
    ];
    const ROW2: [(&str, &str); 9] = [
        ("a", "A"),
        ("s", "S"),
        ("d", "D"),
        ("f", "F"),
        ("g", "G"),
        ("h", "H"),
        ("j", "J"),
        ("k", "K"),
        ("l", "L"),
    ];
    const ROW3: [(&str, &str); 7] = [
        ("z", "Z"),
        ("x", "X"),
        ("c", "C"),
        ("v", "V"),
        ("b", "B"),
        ("n", "N"),
        ("m", "M"),
    ];
    Some(match code {
        2..=11 => DIGITS[code as usize - 2],
        16..=25 => ROW1[code as usize - 16],
        30..=38 => ROW2[code as usize - 30],
        44..=50 => ROW3[code as usize - 44],
        12 => ("-", "_"),
        13 => ("=", "+"),
        26 => ("[", "{"),
        27 => ("]", "}"),
        39 => (";", ":"),
        40 => ("'", "\""),
        41 => ("`", "~"),
        43 | 86 => ("\\", "|"),
        51 => (",", "<"),
        52 => (".", ">"),
        53 => ("/", "?"),
        57 => (" ", " "),
        55 => ("*", "*"),
        71 => ("7", "7"),
        72 => ("8", "8"),
        73 => ("9", "9"),
        74 => ("-", "-"),
        75 => ("4", "4"),
        76 => ("5", "5"),
        77 => ("6", "6"),
        78 => ("+", "+"),
        79 => ("1", "1"),
        80 => ("2", "2"),
        81 => ("3", "3"),
        82 => ("0", "0"),
        83 => (".", "."),
        98 => ("/", "/"),
        _ => return None,
    })
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
    fn key_names(frame: &InputFrameBuilder) -> Vec<(String, bool, bool)> {
        frame
            .text
            .iter()
            .map(|event| match event {
                TextEvent::Key {
                    key,
                    pressed,
                    repeat,
                } => (key.clone(), *pressed, *repeat),
                other => panic!("not a key: {other:?}"),
            })
            .collect()
    }
    #[test]
    fn keys_are_named_as_keyboard_events_with_shift_control_and_caps_lock() {
        let mut d = decoder();
        d.event(1, 30, 1);
        d.event(1, 30, 0);
        let f = report(&mut d);
        assert_eq!(
            key_names(&f),
            [("a".to_string(), true, false), ("a".to_string(), false, false)]
        );
        // Shift: letters upper-case, digits their US symbols; the modifier
        // itself is an event too.
        d.event(1, 42, 1);
        d.event(1, 30, 1);
        d.event(1, 3, 1);
        d.event(1, 103, 1);
        let f = report(&mut d);
        assert_eq!(
            key_names(&f).iter().map(|k| k.0.as_str()).collect::<Vec<_>>(),
            ["Shift", "A", "@", "Shift+ArrowUp"]
        );
        d.event(1, 30, 0);
        d.event(1, 3, 0);
        d.event(1, 103, 0);
        d.event(1, 42, 0);
        report(&mut d);
        // Control and Alt prefix the key; the letter stays lower-case.
        d.event(1, 29, 1);
        d.event(1, 44, 1);
        d.event(1, 44, 0);
        d.event(1, 29, 0);
        let f = report(&mut d);
        assert_eq!(
            key_names(&f).iter().map(|k| k.0.as_str()).collect::<Vec<_>>(),
            ["Control", "Control+z", "Control+z", "Control"]
        );
        // Caps lock toggles letters only; a kernel repeat is marked.
        d.event(1, 58, 1);
        d.event(1, 58, 0);
        d.event(1, 16, 1);
        d.event(1, 16, 2);
        d.event(1, 2, 1);
        let f = report(&mut d);
        assert_eq!(
            key_names(&f),
            [
                ("CapsLock".to_string(), true, false),
                ("CapsLock".to_string(), false, false),
                ("Q".to_string(), true, false),
                ("Q".to_string(), true, true),
                ("1".to_string(), true, false),
            ]
        );
        d.event(1, 16, 0);
        d.event(1, 2, 0);
        report(&mut d);
        // Named keys, the space bar as its character, and an unknown code
        // as nothing.
        for (code, name) in [(28, "Enter"), (1, "Escape"), (14, "Backspace"), (57, " "), (172, "Home")] {
            d.event(1, code, 1);
            d.event(1, code, 0);
            let f = report(&mut d);
            assert_eq!(key_names(&f)[0].0, name, "code {code}");
        }
        d.event(1, 700, 1);
        d.event(1, 700, 0);
        assert!(report(&mut d).text.is_empty());
        // Text is published with its SYN_REPORT and taken once.
        d.event(1, 30, 1);
        let mut f = InputFrameBuilder::new();
        d.append(&mut f);
        assert!(f.text.is_empty());
        d.event(0, 0, 0);
        let mut f = InputFrameBuilder::new();
        d.append(&mut f);
        assert_eq!(f.text.len(), 1);
        let mut f = InputFrameBuilder::new();
        d.append(&mut f);
        assert!(f.text.is_empty());
    }
    #[test]
    fn a_device_keymap_names_its_own_symbol_codes_before_the_us_layout() {
        let mut d = decoder();
        d.set_symbols(vec![(26, "!".to_string()), (74, "[".to_string())]);
        d.event(1, 42, 1);
        d.event(1, 26, 1);
        d.event(1, 74, 1);
        d.event(1, 27, 1);
        let f = report(&mut d);
        assert_eq!(
            key_names(&f).iter().map(|k| k.0.as_str()).collect::<Vec<_>>(),
            ["Shift", "!", "[", "}"]
        );
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
