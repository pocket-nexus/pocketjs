//! Interleaved signed 16-bit PCM playback. ALSA copies each submitted span;
//! returned calls never retain guest memory. Device teardown drops queued PCM.
use std::io;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Format {
    pub sample_rate: u32,
    pub channels: u32,
}
impl Format {
    pub fn validate(self) -> io::Result<Self> {
        if !pocket_spec::audio::RATES.contains(&self.sample_rate)
            || !(1..=2).contains(&self.channels)
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "unsupported PCM format",
            ));
        }
        Ok(self)
    }
    pub fn frames(self, samples: usize) -> io::Result<usize> {
        self.validate()?;
        if !samples.is_multiple_of(self.channels as usize) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "partial interleaved PCM frame",
            ));
        }
        Ok(samples / self.channels as usize)
    }
}
#[cfg(target_os = "linux")]
mod native;
#[cfg(target_os = "linux")]
pub use native::Pcm;
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_rates_channels_and_complete_frames() {
        let f = Format {
            sample_rate: 44100,
            channels: 2,
        };
        assert_eq!(f.frames(8).unwrap(), 4);
        assert!(f.frames(7).is_err());
        assert!(Format {
            sample_rate: 48000,
            channels: 2
        }
        .validate()
        .is_err());
        assert!(Format {
            sample_rate: 44100,
            channels: 0
        }
        .validate()
        .is_err());
    }
}
