//! Display targets and the acquire, flush, wait lifecycle.

use crate::abi;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[non_exhaustive]
#[repr(u32)]
pub enum PixelFormat {
    Rgb565 = abi::POCKET_PIXEL_FORMAT_RGB565,
    Rgba8888 = abi::POCKET_PIXEL_FORMAT_RGBA8888,
    Argb8888 = abi::POCKET_PIXEL_FORMAT_ARGB8888,
    Bgr888 = abi::POCKET_PIXEL_FORMAT_BGR888,
    Gray8 = abi::POCKET_PIXEL_FORMAT_GRAY8,
    Gray4 = abi::POCKET_PIXEL_FORMAT_GRAY4,
    Mono1 = abi::POCKET_PIXEL_FORMAT_MONO1,
}

impl PixelFormat {
    pub const fn bits_per_pixel(self) -> usize {
        match self {
            Self::Rgb565 => 16,
            Self::Rgba8888 | Self::Argb8888 => 32,
            Self::Bgr888 => 24,
            Self::Gray8 => 8,
            Self::Gray4 => 4,
            Self::Mono1 => 1,
        }
    }

    pub fn row_bytes(self, width: u32) -> Option<usize> {
        (width as usize)
            .checked_mul(self.bits_per_pixel())?
            .checked_add(7)
            .map(|bits| bits / 8)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[non_exhaustive]
#[repr(u32)]
pub enum DisplayRole {
    Primary = abi::POCKET_DISPLAY_ROLE_PRIMARY,
    Auxiliary = abi::POCKET_DISPLAY_ROLE_AUXILIARY,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[non_exhaustive]
#[repr(u32)]
pub enum TargetOwnership {
    CpuVisible = abi::POCKET_TARGET_CPU_VISIBLE,
    DeviceOwned = abi::POCKET_TARGET_DEVICE_OWNED,
}

/// A half-open rectangle in physical display pixels.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Rect {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

impl Rect {
    pub const fn new(x: u32, y: u32, width: u32, height: u32) -> Self {
        Self {
            x,
            y,
            width,
            height,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum DisplayError {
    Unsupported,
    InvalidTarget,
    Failed,
}

/// Where the display's frame pacing signal originates.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[non_exhaustive]
#[repr(u32)]
pub enum VsyncSource {
    None = abi::POCKET_VSYNC_NONE,
    Display = abi::POCKET_VSYNC_DEVICE,
    Timer = abi::POCKET_VSYNC_CLOCK,
}

/// Display facts used by presentation policy. Construction starts with a
/// whole-frame, single-buffer display; drivers fill the supported properties.
#[derive(Clone, Copy, Debug)]
#[non_exhaustive]
pub struct DisplayDescriptor {
    pub role: DisplayRole,
    pub width: u32,
    pub height: u32,
    pub format: PixelFormat,
    pub stride_bytes: usize,
    pub target_ownership: TargetOwnership,
    pub double_buffered: bool,
    /// Two CPU staging buffers permit acquiring the next strip while the
    /// previous transfer is pending. Only valid with device frame storage.
    pub pipelined_acquire: bool,
    pub partial_refresh: bool,
    pub refresh_granularity: [u32; 2],
    pub window_alignment: [u32; 2],
    pub device_frame_storage: bool,
    pub device_rotation: bool,
    pub device_scaling: bool,
    pub vsync: VsyncSource,
}

impl DisplayDescriptor {
    pub fn new(
        role: DisplayRole,
        width: u32,
        height: u32,
        format: PixelFormat,
        stride_bytes: usize,
        target_ownership: TargetOwnership,
    ) -> Self {
        Self {
            role,
            width,
            height,
            format,
            stride_bytes,
            target_ownership,
            double_buffered: false,
            pipelined_acquire: false,
            partial_refresh: false,
            refresh_granularity: [1, 1],
            window_alignment: [1, 1],
            device_frame_storage: false,
            device_rotation: false,
            device_scaling: false,
            vsync: VsyncSource::None,
        }
    }
}

/// Exclusive CPU access to one acquired region. Row zero begins at the
/// region's origin; a strip does not grant access to the rest of a display.
/// Bytes between rows are padding; renderers must honor region and stride.
///
/// ```compile_fail
/// use pocket_drivers::{Surface, Rect, PixelFormat};
/// let mut bytes = [0u8; 2];
/// let surface = Surface::new(&mut bytes, Rect::new(0, 0, 1, 1), 2,
///     PixelFormat::Rgb565).unwrap();
/// bytes[0] = 1; // The surface still holds the exclusive borrow.
/// assert_eq!(surface.pixels()[0], 0);
/// ```
pub struct Surface<'a> {
    pixels: &'a mut [u8],
    region: Rect,
    stride_bytes: usize,
    format: PixelFormat,
}

impl<'a> Surface<'a> {
    pub fn new(
        pixels: &'a mut [u8],
        region: Rect,
        stride_bytes: usize,
        format: PixelFormat,
    ) -> Result<Self, DisplayError> {
        let row_bytes = format
            .row_bytes(region.width)
            .ok_or(DisplayError::InvalidTarget)?;
        if region.width == 0 || region.height == 0 || stride_bytes < row_bytes {
            return Err(DisplayError::InvalidTarget);
        }
        let needed = stride_bytes
            .checked_mul(region.height as usize - 1)
            .and_then(|prefix| prefix.checked_add(row_bytes))
            .ok_or(DisplayError::InvalidTarget)?;
        if pixels.len() < needed {
            return Err(DisplayError::InvalidTarget);
        }
        Ok(Self {
            pixels: &mut pixels[..needed],
            region,
            stride_bytes,
            format,
        })
    }

    pub fn pixels(&self) -> &[u8] {
        self.pixels
    }
    pub fn pixels_mut(&mut self) -> &mut [u8] {
        self.pixels
    }
    pub fn region(&self) -> Rect {
        self.region
    }
    pub fn stride_bytes(&self) -> usize {
        self.stride_bytes
    }
    pub fn format(&self) -> PixelFormat {
        self.format
    }
}

/// A driver-owned target identity, never a CPU pointer. The renderer and
/// display agree on the handle at registration; safe code cannot dereference it.
/// Handles are untrusted: drivers must reject unknown, stale, or foreign
/// handles before using their backing resources.
#[derive(Debug)]
#[non_exhaustive]
pub struct DeviceTarget {
    pub handle: u64,
    pub region: Rect,
    pub format: PixelFormat,
}

impl DeviceTarget {
    pub const fn new(handle: u64, region: Rect, format: PixelFormat) -> Self {
        Self {
            handle,
            region,
            format,
        }
    }
}

#[non_exhaustive]
pub enum Target<'a> {
    CpuVisible(Surface<'a>),
    DeviceOwned(DeviceTarget),
}

impl Target<'_> {
    pub fn ownership(&self) -> TargetOwnership {
        match self {
            Self::CpuVisible(_) => TargetOwnership::CpuVisible,
            Self::DeviceOwned(_) => TargetOwnership::DeviceOwned,
        }
    }
    pub fn format(&self) -> PixelFormat {
        match self {
            Self::CpuVisible(s) => s.format(),
            Self::DeviceOwned(t) => t.format,
        }
    }
    pub fn region(&self) -> Rect {
        match self {
            Self::CpuVisible(s) => s.region(),
            Self::DeviceOwned(t) => t.region,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BufferIdentity {
    pub buffer: u64,
    pub generation: u64,
}

/// A display owns its buffers and pending transfers. After `flush`, it must
/// prevent `acquire` from reusing a buffer until the corresponding `wait` ends.
/// Destruction must stop device access before releasing backing memory.
///
/// All methods are safe. Callers may drop tokens, submit unknown/repeated
/// tokens, or call methods out of order. Implementations must validate their
/// state and reject misuse or stop outstanding work; memory safety cannot
/// depend on callers following the intended presentation sequence.
pub trait DisplayOutput {
    type Token;

    fn descriptor(&self) -> DisplayDescriptor;
    /// Identity of the retained pixels being updated in this frame. A display
    /// buffer uses its own identity; GRAM uses the panel's identity. The value
    /// stays fixed through every acquire/flush/wait in this frame. Increment
    /// generation after reset, external pixel writes or changed output rules.
    /// None requires complete redraws. This call never publishes a frame.
    fn frame_identity(&mut self) -> Result<Option<BufferIdentity>, DisplayError> {
        Ok(None)
    }
    fn acquire(&mut self, region: Rect) -> Result<Target<'_>, DisplayError>;
    /// Called after the renderer's wait. An error means all work started by
    /// this call was drained or cancelled; the device no longer reads it.
    fn flush(&mut self, regions: &[Rect]) -> Result<Self::Token, DisplayError>;
    /// Consumes the transfer token. Both success and failure are terminal:
    /// the device has stopped reading the target. There is no pending/timeout
    /// result; a hung device must be reset before an error can be returned.
    fn wait(&mut self, token: Self::Token) -> Result<(), DisplayError>;
    fn vsync(&mut self) -> VsyncSource;
}
