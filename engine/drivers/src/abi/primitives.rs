//! Checks a C caller's memory must pass before the ABI borrows it.
use super::{
    PocketRect, POCKET_PIXEL_FORMAT_ARGB8888, POCKET_PIXEL_FORMAT_BGR888,
    POCKET_PIXEL_FORMAT_GRAY4, POCKET_PIXEL_FORMAT_GRAY8, POCKET_PIXEL_FORMAT_MONO1,
    POCKET_PIXEL_FORMAT_RGB565, POCKET_PIXEL_FORMAT_RGBA8888, POCKET_STATUS_FAILED,
    POCKET_STATUS_INVALID, POCKET_STATUS_UNSUPPORTED, POCKET_TARGET_CPU_VISIBLE,
    POCKET_TARGET_DEVICE_OWNED, POCKET_VSYNC_CLOCK, POCKET_VSYNC_DEVICE, POCKET_VSYNC_NONE,
};
use crate::{DisplayError, PixelFormat, Rect, RenderError, TargetOwnership, VsyncSource};
use core::{mem, slice};

/// A C status that is not `POCKET_STATUS_OK`, and the reason a record or
/// pointer failed the checks below.
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
pub(super) fn check(status: i32) -> Result<(), AdapterError> {
    match status {
        0 => Ok(()),
        POCKET_STATUS_INVALID => Err(AdapterError::Invalid),
        POCKET_STATUS_UNSUPPORTED => Err(AdapterError::Unsupported),
        _ => Err(AdapterError::Failed),
    }
}
/// Convert a canonical pixel-format tag, rejecting unknown formats.
pub fn pixel_format(value: u32) -> Result<PixelFormat, AdapterError> {
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
pub(super) fn ownership(value: u32) -> Result<TargetOwnership, AdapterError> {
    match value {
        POCKET_TARGET_CPU_VISIBLE => Ok(TargetOwnership::CpuVisible),
        POCKET_TARGET_DEVICE_OWNED => Ok(TargetOwnership::DeviceOwned),
        _ => Err(AdapterError::Invalid),
    }
}
pub(super) fn vsync(value: u32) -> Result<VsyncSource, AdapterError> {
    match value {
        POCKET_VSYNC_NONE => Ok(VsyncSource::None),
        POCKET_VSYNC_DEVICE => Ok(VsyncSource::Display),
        POCKET_VSYNC_CLOCK => Ok(VsyncSource::Timer),
        _ => Err(AdapterError::Invalid),
    }
}
/// Validate a foreign slice shape before borrowing its allocation.
/// # Safety
/// For nonzero count, pointer must name initialized T values in one live allocation
/// for the returned lifetime; no writer may access those values during the borrow.
pub unsafe fn borrowed<'a, T>(pointer: *const T, count: usize) -> Result<&'a [T], AdapterError> {
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
/// Validate a foreign writable byte span.
/// # Safety
/// For nonzero count, pointer must name one initialized allocation exclusively
/// borrowed for the returned lifetime, with no hardware or other concurrent access.
pub unsafe fn writable<'a>(pointer: *mut u8, count: usize) -> Result<&'a mut [u8], AdapterError> {
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
/// Walk a packed record array: each element announces its own size, so the
/// consumer's `size_of` is not the stride.
pub(super) unsafe fn record_array<T>(
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
/// Read a nonempty canonical rectangle with checked endpoint arithmetic.
/// # Safety
/// A nonnull pointer must provide a readable size prefix and initialized bytes
/// through the smaller of that prefix and the known PocketRect size.
pub unsafe fn rect(pointer: *const PocketRect) -> Result<Rect, AdapterError> {
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
pub(super) fn c_rect(r: Rect) -> PocketRect {
    PocketRect {
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
        ..PocketRect::empty()
    }
}
pub(super) fn render_error(error: AdapterError) -> RenderError {
    match error {
        AdapterError::Invalid => RenderError::InvalidFrame,
        AdapterError::Unsupported => RenderError::Unsupported,
        AdapterError::Failed => RenderError::Failed,
    }
}
pub(super) fn display_error(error: AdapterError) -> DisplayError {
    match error {
        AdapterError::Invalid => DisplayError::InvalidTarget,
        AdapterError::Unsupported => DisplayError::Unsupported,
        AdapterError::Failed => DisplayError::Failed,
    }
}
