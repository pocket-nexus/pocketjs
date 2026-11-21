//! Standard-library timing and allocation helpers. This crate exports no global
//! `pocket_host_*` symbols; the final program chooses one ABI hook owner.
use pocket_drivers::Clock;
use std::alloc::{alloc, dealloc, realloc, Layout};
use std::time::{Duration, Instant};

pub struct MonotonicClock(Instant);
impl Default for MonotonicClock {
    fn default() -> Self {
        Self(Instant::now())
    }
}
impl Clock for MonotonicClock {
    fn now(&self) -> u64 {
        self.0.elapsed().as_micros().min(u64::MAX as u128) as u64
    }
    fn sleep_until(&mut self, deadline: u64) {
        loop {
            let now = self.now();
            if now >= deadline {
                break;
            }
            std::thread::sleep(Duration::from_micros(deadline - now));
        }
    }
}
/// Allocate a byte span using the same size/alignment contract as the C ABI.
pub fn allocate(size: usize, align: usize) -> *mut u8 {
    Layout::from_size_align(size.max(1), align)
        .map_or(std::ptr::null_mut(), |layout| unsafe { alloc(layout) })
}
/// # Safety
/// `pointer` must be a live allocation returned by `allocate` with this layout.
pub unsafe fn release(pointer: *mut u8, size: usize, align: usize) {
    if pointer.is_null() {
        return;
    }
    if let Ok(layout) = Layout::from_size_align(size.max(1), align) {
        unsafe { dealloc(pointer, layout) };
    }
}
/// # Safety
/// A non-null pointer must be a live allocation returned with the old layout.
pub unsafe fn resize(pointer: *mut u8, old_size: usize, align: usize, new_size: usize) -> *mut u8 {
    if pointer.is_null() {
        return allocate(new_size, align);
    }
    Layout::from_size_align(old_size.max(1), align).map_or(std::ptr::null_mut(), |layout| unsafe {
        realloc(pointer, layout, new_size.max(1))
    })
}
/// Range reads from an open file. Package decoding and identity validation stay
/// in pocket-package; the source never strips or rewrites package sections.
pub struct FileSource {
    file: std::fs::File,
    length: usize,
}
impl FileSource {
    pub fn open(path: impl AsRef<std::path::Path>) -> std::io::Result<Self> {
        let file = std::fs::File::open(path)?;
        let length = usize::try_from(file.metadata()?.len())
            .map_err(|_| std::io::Error::other("package is too large"))?;
        Ok(Self { file, length })
    }
}
impl pocket_drivers::PackageSource for FileSource {
    fn length(&self) -> Result<usize, pocket_drivers::SourceError> {
        Ok(self.length)
    }
    fn range(
        &mut self,
        offset: usize,
        buffer: &mut [u8],
    ) -> Result<usize, pocket_drivers::SourceError> {
        use pocket_drivers::SourceError;
        use std::io::{Read, Seek, SeekFrom};
        if offset > self.length {
            return Err(SourceError::OutOfBounds);
        }
        if self.file.metadata().map_err(|_| SourceError::Failed)?.len() != self.length as u64 {
            return Err(SourceError::Failed);
        }
        self.file
            .seek(SeekFrom::Start(offset as u64))
            .map_err(|_| SourceError::Failed)?;
        let limit = buffer.len().min(self.length - offset);
        self.file
            .read(&mut buffer[..limit])
            .map_err(|_| SourceError::Failed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn aligned_reallocation_preserves_bytes() {
        unsafe {
            let pointer = allocate(17, 64);
            assert!(!pointer.is_null());
            assert_eq!(pointer as usize % 64, 0);
            pointer.write(42);
            let larger = resize(pointer, 17, 64, 100);
            assert!(!larger.is_null());
            assert_eq!(larger.read(), 42);
            release(larger, 100, 64);
        }
    }
    #[test]
    fn invalid_layout_is_rejected() {
        assert!(allocate(1, 3).is_null());
    }
    #[test]
    fn clock_does_not_tick_or_move_backwards() {
        let mut clock = MonotonicClock::default();
        let before = clock.now();
        clock.sleep_until(before + 100);
        assert!(clock.now() >= before + 100);
    }
}
