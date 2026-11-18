//! Byte sources; package parsing, hashes and admission belong to pocket-package.

use alloc::boxed::Box;
use core::ops::Range;

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

/// Byte ranges of one program in the bytes a source returns, stated by a
/// host that keeps programs in a container of its own. Ranges count from the
/// first byte of `all`, `range` and `take_bytes`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PackageSections {
    /// The binding generation the program was compiled for.
    pub host_abi: u32,
    /// The build plan JSON admission reads.
    pub plan: Range<usize>,
    /// The NUL-terminated UI bundle; `None` when `bytecode` carries it.
    pub js: Option<Range<usize>>,
    pub pak: Option<Range<usize>>,
    /// The UI bundle as a bytecode envelope.
    pub bytecode: Option<Range<usize>>,
    /// The NUL-terminated worker bundle of a plan with `domains.worker`.
    pub worker_js: Option<Range<usize>>,
    /// The worker bundle as a bytecode envelope.
    pub worker_bytecode: Option<Range<usize>>,
}

pub trait PackageSource {
    fn length(&self) -> Result<usize, SourceError>;
    /// Where one program lies in this source's bytes. `None`, the default,
    /// states that the bytes are a bundle, which the consumer
    /// parses and whose hashes it checks. With sections the consumer reads
    /// the program at these ranges, admits its plan and checks no container
    /// hash. Called once per load or inspection, before the bytes are read
    /// or taken.
    fn sections(&mut self) -> Result<Option<PackageSections>, SourceError> {
        Ok(None)
    }
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
    /// the bundle's FNV-1a64 footer and payload hashes of those exact bytes;
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
