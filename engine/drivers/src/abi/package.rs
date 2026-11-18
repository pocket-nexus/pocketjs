use super::*;
use crate::{PackageBytes, PackageSections, PackageSource, PackageStorage, SourceError};
use alloc::boxed::Box;
use core::{ffi::c_void, slice};

pub struct CPackageSource {
    table: PocketPackageSourceV1,
    context: *mut c_void,
    verified: bool,
}
impl CPackageSource {
    /// # Safety
    /// The table's announced prefix and context obey the C package contract.
    pub unsafe fn new(
        table: *const PocketPackageSourceV1,
        context: *mut c_void,
    ) -> Result<Self, AdapterError> {
        let table =
            unsafe { PocketPackageSourceV1::read_prefix(table) }.ok_or(AdapterError::Invalid)?;
        if table.length.is_none() || table.range.is_none() {
            return Err(AdapterError::Unsupported);
        }
        Ok(Self {
            table,
            context,
            verified: false,
        })
    }
}
/// Storage a C source transferred: read in place and released through its
/// callback when the package drops.
struct ForeignStorage {
    bytes: *const u8,
    length: usize,
    release: Option<PocketPackageReleaseFn>,
    context: *mut c_void,
}
impl PackageStorage for ForeignStorage {
    fn bytes(&self) -> &[u8] {
        if self.length == 0 {
            return &[];
        }
        unsafe { slice::from_raw_parts(self.bytes, self.length) }
    }
}
impl Drop for ForeignStorage {
    fn drop(&mut self) {
        if let Some(release) = self.release {
            unsafe { release(self.context, self.bytes, self.length) }
        }
    }
}
fn source_error(error: AdapterError) -> SourceError {
    match error {
        AdapterError::Unsupported => SourceError::Unsupported,
        AdapterError::Invalid => SourceError::OutOfBounds,
        AdapterError::Failed => SourceError::Failed,
    }
}
/// A C section: zero length means absent.
fn section(offset: usize, length: usize) -> Result<Option<core::ops::Range<usize>>, SourceError> {
    if length == 0 {
        return Ok(None);
    }
    let end = offset.checked_add(length).ok_or(SourceError::OutOfBounds)?;
    Ok(Some(offset..end))
}
impl PackageSource for CPackageSource {
    fn sections(&mut self) -> Result<Option<PackageSections>, SourceError> {
        let Some(callback) = self.table.sections else {
            return Ok(None);
        };
        let mut out = PocketPackageSections::empty();
        match check(unsafe { callback(self.context, &mut out) }) {
            Ok(()) => {}
            Err(AdapterError::Unsupported) => return Ok(None),
            Err(error) => return Err(source_error(error)),
        }
        Ok(Some(PackageSections {
            host_abi: out.host_abi,
            plan: section(out.plan_offset, out.plan_length)?.ok_or(SourceError::OutOfBounds)?,
            js: section(out.js_offset, out.js_length)?,
            pak: section(out.pak_offset, out.pak_length)?,
            bytecode: section(out.bytecode_offset, out.bytecode_length)?,
            worker_js: section(out.worker_js_offset, out.worker_js_length)?,
            worker_bytecode: section(out.worker_bytecode_offset, out.worker_bytecode_length)?,
        }))
    }
    fn length(&self) -> Result<usize, SourceError> {
        let mut size = 0;
        check(unsafe { self.table.length.unwrap()(self.context, &mut size) })
            .map_err(source_error)?;
        if size > isize::MAX as usize {
            return Err(SourceError::OutOfBounds);
        }
        Ok(size)
    }
    fn all(&mut self) -> Result<&[u8], SourceError> {
        let callback = self.table.all.ok_or(SourceError::Unsupported)?;
        let mut pointer = core::ptr::null();
        let mut size = 0;
        check(unsafe { callback(self.context, &mut pointer, &mut size) }).map_err(source_error)?;
        unsafe { borrowed(pointer, size) }.map_err(source_error)
    }
    fn range(&mut self, offset: usize, buffer: &mut [u8]) -> Result<usize, SourceError> {
        let length = self.length()?;
        if offset > length {
            return Err(SourceError::OutOfBounds);
        }
        let capacity = buffer.len().min(length - offset);
        let mut read = 0;
        check(unsafe {
            self.table.range.unwrap()(
                self.context,
                offset,
                buffer.as_mut_ptr(),
                capacity,
                &mut read,
            )
        })
        .map_err(source_error)?;
        if read > capacity {
            return Err(SourceError::Failed);
        }
        Ok(read)
    }
    fn take_bytes(&mut self) -> Result<PackageBytes, SourceError> {
        let take = self.table.take.ok_or(SourceError::Unsupported)?;
        let mut storage = PocketPackageStorage::empty();
        check(unsafe { take(self.context, &mut storage) }).map_err(source_error)?;
        // The source handed the storage over: dropping it on a bad pointer
        // still runs its release.
        let foreign = ForeignStorage {
            bytes: storage.bytes,
            length: storage.length,
            release: storage.release,
            context: storage.release_context,
        };
        unsafe { borrowed::<u8>(storage.bytes, storage.length) }.map_err(source_error)?;
        self.verified = (storage.flags & POCKET_PACKAGE_STORAGE_VERIFIED) != 0;
        Ok(PackageBytes::Foreign(Box::new(foreign)))
    }
    fn verified(&self) -> bool {
        self.verified
    }
}
