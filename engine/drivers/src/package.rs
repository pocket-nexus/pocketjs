//! Byte sources; package parsing, hashes and admission belong to pocket-package.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum SourceError {
    Unsupported,
    OutOfBounds,
    Failed,
}

pub trait PackageSource {
    fn length(&self) -> Result<usize, SourceError>;
    /// Borrow bytes until the next mutable call on this source. A range-only
    /// source returns Unsupported; callers must then use `range`.
    fn all(&mut self) -> Result<&[u8], SourceError> {
        Err(SourceError::Unsupported)
    }
    /// Read up to buffer.len() bytes. Short reads are allowed; zero means EOF.
    /// An offset past length returns OutOfBounds. Bytes beyond the returned
    /// count are not part of the result.
    fn range(&mut self, offset: usize, buffer: &mut [u8]) -> Result<usize, SourceError>;
}
