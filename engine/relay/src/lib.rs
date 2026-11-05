//! pocket-relay — the Relay L1 frame layer for Rust hosts (docs/RELAY.md).
//!
//! One record is a 4-byte little-endian length prefix, a 48-byte fixed header,
//! a strict UTF-8 JSON metadata object and raw data bytes. This crate owns the
//! header: it decodes and validates the 48 bytes, hands metadata and data back
//! as borrowed slices, and encodes a record into a caller-owned buffer. The
//! layout and every limit come from `contracts/spec/relay.ts` through
//! `gen-rust.ts`, re-exported here as [`spec`].
//!
//! **There is no JSON in this crate.** [`Frame::meta`] is unparsed bytes that
//! [`decode`] has checked to be valid UTF-8: a region that is not is
//! [`FrameError::BadMetadata`], and [`encode_into`] refuses one the same way.
//! The JSON half of that rule and every [`FrameError::BadEnvelope`] rule are
//! decided by the session layer that reads metadata; this crate never returns
//! `BadEnvelope`.
//! `framework/src/relay/frame.ts` is the TypeScript peer, and
//! `tests/fixtures/relay/vectors/` is the byte-level acceptance set both pass.
//!
//! The core is `#![no_std]` and never allocates: [`decode`] borrows the
//! caller's record, [`encode_into`] writes the caller's buffer, and
//! [`RecordReader`] reassembles split TCP input inside a caller-owned buffer.
//! `--no-default-features` is what `hosts/psp` builds; the default `std`
//! feature adds only the [`std::error::Error`] impl on [`FrameError`].

#![no_std]
#![forbid(unsafe_code)]
#![deny(missing_docs)]

#[cfg(feature = "std")]
extern crate std;

mod counters;
mod frame;
// Generated verbatim from the same emitter that writes engine/spec/src/lib.rs,
// which carries no per-constant doc comments.
#[allow(missing_docs)]
mod generated;
mod limits;

/// Relay constants generated from `contracts/spec/relay.ts`. Byte-guarded by
/// `tests/contract.ts`; regenerate with `bun run gen`.
pub use generated::relay as spec;

pub use counters::{CounterError, Credit, Seq};
pub use frame::{
    CodecSet, EncodeError, Frame, FrameError, FrameInput, FrameOptions, HEADER_BODY_BYTES,
    HEADER_BYTES, Header, LENGTH_PREFIX_BYTES, RecordReader, decode, encode_into, encoded_len,
};
pub use limits::RxLimits;
