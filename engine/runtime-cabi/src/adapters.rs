//! C driver adapters. Constructors are unsafe because callbacks and storage
//! must remain valid and obey the driver ABI through adapter destruction.
use core::{ffi::c_void, mem, slice};
use pocket_drivers::{abi::*, *};
mod display;
mod input;
mod package;
mod renderer;
mod resources;
pub use display::CDisplay;
pub use input::CInputSource;
pub use package::CPackageSource;
pub use renderer::CRenderer;
pub use resources::{CResources, ResourceBridge};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AdapterError {
    Invalid,
    Unsupported,
    Failed,
}
impl AdapterError {
    pub fn status(self) -> i32 {
        match self {
            Self::Invalid => POCKET_STATUS_INVALID,
            Self::Unsupported => POCKET_STATUS_UNSUPPORTED,
            Self::Failed => POCKET_STATUS_FAILED,
        }
    }
}
fn check(status: i32) -> Result<(), AdapterError> {
    match status {
        0 => Ok(()),
        POCKET_STATUS_INVALID => Err(AdapterError::Invalid),
        POCKET_STATUS_UNSUPPORTED => Err(AdapterError::Unsupported),
        _ => Err(AdapterError::Failed),
    }
}
pub(crate) fn pixel_format(value: u32) -> Result<PixelFormat, AdapterError> {
    match value {
        POCKET_PIXEL_FORMAT_RGB565 => Ok(PixelFormat::Rgb565),
        POCKET_PIXEL_FORMAT_RGBA8888 => Ok(PixelFormat::Rgba8888),
        POCKET_PIXEL_FORMAT_ARGB8888 => Ok(PixelFormat::Argb8888),
        POCKET_PIXEL_FORMAT_BGR888 => Ok(PixelFormat::Bgr888),
        POCKET_PIXEL_FORMAT_GRAY8 => Ok(PixelFormat::Gray8),
        POCKET_PIXEL_FORMAT_GRAY4 => Ok(PixelFormat::Gray4),
        POCKET_PIXEL_FORMAT_MONO1 => Ok(PixelFormat::Mono1),
        _ => Err(AdapterError::Unsupported),
    }
}
fn ownership(value: u32) -> Result<TargetOwnership, AdapterError> {
    match value {
        POCKET_TARGET_CPU_VISIBLE => Ok(TargetOwnership::CpuVisible),
        POCKET_TARGET_DEVICE_OWNED => Ok(TargetOwnership::DeviceOwned),
        _ => Err(AdapterError::Invalid),
    }
}
fn vsync(value: u32) -> Result<VsyncSource, AdapterError> {
    match value {
        POCKET_VSYNC_NONE => Ok(VsyncSource::None),
        POCKET_VSYNC_DEVICE => Ok(VsyncSource::Display),
        POCKET_VSYNC_CLOCK => Ok(VsyncSource::Timer),
        _ => Err(AdapterError::Invalid),
    }
}
pub(crate) unsafe fn borrowed<'a, T>(
    pointer: *const T,
    count: usize,
) -> Result<&'a [T], AdapterError> {
    if count == 0 {
        return Ok(&[]);
    }
    if pointer.is_null()
        || !(pointer as usize).is_multiple_of(mem::align_of::<T>())
        || count.checked_mul(mem::size_of::<T>()).is_none_or(|bytes| {
            bytes > isize::MAX as usize || (pointer as usize).checked_add(bytes).is_none()
        })
    {
        return Err(AdapterError::Invalid);
    }
    Ok(unsafe { slice::from_raw_parts(pointer, count) })
}
pub(crate) unsafe fn writable<'a>(
    pointer: *mut u8,
    count: usize,
) -> Result<&'a mut [u8], AdapterError> {
    if count == 0 {
        return Ok(&mut []);
    }
    if pointer.is_null()
        || count > isize::MAX as usize
        || (pointer as usize).checked_add(count).is_none()
    {
        return Err(AdapterError::Invalid);
    }
    Ok(unsafe { slice::from_raw_parts_mut(pointer, count) })
}
unsafe fn record_array<T>(
    pointer: *const T,
    count: usize,
    mut read: impl FnMut(*const T) -> Result<(), AdapterError>,
) -> Result<(), AdapterError> {
    if count == 0 {
        return Ok(());
    }
    if pointer.is_null() || count > isize::MAX as usize / mem::size_of::<usize>() {
        return Err(AdapterError::Invalid);
    }
    let mut offset = 0usize;
    for _ in 0..count {
        let address = (pointer as usize)
            .checked_add(offset)
            .ok_or(AdapterError::Invalid)?;
        if !address.is_multiple_of(mem::align_of::<T>()) {
            return Err(AdapterError::Invalid);
        }
        address
            .checked_add(mem::size_of::<usize>())
            .ok_or(AdapterError::Invalid)?;
        let item = unsafe { pointer.cast::<u8>().add(offset).cast::<T>() };
        let size = unsafe { item.cast::<usize>().read_unaligned() };
        if size < mem::size_of::<usize>() || !size.is_multiple_of(mem::align_of::<T>()) {
            return Err(AdapterError::Invalid);
        }
        offset = offset
            .checked_add(size)
            .filter(|value| *value <= isize::MAX as usize)
            .ok_or(AdapterError::Invalid)?;
        (pointer as usize)
            .checked_add(offset)
            .ok_or(AdapterError::Invalid)?;
        read(item)?;
    }
    Ok(())
}
pub(crate) unsafe fn rect(pointer: *const PocketRect) -> Result<Rect, AdapterError> {
    let r = unsafe { PocketRect::read_prefix(pointer) }.ok_or(AdapterError::Invalid)?;
    if r.width == 0
        || r.height == 0
        || r.x.checked_add(r.width).is_none()
        || r.y.checked_add(r.height).is_none()
    {
        return Err(AdapterError::Invalid);
    }
    Ok(Rect::new(r.x, r.y, r.width, r.height))
}
fn c_rect(r: Rect) -> PocketRect {
    PocketRect {
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
        ..PocketRect::empty()
    }
}
pub(crate) fn render_error(error: AdapterError) -> RenderError {
    match error {
        AdapterError::Invalid => RenderError::InvalidFrame,
        AdapterError::Unsupported => RenderError::Unsupported,
        AdapterError::Failed => RenderError::Failed,
    }
}
fn display_error(error: AdapterError) -> DisplayError {
    match error {
        AdapterError::Invalid => DisplayError::InvalidTarget,
        AdapterError::Unsupported => DisplayError::Unsupported,
        AdapterError::Failed => DisplayError::Failed,
    }
}
