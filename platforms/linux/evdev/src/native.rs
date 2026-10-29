use super::*;
use pocket_drivers::{InputClasses, InputSource};
use std::{
    fs::{File, OpenOptions},
    io::Read,
    os::{fd::AsRawFd, unix::fs::OpenOptionsExt},
    path::Path,
};
#[repr(C)]
#[derive(Default)]
struct AbsInfo {
    value: i32,
    minimum: i32,
    maximum: i32,
    fuzz: i32,
    flat: i32,
    resolution: i32,
}
fn request(number: u8, length: usize) -> libc::c_ulong {
    (2u32 << 30 | (length as u32) << 16 | u32::from(b'E') << 8 | u32::from(number)) as libc::c_ulong
}
fn bits(file: &File, kind: u8) -> io::Result<[u8; 96]> {
    let mut bytes = [0; 96];
    if unsafe {
        libc::ioctl(
            file.as_raw_fd(),
            request(0x20 + kind, bytes.len()),
            bytes.as_mut_ptr(),
        )
    } < 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(bytes)
}
fn has(bits: &[u8], bit: usize) -> bool {
    bits.get(bit / 8).is_some_and(|v| v & (1 << (bit % 8)) != 0)
}
fn range(file: &File, code: u8) -> Option<AxisRange> {
    let mut value = AbsInfo::default();
    if unsafe {
        libc::ioctl(
            file.as_raw_fd(),
            request(0x40 + code, size_of::<AbsInfo>()),
            &mut value,
        )
    } < 0
        || value.maximum <= value.minimum
    {
        return None;
    }
    Some(AxisRange {
        min: value.minimum,
        max: value.maximum,
    })
}
pub struct Evdev {
    file: Option<File>,
    decoder: Decoder,
    bytes: EventBytes,
    classes: InputClasses,
}
impl Evdev {
    pub fn open(
        path: impl AsRef<Path>,
        extent: [u32; 2],
        first_contact: u32,
        count: u32,
    ) -> io::Result<Self> {
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NONBLOCK | libc::O_CLOEXEC)
            .open(path)?;
        let events = bits(&file, 0)?;
        let keys = if has(&events, 1) {
            bits(&file, 1)?
        } else {
            [0; 96]
        };
        let absolute = if has(&events, 3) {
            bits(&file, 3)?
        } else {
            [0; 96]
        };
        let relative = if has(&events, 2) {
            bits(&file, 2)?
        } else {
            [0; 96]
        };
        let type_b = has(&absolute, 47);
        let touch = type_b && has(&absolute, 53) && has(&absolute, 54) && has(&absolute, 57)
            || has(&keys, 330) && has(&absolute, 0) && has(&absolute, 1);
        let pointer = has(&relative, 0) && has(&relative, 1);
        let buttons = [
            103, 108, 105, 106, 28, 57, 44, 304, 305, 315, 544, 545, 546, 547,
        ]
        .iter()
        .any(|key| has(&keys, *key))
            || has(&absolute, 16) && has(&absolute, 17);
        let mut classes = InputClasses::NONE;
        if touch {
            classes |= InputClasses::CONTACT;
        }
        if pointer {
            classes |= InputClasses::POINTER;
        }
        if buttons {
            classes |= InputClasses::BUTTONS;
        }
        let codes = if has(&absolute, 53) { [53, 54] } else { [0, 1] };
        let ranges = [
            range(&file, codes[0]).unwrap_or(AxisRange {
                min: 0,
                max: extent[0] as i32 - 1,
            }),
            range(&file, codes[1]).unwrap_or(AxisRange {
                min: 0,
                max: extent[1] as i32 - 1,
            }),
        ];
        let mut decoder = Decoder::new(extent, ranges, first_contact, count)?;
        decoder.pointer_enabled = pointer;
        decoder.accept_multitouch = type_b;
        Ok(Self {
            file: Some(file),
            decoder,
            bytes: EventBytes::new(size_of::<libc::c_long>())?,
            classes,
        })
    }
}
impl Evdev {
    /// Routes this device's contacts and pointer to `surface` (0 primary,
    /// 1 auxiliary) with that surface's logical extent.
    pub fn set_surface(&mut self, surface: u32, extent: [u32; 2]) -> io::Result<()> {
        self.decoder.set_surface(surface, extent)
    }
    /// Replaces the default key table for this device (see Decoder::set_keymap).
    pub fn set_keymap(&mut self, keymap: &[(u16, u32)]) {
        self.decoder.set_keymap(keymap);
    }
}
impl InputSource for Evdev {
    fn classes(&self) -> InputClasses {
        self.classes
    }
    fn poll(&mut self, frame: &mut InputFrameBuilder) {
        // A producer cannot monopolize a logical tick. Unread events stay in the
        // kernel; partial reports remain private until their SYN_REPORT arrives.
        let mut buffer = [0u8; 768];
        for _ in 0..8 {
            let Some(file) = self.file.as_mut() else {
                break;
            };
            match file.read(&mut buffer) {
                Ok(0) => {
                    self.decoder.disconnect();
                    self.file = None;
                    break;
                }
                Ok(n) => self.bytes.feed(&buffer[..n], &mut self.decoder),
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => break,
                Err(_) => {
                    self.decoder.disconnect();
                    self.file = None;
                    break;
                }
            }
        }
        self.decoder.append(frame);
    }
}
