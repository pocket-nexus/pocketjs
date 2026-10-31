//! The TRIMUI Player1 gamepad (a uinput device trimui_inputd publishes): an
//! Xbox-shaped report. Buttons are named by position, so `a` is the right face
//! button and `b` the bottom one, matching the labels on the shell.
use pocket_arcade::game::Pad;
use std::{fs::File, io::Read, os::fd::AsRawFd};

pub const UP: u32 = 1;
pub const DOWN: u32 = 2;
pub const LEFT: u32 = 4;
pub const RIGHT: u32 = 8;
pub const A: u32 = 16;
pub const B: u32 = 32;
pub const X: u32 = 64;
pub const Y: u32 = 128;
pub const L: u32 = 256;
pub const R: u32 = 512;
pub const START: u32 = 1024;
pub const SELECT: u32 = 2048;
pub const MENU: u32 = 4096;

const EV_KEY: u16 = 1;
const EV_ABS: u16 = 3;
const EVIOCGABS_BASE: u32 = 0x8018_4540;
const DEADZONE: f32 = 0.18;
const EVENT_BYTES: usize = 24;

/// One axis's kernel range, as EVIOCGABS reports it.
#[derive(Clone, Copy)]
struct Range {
    min: i32,
    max: i32,
}

impl Range {
    fn stick(self, value: i32) -> f32 {
        if self.max <= self.min {
            return 0.0;
        }
        let v = 2.0 * (value - self.min) as f32 / (self.max - self.min) as f32 - 1.0;
        if v.abs() < DEADZONE {
            0.0
        } else {
            v.clamp(-1.0, 1.0)
        }
    }
    fn trigger(self, value: i32) -> f32 {
        if self.max <= self.min {
            return 0.0;
        }
        ((value - self.min) as f32 / (self.max - self.min) as f32).clamp(0.0, 1.0)
    }
}

pub fn key_bit(code: u16) -> u32 {
    match code {
        0x130 => B,
        0x131 => A,
        0x133 => X,
        0x134 => Y,
        0x136 => L,
        0x137 => R,
        0x13a => SELECT,
        0x13b => START,
        0x13c => MENU,
        _ => 0,
    }
}

pub struct Gamepad {
    file: Option<File>,
    ranges: [Range; 6],
    hat: [i32; 2],
    pub pad: Pad,
}

fn find_device() -> Option<String> {
    let devices = std::fs::read_to_string("/proc/bus/input/devices").ok()?;
    let mut trimui = false;
    for line in devices.lines() {
        if line.starts_with("N: ") {
            trimui = line.contains("TRIMUI Player1");
        }
        if trimui && line.starts_with("H: Handlers=") {
            let event = line
                .split_whitespace()
                .find(|word| word.starts_with("event"))?;
            return Some(format!("/dev/input/{event}"));
        }
    }
    None
}

impl Gamepad {
    pub fn open() -> Self {
        let file = find_device().and_then(|path| File::open(path).ok());
        let mut ranges = [Range { min: 0, max: 0 }; 6];
        if let Some(file) = &file {
            unsafe {
                libc::fcntl(file.as_raw_fd(), libc::F_SETFL, libc::O_NONBLOCK);
                for (axis, range) in ranges.iter_mut().enumerate() {
                    let mut info = [0i32; 6];
                    if libc::ioctl(
                        file.as_raw_fd(),
                        (EVIOCGABS_BASE + axis as u32) as _,
                        info.as_mut_ptr(),
                    ) == 0
                    {
                        *range = Range {
                            min: info[1],
                            max: info[2],
                        };
                    }
                }
            }
        }
        Self {
            file,
            ranges,
            hat: [0; 2],
            pad: Pad::default(),
        }
    }

    /// Drain pending events into the current pad state.
    pub fn poll(&mut self) -> Pad {
        let mut buffer = [0u8; EVENT_BYTES * 32];
        while let Some(file) = self.file.as_mut() {
            let Ok(read) = file.read(&mut buffer) else {
                break;
            };
            if read == 0 {
                break;
            }
            for event in buffer[..read].chunks_exact(EVENT_BYTES) {
                let kind = u16::from_le_bytes([event[16], event[17]]);
                let code = u16::from_le_bytes([event[18], event[19]]);
                let value = i32::from_le_bytes([event[20], event[21], event[22], event[23]]);
                self.apply(kind, code, value);
            }
        }
        self.pad
    }

    pub fn apply(&mut self, kind: u16, code: u16, value: i32) {
        match kind {
            EV_KEY => {
                let bit = key_bit(code);
                if value != 0 {
                    self.pad.buttons |= bit;
                } else {
                    self.pad.buttons &= !bit;
                }
            }
            EV_ABS => match code {
                0 => self.pad.axes[0] = self.ranges[0].stick(value),
                1 => self.pad.axes[1] = self.ranges[1].stick(value),
                2 => self.pad.triggers[0] = self.ranges[2].trigger(value),
                3 => self.pad.axes[2] = self.ranges[3].stick(value),
                4 => self.pad.axes[3] = self.ranges[4].stick(value),
                5 => self.pad.triggers[1] = self.ranges[5].trigger(value),
                0x10 | 0x11 => {
                    self.hat[(code - 0x10) as usize] = value;
                    self.pad.buttons &= !(UP | DOWN | LEFT | RIGHT);
                    self.pad.buttons |= match self.hat[0] {
                        v if v < 0 => LEFT,
                        v if v > 0 => RIGHT,
                        _ => 0,
                    } | match self.hat[1] {
                        v if v < 0 => UP,
                        v if v > 0 => DOWN,
                        _ => 0,
                    };
                }
                _ => {}
            },
            _ => {}
        }
    }
}

/// The PocketJS button bits of a pad: Circle confirms, Cross goes back, as the
/// physical right and bottom buttons do on this shell.
pub fn pocket_buttons(buttons: u32) -> u32 {
    use pocket_spec::btn;
    let mut out = 0;
    for (from, to) in [
        (UP, btn::UP),
        (DOWN, btn::DOWN),
        (LEFT, btn::LEFT),
        (RIGHT, btn::RIGHT),
        (A, btn::CIRCLE),
        (B, btn::CROSS),
        (X, btn::TRIANGLE),
        (Y, btn::SQUARE),
        (L, btn::LTRIGGER),
        (R, btn::RTRIGGER),
        (START, btn::START),
        (SELECT, btn::SELECT),
    ] {
        if buttons & from != 0 {
            out |= to;
        }
    }
    out
}
