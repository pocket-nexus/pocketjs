use super::Format;
use std::{
    ffi::{c_char, c_int, c_long, c_uint, c_ulong, c_void, CStr, CString},
    io,
    ptr::NonNull,
    time::{Duration, Instant},
};
#[link(name = "asound")]
unsafe extern "C" {
    fn snd_pcm_open(
        pcm: *mut *mut c_void,
        name: *const c_char,
        stream: c_int,
        mode: c_int,
    ) -> c_int;
    fn snd_pcm_set_params(
        pcm: *mut c_void,
        format: c_int,
        access: c_int,
        channels: c_uint,
        rate: c_uint,
        resample: c_int,
        latency: c_uint,
    ) -> c_int;
    fn snd_pcm_writei(pcm: *mut c_void, buffer: *const c_void, size: c_ulong) -> c_long;
    fn snd_pcm_recover(pcm: *mut c_void, error: c_int, silent: c_int) -> c_int;
    fn snd_pcm_wait(pcm: *mut c_void, timeout: c_int) -> c_int;
    fn snd_pcm_drain(pcm: *mut c_void) -> c_int;
    fn snd_pcm_drop(pcm: *mut c_void) -> c_int;
    fn snd_pcm_close(pcm: *mut c_void) -> c_int;
    fn snd_strerror(error: c_int) -> *const c_char;
}
fn error(code: c_int) -> io::Error {
    let message = unsafe { CStr::from_ptr(snd_strerror(code)) }.to_string_lossy();
    io::Error::other(message.into_owned())
}
pub struct Pcm {
    handle: NonNull<c_void>,
    format: Format,
    failed: bool,
}
impl Pcm {
    pub fn open(device: &str, format: Format) -> io::Result<Self> {
        format.validate()?;
        if cfg!(target_endian = "big") {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "PCM samples require a little-endian host",
            ));
        }
        let name = CString::new(device)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "invalid PCM device name"))?;
        let mut pointer = std::ptr::null_mut();
        let result = unsafe { snd_pcm_open(&mut pointer, name.as_ptr(), 0, 1) };
        if result < 0 {
            return Err(error(result));
        }
        let mut pcm = Self {
            handle: NonNull::new(pointer)
                .ok_or_else(|| io::Error::other("ALSA returned no handle"))?,
            format,
            failed: false,
        };
        let result = unsafe {
            snd_pcm_set_params(
                pcm.pointer(),
                2,
                3,
                format.channels,
                format.sample_rate,
                1,
                50_000,
            )
        };
        if result < 0 {
            pcm.failed = true;
            return Err(error(result));
        }
        Ok(pcm)
    }
    fn pointer(&self) -> *mut c_void {
        self.handle.as_ptr()
    }
    fn fail(&mut self, error: io::Error) -> io::Error {
        unsafe {
            snd_pcm_drop(self.pointer());
        }
        self.failed = true;
        error
    }
    pub fn write(&mut self, samples: &[i16]) -> io::Result<usize> {
        let frames = self.format.frames(samples.len())?;
        if self.failed {
            return Err(io::Error::other("PCM device stopped"));
        }
        let mut at = 0;
        let deadline = Instant::now() + Duration::from_secs(2);
        while at < frames {
            if Instant::now() >= deadline {
                return Err(self.fail(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "PCM write timed out",
                )));
            }
            let result = unsafe {
                snd_pcm_writei(
                    self.pointer(),
                    samples[at * self.format.channels as usize..]
                        .as_ptr()
                        .cast(),
                    (frames - at).min(c_ulong::MAX as usize) as c_ulong,
                )
            };
            if result > 0 {
                at += result as usize;
                continue;
            }
            if result == 0 || result == -(libc::EAGAIN as c_long) {
                let result = unsafe { snd_pcm_wait(self.pointer(), 50) };
                if result < 0 && result != -libc::EINTR {
                    return Err(self.fail(error(result)));
                }
                continue;
            }
            let recovered = unsafe { snd_pcm_recover(self.pointer(), result as c_int, 1) };
            if recovered < 0 {
                return Err(self.fail(error(recovered)));
            }
        }
        Ok(frames)
    }
    pub fn drain(&mut self) -> io::Result<()> {
        if self.failed {
            return Err(io::Error::other("PCM device stopped"));
        }
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let result = unsafe { snd_pcm_drain(self.pointer()) };
            if result >= 0 {
                return Ok(());
            }
            if result != -libc::EAGAIN {
                return Err(self.fail(error(result)));
            }
            if Instant::now() >= deadline {
                return Err(self.fail(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "PCM drain timed out",
                )));
            }
            std::thread::sleep(Duration::from_millis(1));
        }
    }
}
impl Drop for Pcm {
    fn drop(&mut self) {
        unsafe {
            snd_pcm_drop(self.pointer());
            snd_pcm_close(self.pointer());
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn null_plugin_accepts_pcm_and_drain() {
        let mut pcm = Pcm::open(
            "null",
            Format {
                sample_rate: 44100,
                channels: 2,
            },
        )
        .unwrap();
        assert_eq!(pcm.write(&[0; 1024]).unwrap(), 512);
        pcm.drain().unwrap();
    }
    #[test]
    fn malformed_device_and_pcm_are_rejected() {
        assert!(Pcm::open(
            "missing-pocket-device",
            Format {
                sample_rate: 44100,
                channels: 2
            }
        )
        .is_err());
        let mut pcm = Pcm::open(
            "null",
            Format {
                sample_rate: 22050,
                channels: 2,
            },
        )
        .unwrap();
        assert!(pcm.write(&[0; 3]).is_err());
        assert_eq!(pcm.write(&[0; 4]).unwrap(), 2);
    }
}
