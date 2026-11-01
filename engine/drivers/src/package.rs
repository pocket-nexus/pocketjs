//! Byte sources; package parsing, hashes and admission belong to pocket-package.

use alloc::boxed::Box;

/// Storage another owner keeps alive for the package's lifetime and releases
/// when the box drops: memory a C program transfers through its source's
/// take callback.
pub trait PackageStorage {
    fn bytes(&self) -> &[u8];
}

/// Storage whose lifetime does not depend on a source borrow. Static bytes
/// remain immutable; owned bytes move to the consumer; foreign bytes stay
/// unchanged until their owner is told to release them. No variant permits
/// a source to retain a mutable alias to the transferred bytes.
pub enum PackageBytes {
    Owned(Box<[u8]>),
    Static(&'static [u8]),
    Foreign(Box<dyn PackageStorage>),
}
impl AsRef<[u8]> for PackageBytes {
    fn as_ref(&self) -> &[u8] {
        match self {
            Self::Owned(bytes) => bytes,
            Self::Static(bytes) => bytes,
            Self::Foreign(storage) => storage.bytes(),
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
    /// This is not a longer lifetime for `all`: the bytes move, outlive the
    /// source, or are foreign storage released through the consumer.
    fn take_bytes(&mut self) -> Result<PackageBytes, SourceError> {
        Err(SourceError::Unsupported)
    }
    /// True when the owner of the storage `take_bytes` transfers has verified
    /// the package's FNV-1a64 footer and variant hashes of those exact bytes;
    /// admission then skips its own hash pass. Copied bytes are always
    /// hashed.
    fn verified(&self) -> bool {
        false
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
