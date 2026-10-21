//! Range source for app.pocket beside the EBOOT. Runtime owns the sole loaded
//! allocation, hashes, target selection, host ABI and plan admission.
use core::ffi::CStr;
use pocket_drivers::{PackageSource, SourceError};
use psp::sys::{self, IoOpenFlags, IoWhence, SceUid};
pub struct FileSource {
    fd: SceUid,
    length: usize,
}
impl PackageSource for FileSource {
    fn length(&self) -> Result<usize, SourceError> {
        Ok(self.length)
    }
    fn range(&mut self, offset: usize, buffer: &mut [u8]) -> Result<usize, SourceError> {
        if offset > self.length {
            return Err(SourceError::OutOfBounds);
        }
        let count = buffer.len().min(self.length - offset).min(1 << 20);
        if count == 0 {
            return Ok(0);
        }
        unsafe {
            if sys::sceIoLseek(self.fd, offset as i64, IoWhence::Set) != offset as i64 {
                return Err(SourceError::Failed);
            }
            let read = sys::sceIoRead(self.fd, buffer.as_mut_ptr().cast(), count as u32);
            if read < 0 {
                Err(SourceError::Failed)
            } else {
                Ok(read as usize)
            }
        }
    }
}
impl Drop for FileSource {
    fn drop(&mut self) {
        unsafe {
            sys::sceIoClose(self.fd);
        }
    }
}
impl FileSource {
    pub fn open(path: &CStr) -> Result<Self, SourceError> {
        unsafe {
            let fd = sys::sceIoOpen(path.as_ptr().cast(), IoOpenFlags::RD_ONLY, 0);
            if fd.0 < 0 {
                return Err(SourceError::Failed);
            }
            let length = sys::sceIoLseek(fd, 0, IoWhence::End);
            if length <= 0 || length as u64 > usize::MAX as u64 {
                sys::sceIoClose(fd);
                return Err(SourceError::Failed);
            }
            Ok(FileSource {
                fd,
                length: length as usize,
            })
        }
    }
}
