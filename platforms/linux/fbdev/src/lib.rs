//! Linux framebuffer output with validated geometry and CPU staging. Scanout
//! never borrows renderer memory, and an unsuccessful write is terminal.
use pocket_drivers::{
    BufferIdentity, DisplayDescriptor, DisplayError, DisplayOutput, DisplayRole, PixelFormat, Rect,
    Surface, Target, TargetOwnership, VsyncSource,
};
use std::io;

#[derive(Clone, Copy, Debug)]
pub struct Channel {
    pub offset: u32,
    pub bits: u32,
}
#[derive(Clone, Copy, Debug)]
pub struct Geometry {
    pub width: u32,
    pub height: u32,
    pub x_offset: u32,
    pub y_offset: u32,
    pub stride: usize,
    pub mapping_bytes: usize,
    pub bits_per_pixel: u32,
    pub red: Channel,
    pub green: Channel,
    pub blue: Channel,
    pub alpha: Channel,
}
impl Geometry {
    pub fn validate(&self) -> io::Result<()> {
        if self.width == 0 || self.height == 0 || ![16, 24, 32].contains(&self.bits_per_pixel) {
            return Err(invalid("unsupported framebuffer geometry"));
        }
        let pixel = self.bits_per_pixel as usize / 8;
        let row = (self.x_offset as usize)
            .checked_add(self.width as usize)
            .and_then(|n| n.checked_mul(pixel))
            .ok_or_else(|| invalid("row overflow"))?;
        let end = (self.y_offset as usize)
            .checked_add(self.height as usize - 1)
            .and_then(|n| n.checked_mul(self.stride))
            .and_then(|n| n.checked_add(row))
            .ok_or_else(|| invalid("mapping overflow"))?;
        if row > self.stride || end > self.mapping_bytes || self.mapping_bytes > isize::MAX as usize
        {
            return Err(invalid("framebuffer mapping is too small"));
        }
        let mut mask = 0u64;
        for (index, channel) in [self.red, self.green, self.blue, self.alpha]
            .iter()
            .enumerate()
        {
            if channel.bits == 0 {
                if index != 3 {
                    return Err(invalid("missing color channel"));
                }
                continue;
            }
            if channel.bits > 8
                || channel
                    .offset
                    .checked_add(channel.bits)
                    .is_none_or(|end| end > self.bits_per_pixel)
            {
                return Err(invalid("unsupported color channel"));
            }
            let bits = ((1u64 << channel.bits) - 1) << channel.offset;
            if mask & bits != 0 {
                return Err(invalid("overlapping color channels"));
            }
            mask |= bits;
        }
        Ok(())
    }
    fn pack(&self, argb: &[u8]) -> u32 {
        [self.blue, self.green, self.red, self.alpha]
            .iter()
            .zip(argb)
            .fold(0, |word, (channel, value)| {
                if channel.bits == 0 {
                    word
                } else {
                    word | (((u32::from(*value) * ((1 << channel.bits) - 1) + 127) / 255)
                        << channel.offset)
                }
            })
    }
}
fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}
fn checked_region(region: Rect, width: u32, height: u32) -> Result<(), DisplayError> {
    if region.width == 0
        || region.height == 0
        || region.x.checked_add(region.width).is_none_or(|x| x > width)
        || region
            .y
            .checked_add(region.height)
            .is_none_or(|y| y > height)
    {
        Err(DisplayError::InvalidTarget)
    } else {
        Ok(())
    }
}
/// Implementations copy synchronously; no source span may be retained.
pub trait FrameStore {
    fn bytes_mut(&mut self) -> &mut [u8];
}
impl FrameStore for Vec<u8> {
    fn bytes_mut(&mut self) -> &mut [u8] {
        self
    }
}

pub struct Framebuffer<S: FrameStore> {
    store: S,
    geometry: Geometry,
    staging: Vec<u8>,
    sequence: u64,
    pending: Option<u64>,
    acquired: bool,
    partial_refresh: bool,
}
impl<S: FrameStore> Framebuffer<S> {
    pub fn new(mut store: S, geometry: Geometry) -> io::Result<Self> {
        geometry.validate()?;
        if store.bytes_mut().len() < geometry.mapping_bytes {
            return Err(invalid("store is shorter than mapping"));
        }
        let length = (geometry.width as usize)
            .checked_mul(geometry.height as usize)
            .and_then(|n| n.checked_mul(4))
            .filter(|n| *n <= isize::MAX as usize)
            .ok_or_else(|| invalid("staging overflow"))?;
        let mut staging = Vec::new();
        staging
            .try_reserve_exact(length)
            .map_err(|_| invalid("staging allocation failed"))?;
        staging.resize(length, 0);
        Ok(Self {
            store,
            geometry,
            staging,
            sequence: 0,
            pending: None,
            acquired: false,
            partial_refresh: false,
        })
    }
    /// Report partial refresh: the presenter then draws and flushes only the
    /// regions that changed. The staging frame is retained, so this holds
    /// while no other process writes the framebuffer.
    pub fn set_partial_refresh(&mut self, on: bool) {
        self.partial_refresh = on;
    }
    #[cfg(test)]
    fn storage(&mut self) -> &mut [u8] {
        self.store.bytes_mut()
    }
}
impl<S: FrameStore> DisplayOutput for Framebuffer<S> {
    type Token = u64;
    fn descriptor(&self) -> DisplayDescriptor {
        let mut d = DisplayDescriptor::new(
            DisplayRole::Primary,
            self.geometry.width,
            self.geometry.height,
            PixelFormat::Argb8888,
            self.geometry.width as usize * 4,
            TargetOwnership::CpuVisible,
        );
        d.vsync = VsyncSource::Timer;
        d.partial_refresh = self.partial_refresh;
        d
    }
    fn frame_identity(&mut self) -> Result<Option<BufferIdentity>, DisplayError> {
        if self.pending.is_some() {
            return Err(DisplayError::InvalidTarget);
        }
        Ok(Some(BufferIdentity {
            buffer: 1,
            generation: 0,
        }))
    }
    fn acquire(&mut self, region: Rect) -> Result<Target<'_>, DisplayError> {
        if self.pending.is_some() {
            return Err(DisplayError::InvalidTarget);
        }
        checked_region(region, self.geometry.width, self.geometry.height)?;
        self.acquired = true;
        let stride = self.geometry.width as usize * 4;
        let offset = region.y as usize * stride + region.x as usize * 4;
        Ok(Target::CpuVisible(Surface::new(
            &mut self.staging[offset..],
            region,
            stride,
            PixelFormat::Argb8888,
        )?))
    }
    fn flush(&mut self, regions: &[Rect]) -> Result<u64, DisplayError> {
        if self.pending.is_some() || !self.acquired || regions.is_empty() {
            return Err(DisplayError::InvalidTarget);
        }
        for region in regions {
            checked_region(*region, self.geometry.width, self.geometry.height)?;
        }
        let sequence = self.sequence.checked_add(1).ok_or(DisplayError::Failed)?;
        let geometry = self.geometry;
        let pixel_bytes = geometry.bits_per_pixel as usize / 8;
        let output = self.store.bytes_mut();
        for region in regions {
            for y in region.y..region.y + region.height {
                for x in region.x..region.x + region.width {
                    let input = (y as usize * geometry.width as usize + x as usize) * 4;
                    let at = (y as usize + geometry.y_offset as usize) * geometry.stride
                        + (x as usize + geometry.x_offset as usize) * pixel_bytes;
                    let packed = geometry.pack(&self.staging[input..input + 4]).to_le_bytes();
                    output[at..at + pixel_bytes].copy_from_slice(&packed[..pixel_bytes]);
                }
            }
        }
        self.sequence = sequence;
        self.pending = Some(sequence);
        self.acquired = false;
        Ok(sequence)
    }
    fn wait(&mut self, token: u64) -> Result<(), DisplayError> {
        if self.pending != Some(token) {
            return Err(DisplayError::InvalidTarget);
        }
        self.pending = None;
        Ok(())
    }
    fn vsync(&mut self) -> VsyncSource {
        VsyncSource::Timer
    }
}

#[cfg(target_os = "linux")]
mod native;
#[cfg(target_os = "linux")]
pub use native::{open, Mapping};

#[cfg(test)]
mod tests {
    use super::*;
    fn geometry() -> Geometry {
        Geometry {
            width: 2,
            height: 2,
            x_offset: 1,
            y_offset: 1,
            stride: 10,
            mapping_bytes: 30,
            bits_per_pixel: 16,
            red: Channel {
                offset: 11,
                bits: 5,
            },
            green: Channel { offset: 5, bits: 6 },
            blue: Channel { offset: 0, bits: 5 },
            alpha: Channel { offset: 0, bits: 0 },
        }
    }
    #[test]
    fn padded_scrolled_framebuffer_only_writes_acquired_damage() {
        let mut display = Framebuffer::new(vec![0xa5; 30], geometry()).unwrap();
        let region = Rect::new(1, 0, 1, 1);
        let Target::CpuVisible(mut surface) = display.acquire(region).unwrap() else {
            panic!()
        };
        surface.pixels_mut()[..4].copy_from_slice(&[0, 0, 255, 255]);
        let token = display.flush(&[region]).unwrap();
        assert!(display.acquire(region).is_err());
        assert!(display.wait(token + 1).is_err());
        display.wait(token).unwrap();
        let mut expected = vec![0xa5; 30];
        expected[14..16].copy_from_slice(&0xf800u16.to_le_bytes());
        assert_eq!(display.storage(), expected);
        assert!(display.wait(token).is_err());
    }
    #[test]
    fn partial_refresh_is_reported_once_set() {
        let mut display = Framebuffer::new(vec![0; 30], geometry()).unwrap();
        assert!(!display.descriptor().partial_refresh);
        display.set_partial_refresh(true);
        assert!(display.descriptor().partial_refresh);
    }
    #[test]
    fn rejects_mapping_overflow_and_aliased_channels() {
        let mut g = geometry();
        g.mapping_bytes = 22;
        assert!(g.validate().is_err());
        g = geometry();
        g.red.offset = 5;
        assert!(g.validate().is_err());
        g = geometry();
        g.y_offset = u32::MAX;
        assert!(g.validate().is_err());
    }
}
