use super::*;

pub struct CPackageSource {
    table: PocketPackageSourceV1,
    context: *mut c_void,
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
        Ok(Self { table, context })
    }
}
fn source_error(error: AdapterError) -> SourceError {
    match error {
        AdapterError::Unsupported => SourceError::Unsupported,
        AdapterError::Invalid => SourceError::OutOfBounds,
        AdapterError::Failed => SourceError::Failed,
    }
}
impl PackageSource for CPackageSource {
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
}
