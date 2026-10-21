//! Byte sources; package parsing, hashes and admission belong to pocket-package.

use alloc::boxed::Box;

/// Storage whose lifetime does not depend on a source borrow. Static bytes
/// remain immutable; owned bytes move to the consumer. Neither variant permits
/// a source to retain a mutable alias to the transferred bytes.
pub enum PackageBytes {
    Owned(Box<[u8]>),
    Static(&'static [u8]),
}
impl AsRef<[u8]> for PackageBytes {
    fn as_ref(&self) -> &[u8] {
        match self {
            Self::Owned(bytes) => bytes,
            Self::Static(bytes) => bytes,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum SourceError {
    Unsupported,
    OutOfBounds,
    Failed,
}

pub trait PackageSource {
    fn length(&self) -> Result<usize, SourceError>;
    /// Transfer storage to the consumer without copying. The returned bytes
    /// must have the length reported before this call. On success an owned
    /// source may be consumed and reject subsequent reads. Unsupported leaves
    /// the source available for `all` or `range`.
    ///
    /// This is an optional Rust ownership path, not a longer lifetime for
    /// `all`. C tables and other borrowed sources retain the copying path.
    fn take_bytes(&mut self) -> Result<PackageBytes, SourceError> {
        Err(SourceError::Unsupported)
    }
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
