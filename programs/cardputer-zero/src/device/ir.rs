//! Infrared signals: pulse and space durations in microseconds, pulse first,
//! as the kernel's LIRC devices read and write them (`/dev/lirc*`,
//! `LIRC_MODE_MODE2` in, `LIRC_MODE_PULSE` out). The NEC protocol is decoded
//! and encoded here; everything else is kept raw and replayed as captured.

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Signal {
    /// Durations in µs, pulse first, pulses and spaces alternating; an odd
    /// count ends on a pulse.
    pub pulses: Vec<u32>,
    pub carrier_hz: u32,
}

pub const DEFAULT_CARRIER_HZ: u32 = 38_000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Nec {
    pub address: u16,
    pub command: u8,
    /// A 16-bit address that is not an inverted 8-bit one.
    pub extended: bool,
}

fn near(value: u32, target: u32) -> bool {
    let tolerance = target / 4 + 100;
    value.abs_diff(target) <= tolerance
}

/// Decode an NEC frame: 9 ms mark, 4.5 ms space, 32 bits of 560 µs marks
/// followed by 560 µs (0) or 1690 µs (1) spaces, LSB first: address, its
/// complement (or an extended high byte), command, its complement.
pub fn decode_nec(pulses: &[u32]) -> Option<Nec> {
    if pulses.len() < 67 || !near(pulses[0], 9000) || !near(pulses[1], 4500) {
        return None;
    }
    let mut bits = 0u32;
    for bit in 0..32 {
        let mark = pulses[2 + bit * 2];
        let space = pulses[3 + bit * 2];
        if !near(mark, 560) {
            return None;
        }
        let one = if near(space, 1690) {
            true
        } else if near(space, 560) {
            false
        } else {
            return None;
        };
        if one {
            bits |= 1 << bit;
        }
    }
    let bytes = bits.to_le_bytes();
    if bytes[2] != !bytes[3] {
        return None;
    }
    let extended = bytes[0] != !bytes[1];
    Some(Nec {
        address: if extended { u16::from_le_bytes([bytes[0], bytes[1]]) } else { bytes[0] as u16 },
        command: bytes[2],
        extended,
    })
}

/// An NEC frame for `address` and `command`; a 16-bit address sends the
/// extended form.
pub fn encode_nec(address: u16, command: u8) -> Vec<u32> {
    let [low, high] = address.to_le_bytes();
    let bytes = if address > 0xff { [low, high, command, !command] } else { [low, !low, command, !command] };
    let bits = u32::from_le_bytes(bytes);
    let mut out = Vec::with_capacity(68);
    out.push(9000);
    out.push(4500);
    for bit in 0..32 {
        out.push(560);
        out.push(if bits >> bit & 1 == 1 { 1690 } else { 560 });
    }
    out.push(560);
    out
}

/// The protocol name shown for a capture.
pub fn protocol(pulses: &[u32]) -> String {
    if decode_nec(pulses).is_some() {
        "NEC".into()
    } else if pulses.len() >= 3 {
        "raw".into()
    } else {
        "empty".into()
    }
}

#[cfg(target_os = "linux")]
pub mod lirc {
    use super::*;
    use std::{
        fs::{File, OpenOptions},
        io::{self, Read, Write},
        os::fd::AsRawFd,
        path::{Path, PathBuf},
        time::{Duration, Instant},
    };

    const LIRC_GET_FEATURES: libc::c_ulong = 0x8004_6900;
    const LIRC_SET_SEND_MODE: libc::c_ulong = 0x4004_6911;
    const LIRC_SET_REC_MODE: libc::c_ulong = 0x4004_6912;
    const LIRC_SET_SEND_CARRIER: libc::c_ulong = 0x4004_6913;
    const LIRC_SET_REC_TIMEOUT: libc::c_ulong = 0x4004_6918;
    const LIRC_SET_REC_TIMEOUT_REPORTS: libc::c_ulong = 0x4004_6919;
    const LIRC_MODE_PULSE: u32 = 0x2;
    const LIRC_MODE_MODE2: u32 = 0x4;
    pub const LIRC_CAN_SEND_PULSE: u32 = 0x2;
    pub const LIRC_CAN_REC_MODE2: u32 = 0x4 << 16;
    const LIRC_CAN_SET_SEND_CARRIER: u32 = 0x100;
    const LIRC_CAN_SET_REC_TIMEOUT: u32 = 0x1000_0000;
    const MODE2_MASK: u32 = 0xff00_0000;
    const MODE2_PULSE: u32 = 0x0100_0000;
    const MODE2_SPACE: u32 = 0x0000_0000;
    const MODE2_TIMEOUT: u32 = 0x0300_0000;
    const VALUE_MASK: u32 = 0x00ff_ffff;

    fn features(path: &Path) -> io::Result<u32> {
        let file = File::open(path)?;
        let mut value: u32 = 0;
        if unsafe { libc::ioctl(file.as_raw_fd(), LIRC_GET_FEATURES, &mut value) } < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(value)
    }

    fn set(file: &File, request: libc::c_ulong, value: u32) -> io::Result<()> {
        let mut value = value;
        if unsafe { libc::ioctl(file.as_raw_fd(), request, &mut value) } < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    /// The first `/dev/lirc*` node with `capability`.
    pub fn find(capability: u32) -> Option<PathBuf> {
        let mut nodes: Vec<PathBuf> = std::fs::read_dir("/dev")
            .ok()?
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| path.file_name().is_some_and(|name| name.to_string_lossy().starts_with("lirc")))
            .collect();
        nodes.sort();
        nodes.into_iter().find(|path| features(path).is_ok_and(|bits| bits & capability != 0))
    }

    /// Write `signal` to the transmitter at `path`.
    pub fn send(path: &Path, signal: &Signal) -> io::Result<()> {
        let bits = features(path)?;
        let mut file = OpenOptions::new().write(true).open(path)?;
        set(&file, LIRC_SET_SEND_MODE, LIRC_MODE_PULSE)?;
        if bits & LIRC_CAN_SET_SEND_CARRIER != 0 {
            let _ = set(&file, LIRC_SET_SEND_CARRIER, signal.carrier_hz);
        }
        let mut durations: Vec<u32> = signal.pulses.clone();
        if durations.len() % 2 == 0 {
            durations.pop();
        }
        if durations.is_empty() {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "empty signal"));
        }
        let bytes: Vec<u8> = durations.iter().flat_map(|d| d.to_ne_bytes()).collect();
        file.write_all(&bytes)
    }

    /// Wait up to `deadline` for one signal on the receiver at `path`: the
    /// durations from its first pulse to a gap of 60 ms (or the device's
    /// timeout report). `stop` ends the wait early.
    pub fn receive(path: &Path, deadline: Duration, stop: &dyn Fn() -> bool) -> io::Result<Option<Vec<u32>>> {
        let bits = features(path)?;
        let file = OpenOptions::new().read(true).open(path)?;
        set(&file, LIRC_SET_REC_MODE, LIRC_MODE_MODE2)?;
        if bits & LIRC_CAN_SET_REC_TIMEOUT != 0 {
            let _ = set(&file, LIRC_SET_REC_TIMEOUT, 60_000);
            let _ = set(&file, LIRC_SET_REC_TIMEOUT_REPORTS, 1);
        }
        let fd = file.as_raw_fd();
        let started = Instant::now();
        let mut durations: Vec<u32> = Vec::new();
        let mut buffer = [0u8; 4 * 256];
        let mut reader = &file;
        loop {
            if stop() || started.elapsed() > deadline {
                return Ok(if durations.len() >= 3 { Some(durations) } else { None });
            }
            let mut poll = libc::pollfd { fd, events: libc::POLLIN, revents: 0 };
            let ready = unsafe { libc::poll(&mut poll, 1, 50) };
            if ready <= 0 {
                if !durations.is_empty() && durations.len() % 2 == 1 {
                    // Silence after the last pulse: the signal is complete.
                    return Ok(Some(durations));
                }
                continue;
            }
            let n = reader.read(&mut buffer)?;
            for chunk in buffer[..n].chunks_exact(4) {
                let value = u32::from_ne_bytes(chunk.try_into().unwrap());
                let duration = value & VALUE_MASK;
                match value & MODE2_MASK {
                    MODE2_PULSE => {
                        if durations.len() % 2 == 0 {
                            durations.push(duration);
                        } else if let Some(last) = durations.last_mut() {
                            *last += duration;
                        }
                    }
                    MODE2_SPACE => {
                        if durations.is_empty() {
                            continue;
                        }
                        if duration >= 60_000 {
                            return Ok(Some(durations));
                        }
                        if durations.len() % 2 == 1 {
                            durations.push(duration);
                        } else if let Some(last) = durations.last_mut() {
                            *last += duration;
                        }
                    }
                    MODE2_TIMEOUT => {
                        if !durations.is_empty() {
                            if durations.len() % 2 == 0 {
                                durations.pop();
                            }
                            return Ok(Some(durations));
                        }
                    }
                    _ => {}
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nec_frames_round_trip_and_other_timings_stay_raw() {
        let frame = encode_nec(0x04, 0x08);
        assert_eq!(frame.len(), 67);
        assert_eq!(decode_nec(&frame), Some(Nec { address: 4, command: 8, extended: false }));
        let extended = encode_nec(0x1234, 0xa5);
        assert_eq!(decode_nec(&extended), Some(Nec { address: 0x1234, command: 0xa5, extended: true }));
        // Timing slop within a quarter is accepted.
        let loose: Vec<u32> = frame.iter().map(|d| d + d / 8).collect();
        assert_eq!(decode_nec(&loose).map(|n| n.command), Some(8));
        assert_eq!(decode_nec(&[9000, 4500, 560]), None);
        let mut broken = frame.clone();
        broken[3] = 3000;
        assert_eq!(decode_nec(&broken), None);
        assert_eq!(protocol(&frame), "NEC");
        assert_eq!(protocol(&[300, 400, 300]), "raw");
        assert_eq!(protocol(&[300]), "empty");
    }
}
