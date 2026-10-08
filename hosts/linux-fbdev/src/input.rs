use std::fs::OpenOptions;
use std::io;
use std::os::fd::AsRawFd;
use std::os::unix::fs::OpenOptionsExt;

const EV_KEY: u16 = 0x01;
const EV_ABS: u16 = 0x03;
const BTN_TOUCH: u16 = 330;
const ABS_X: u16 = 0;
const ABS_Y: u16 = 1;
const ABS_MT_POSITION_X: u16 = 53;
const ABS_MT_POSITION_Y: u16 = 54;
const ABS_MT_TRACKING_ID: u16 = 57;
const WIDE_MARKER: u32 = 0x8000_0000;

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct InputEvent {
    time: libc::timeval,
    type_: u16,
    code: u16,
    value: i32,
}

pub struct TouchInput {
    file: std::fs::File,
    x: u32,
    y: u32,
    id: u32,
    down: bool,
}

impl TouchInput {
    pub fn open(path: &str) -> io::Result<Self> {
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NONBLOCK)
            .open(path)?;
        Ok(Self {
            file,
            x: 0,
            y: 0,
            id: 0,
            down: false,
        })
    }

    pub fn poll(&mut self) -> Vec<u32> {
        let fd = self.file.as_raw_fd();
        loop {
            let mut event = InputEvent::default();
            let n = unsafe {
                libc::read(
                    fd,
                    (&mut event as *mut InputEvent).cast(),
                    std::mem::size_of::<InputEvent>(),
                )
            };
            if n == std::mem::size_of::<InputEvent>() as isize {
                self.apply(event);
            } else if n < 0 && io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
                continue;
            } else {
                break;
            }
        }
        if self.down {
            vec![
                WIDE_MARKER
                    | ((self.id & 0xff) << 20)
                    | ((self.y & 0x3ff) << 10)
                    | (self.x & 0x3ff),
            ]
        } else {
            Vec::new()
        }
    }

    fn apply(&mut self, event: InputEvent) {
        match (event.type_, event.code) {
            (EV_KEY, BTN_TOUCH) => self.down = event.value != 0,
            (EV_ABS, ABS_X) | (EV_ABS, ABS_MT_POSITION_X) => {
                self.x = (event.value.max(0) as u32 / 2).min(359);
            }
            (EV_ABS, ABS_Y) | (EV_ABS, ABS_MT_POSITION_Y) => {
                self.y = (event.value.max(0) as u32 / 2).min(639);
            }
            (EV_ABS, ABS_MT_TRACKING_ID) if event.value >= 0 => {
                self.id = event.value as u32;
                self.down = true;
            }
            (EV_ABS, ABS_MT_TRACKING_ID) => self.down = false,
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(type_: u16, code: u16, value: i32) -> InputEvent {
        InputEvent {
            type_,
            code,
            value,
            ..InputEvent::default()
        }
    }

    #[test]
    fn packs_goodix_contact_in_wide_wire_format() {
        let mut input = TouchInput {
            file: OpenOptions::new().read(true).open("/dev/null").unwrap(),
            x: 0,
            y: 0,
            id: 0,
            down: false,
        };
        input.apply(event(EV_ABS, ABS_MT_TRACKING_ID, 7));
        input.apply(event(EV_ABS, ABS_MT_POSITION_X, 700));
        input.apply(event(EV_ABS, ABS_MT_POSITION_Y, 1200));
        assert_eq!(
            input.poll(),
            vec![WIDE_MARKER | (7 << 20) | (600 << 10) | 350]
        );
        input.apply(event(EV_ABS, ABS_MT_TRACKING_ID, -1));
        assert!(input.poll().is_empty());
    }
}
