//! The 48-byte fixed header: decode, validate, encode, reassemble.
//!
//! Every integer on the wire is little-endian. Offsets and widths are read
//! from [`crate::spec::header`], so moving a field in `contracts/spec/relay.ts`
//! moves it here without a hand edit.

use crate::spec::{self, header as h};

/// Bytes of the length prefix that precedes every record. R5 draft §3.3.
pub const LENGTH_PREFIX_BYTES: usize = spec::frame::LENGTH_PREFIX_BYTES as usize;
/// Bytes of the fixed header, counting the length prefix.
pub const HEADER_BYTES: usize = spec::frame::HEADER_BYTES as usize;
/// Header bytes the `frameBytes` field counts: [`HEADER_BYTES`] minus the prefix.
pub const HEADER_BODY_BYTES: usize = spec::frame::HEADER_BODY_BYTES as usize;

/// A fixed frame-layer failure code. The `&str` spellings in
/// [`FrameError::as_str`] are the shared vocabulary the TypeScript, C and Rust
/// layers all report, so a vector's expected code compares as text.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum FrameError {
    /// Fewer than 48 bytes: the header itself is incomplete.
    ShortHeader,
    /// `frameBytes` is below the 44-byte header body — nothing can follow it.
    BadPrefix,
    /// Bytes 4..8 are not ASCII `PRLY`.
    BadMagic,
    /// `major`/`minor` are not the version this build speaks.
    BadVersion,
    /// `type` is outside REQUEST..INVALIDATE.
    BadType,
    /// A reserved `flags` bit is set.
    BadFlags,
    /// `headerBytes` is not 48.
    BadHeaderSize,
    /// The reserved u32 at offset 44 is nonzero.
    BadReserved,
    /// `frameBytes + 4 != 48 + metaBytes + dataBytes`, or the record length
    /// disagrees with the prefix.
    BadLength,
    /// The record stops before the declared length.
    Truncated,
    /// The record exceeds the receiver's `maxWireBytes` guarantee.
    WireTooLarge,
    /// `metaBytes` exceeds the receiver's `maxMetaBytes` guarantee.
    MetaTooLarge,
    /// `codec` was not negotiated, or codec 0 carries data.
    BadCodec,
    /// `session` is not the session this attachment is pinned to.
    BadSession,
    /// `seq` is zero; sequence numbers start at 1.
    BadSeq,
    /// `correlation` is zero on REQUEST/RESPONSE/CANCEL, nonzero elsewhere, or
    /// a CANCEL is off the control stream (`stream != 0`).
    BadCorrelation,
    /// Metadata is not strict UTF-8 JSON. This crate decides the byte half of
    /// that rule: a metadata region that is not valid UTF-8 is refused by
    /// [`decode`] and [`encode_into`]. The JSON half (root object, duplicate
    /// keys, number grammar, escapes) is decided by the session layer that
    /// parses metadata.
    BadMetadata,
    /// Metadata parses but breaks an envelope rule (`op`, `final`, `status`,
    /// `targetStream`). Never returned by this crate: the envelope is read
    /// from parsed metadata, one layer up.
    BadEnvelope,
}

impl FrameError {
    /// The wire spelling from `contracts/spec/relay.ts`.
    pub const fn as_str(self) -> &'static str {
        use spec::frame_error as e;
        match self {
            Self::ShortHeader => e::SHORT_HEADER,
            Self::BadPrefix => e::BAD_PREFIX,
            Self::BadMagic => e::BAD_MAGIC,
            Self::BadVersion => e::BAD_VERSION,
            Self::BadType => e::BAD_TYPE,
            Self::BadFlags => e::BAD_FLAGS,
            Self::BadHeaderSize => e::BAD_HEADER_SIZE,
            Self::BadReserved => e::BAD_RESERVED,
            Self::BadLength => e::BAD_LENGTH,
            Self::Truncated => e::TRUNCATED,
            Self::WireTooLarge => e::WIRE_TOO_LARGE,
            Self::MetaTooLarge => e::META_TOO_LARGE,
            Self::BadCodec => e::BAD_CODEC,
            Self::BadSession => e::BAD_SESSION,
            Self::BadSeq => e::BAD_SEQ,
            Self::BadCorrelation => e::BAD_CORRELATION,
            Self::BadMetadata => e::BAD_METADATA,
            Self::BadEnvelope => e::BAD_ENVELOPE,
        }
    }
}

impl core::fmt::Display for FrameError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str(self.as_str())
    }
}

#[cfg(feature = "std")]
impl std::error::Error for FrameError {}

/// Encoding failed. A [`FrameError`] is a protocol refusal the peer would also
/// make; [`EncodeError::BufferTooSmall`] is a local buffer that is not big
/// enough, which [`encoded_len`] sizes ahead of the call.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EncodeError {
    /// The frame itself is not encodable.
    Frame(FrameError),
    /// The output buffer holds fewer than `needed` bytes.
    BufferTooSmall {
        /// Bytes the complete record occupies.
        needed: usize,
    },
}

impl From<FrameError> for EncodeError {
    fn from(e: FrameError) -> Self {
        Self::Frame(e)
    }
}

impl core::fmt::Display for EncodeError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::Frame(e) => f.write_str(e.as_str()),
            Self::BufferTooSmall { needed } => write!(f, "BUFFER_TOO_SMALL (needed {needed})"),
        }
    }
}

#[cfg(feature = "std")]
impl std::error::Error for EncodeError {}

// --- negotiated codec set ----------------------------------------------------

/// Codecs this attachment accepts in the `codec` field.
///
/// The R5 HELLO schema puts no `maxItems` on its `codecs` array (draft
/// erratum), so [`CodecSet::CAPACITY`] is this crate's own storage bound: the
/// eight v1-defined codecs plus room for negotiated extension values.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CodecSet {
    values: [u16; Self::CAPACITY],
    len: usize,
}

impl CodecSet {
    /// Codecs one set holds.
    pub const CAPACITY: usize = 32;

    /// The eight codecs v1 defines. This is the set [`FrameOptions::default`]
    /// uses when a caller has not negotiated a narrower one.
    pub const DEFINED: Self = {
        use spec::codec as c;
        let values = [
            c::NONE,
            c::JSON,
            c::R5G6B5LE,
            c::PMH1,
            c::COVERAGE2_LSB,
            c::INDEXED8_ABGR,
            c::FONT3,
            c::OPAQUE_BYTES,
            0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        ];
        Self { values, len: 8 }
    };

    /// An empty set. Every codec, including 0, is refused until added.
    pub const fn new() -> Self {
        Self { values: [0; Self::CAPACITY], len: 0 }
    }

    /// Builds a set from a slice, refusing more than [`CodecSet::CAPACITY`]
    /// distinct values. Duplicates collapse.
    pub fn from_slice(codecs: &[u16]) -> Result<Self, FrameError> {
        let mut set = Self::new();
        let mut i = 0;
        while i < codecs.len() {
            set.insert(codecs[i])?;
            i += 1;
        }
        Ok(set)
    }

    /// Adds one codec. Returns [`FrameError::BadCodec`] when the set is full.
    pub fn insert(&mut self, codec: u16) -> Result<(), FrameError> {
        if self.contains(codec) {
            return Ok(());
        }
        if self.len == Self::CAPACITY {
            return Err(FrameError::BadCodec);
        }
        self.values[self.len] = codec;
        self.len += 1;
        Ok(())
    }

    /// Whether `codec` is in the set.
    pub const fn contains(&self, codec: u16) -> bool {
        let mut i = 0;
        while i < self.len {
            if self.values[i] == codec {
                return true;
            }
            i += 1;
        }
        false
    }

    /// Codecs in the set.
    pub const fn len(&self) -> usize {
        self.len
    }

    /// Whether the set refuses every codec.
    pub const fn is_empty(&self) -> bool {
        self.len == 0
    }
}

impl Default for CodecSet {
    fn default() -> Self {
        Self::DEFINED
    }
}

// --- options -----------------------------------------------------------------

/// What this attachment accepts. The defaults are the v1 codec set and the
/// decoder ceilings from `RELAY_LIMITS`; `session: None` leaves the session
/// unpinned, which is the bootstrap HELLO exchange.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FrameOptions {
    /// Receiver wire guarantee for this attachment. R5-P09.
    pub max_wire_bytes: Option<u32>,
    /// Receiver metadata guarantee for this attachment. R5-P09.
    pub max_meta_bytes: Option<u32>,
    /// Negotiated codecs. R5-P04.
    pub codecs: CodecSet,
    /// When set, every frame must carry this session. Bootstrap session 0
    /// never matches a pinned nonzero session.
    pub session: Option<u64>,
}

impl Default for FrameOptions {
    fn default() -> Self {
        Self {
            max_wire_bytes: Some(spec::limits::DEFAULT_MAX_WIRE_BYTES),
            max_meta_bytes: Some(spec::limits::DEFAULT_MAX_META_BYTES),
            codecs: CodecSet::DEFINED,
            session: None,
        }
    }
}

impl FrameOptions {
    /// Options with no wire or metadata ceiling and no session pin. Every
    /// structural rule still applies.
    pub const fn unbounded() -> Self {
        Self { max_wire_bytes: None, max_meta_bytes: None, codecs: CodecSet::DEFINED, session: None }
    }

    /// Pins the session every decoded frame must carry.
    pub const fn with_session(mut self, session: u64) -> Self {
        self.session = Some(session);
        self
    }

    /// Replaces the negotiated codec set.
    pub const fn with_codecs(mut self, codecs: CodecSet) -> Self {
        self.codecs = codecs;
        self
    }

    /// Sets the wire and metadata ceilings.
    pub const fn with_limits(mut self, max_wire_bytes: u32, max_meta_bytes: u32) -> Self {
        self.max_wire_bytes = Some(max_wire_bytes);
        self.max_meta_bytes = Some(max_meta_bytes);
        self
    }
}

// --- header ------------------------------------------------------------------

/// The decoded 48-byte header. `kind` is the R5 `type` field, renamed because
/// `type` is a Rust keyword.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Header {
    /// REQUEST | RESPONSE | PUSH | CANCEL | INVALIDATE, from [`crate::spec::type_`].
    pub kind: u8,
    /// Data codec; 0 means the frame carries no data.
    pub codec: u16,
    /// Session id; nonzero after HELLO.
    pub session: u64,
    /// Per `(session, stream, direction)` counter starting at 1.
    pub seq: u32,
    /// Stream id; 0 is the control stream.
    pub stream: u32,
    /// Request id; nonzero on REQUEST/RESPONSE/CANCEL, zero elsewhere.
    pub correlation: u32,
    /// Metadata bytes following the header.
    pub meta_bytes: u32,
    /// Data bytes following the metadata.
    pub data_bytes: u32,
}

impl Header {
    /// Whether this frame type carries a correlation id. R5 §3.6.
    pub const fn correlation_required(kind: u8) -> bool {
        kind == spec::type_::REQUEST || kind == spec::type_::RESPONSE || kind == spec::type_::CANCEL
    }

    /// Bytes the complete record occupies, prefix included.
    pub const fn wire_bytes(&self) -> u64 {
        HEADER_BYTES as u64 + self.meta_bytes as u64 + self.data_bytes as u64
    }
}

/// A decoded record: the header plus borrowed views of the two payload
/// regions. `meta` is valid UTF-8, checked by [`decode`], and unparsed JSON;
/// this crate reads no JSON.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Frame<'a> {
    /// The validated header.
    pub header: Header,
    /// The metadata region, exactly `header.meta_bytes` long and valid UTF-8.
    pub meta: &'a [u8],
    /// The data region, exactly `header.data_bytes` long.
    pub data: &'a [u8],
}

/// One record to encode. `meta` must be valid UTF-8, which [`encode_into`]
/// checks; that it is a JSON object is the guarantee of the layer that
/// serialises metadata.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FrameInput<'a> {
    /// Frame type, from [`crate::spec::type_`].
    pub kind: u8,
    /// Data codec; 0 requires an empty `data`.
    pub codec: u16,
    /// Session id.
    pub session: u64,
    /// Sequence number; never 0.
    pub seq: u32,
    /// Stream id.
    pub stream: u32,
    /// Request id.
    pub correlation: u32,
    /// Serialised metadata bytes.
    pub meta: &'a [u8],
    /// Raw data bytes.
    pub data: &'a [u8],
}

// --- little-endian readers ---------------------------------------------------

const fn u16_at(b: &[u8], off: usize) -> u16 {
    u16::from_le_bytes([b[off], b[off + 1]])
}

const fn u32_at(b: &[u8], off: usize) -> u32 {
    u32::from_le_bytes([b[off], b[off + 1], b[off + 2], b[off + 3]])
}

const fn u64_at(b: &[u8], off: usize) -> u64 {
    u64::from_le_bytes([
        b[off], b[off + 1], b[off + 2], b[off + 3], b[off + 4], b[off + 5], b[off + 6], b[off + 7],
    ])
}

// --- decode ------------------------------------------------------------------

/// Decodes one complete record.
///
/// `record` must be exactly one record: a shorter slice is
/// [`FrameError::Truncated`], a longer one [`FrameError::BadLength`]. Use
/// [`RecordReader`] to cut records out of a stream first.
///
/// Checks run in the order the TypeScript codec uses, so a malformed frame
/// reports the same code in both: the receiver's `maxWireBytes` is enforced
/// before the declared payload length is trusted, and the length identity
/// `frameBytes + 4 == 48 + metaBytes + dataBytes` is enforced before either
/// region is sliced.
pub fn decode<'a>(record: &'a [u8], opts: &FrameOptions) -> Result<Frame<'a>, FrameError> {
    if record.len() < HEADER_BYTES {
        return Err(FrameError::ShortHeader);
    }

    let frame_bytes = u32_at(record, h::FRAME_BYTES_OFFSET);
    if (frame_bytes as usize) < HEADER_BODY_BYTES {
        return Err(FrameError::BadPrefix);
    }
    // The limit precedes any trust in the declared payload size. u64 keeps the
    // +4 from wrapping when frameBytes is near u32::MAX.
    let wire_bytes = frame_bytes as u64 + LENGTH_PREFIX_BYTES as u64;
    if let Some(max) = opts.max_wire_bytes
        && wire_bytes > max as u64
    {
        return Err(FrameError::WireTooLarge);
    }
    if (record.len() as u64) < wire_bytes {
        return Err(FrameError::Truncated);
    }
    if record.len() as u64 != wire_bytes {
        return Err(FrameError::BadLength);
    }

    if record[h::MAGIC_OFFSET..h::MAGIC_OFFSET + h::MAGIC_WIDTH] != spec::MAGIC {
        return Err(FrameError::BadMagic);
    }
    if record[h::MAJOR_OFFSET] != spec::frame::MAJOR as u8
        || record[h::MINOR_OFFSET] != spec::frame::MINOR as u8
    {
        return Err(FrameError::BadVersion);
    }
    let kind = record[h::TYPE_OFFSET];
    if !(spec::type_::REQUEST..=spec::type_::INVALIDATE).contains(&kind) {
        return Err(FrameError::BadType);
    }
    if record[h::FLAGS_OFFSET] != 0 {
        return Err(FrameError::BadFlags);
    }
    if u16_at(record, h::HEADER_BYTES_OFFSET) as usize != HEADER_BYTES {
        return Err(FrameError::BadHeaderSize);
    }

    let codec = u16_at(record, h::CODEC_OFFSET);
    let session = u64_at(record, h::SESSION_OFFSET);
    let seq = u32_at(record, h::SEQ_OFFSET);
    let stream = u32_at(record, h::STREAM_OFFSET);
    let correlation = u32_at(record, h::CORRELATION_OFFSET);
    let meta_bytes = u32_at(record, h::META_BYTES_OFFSET);
    let data_bytes = u32_at(record, h::DATA_BYTES_OFFSET);
    if u32_at(record, h::RESERVED_OFFSET) != 0 {
        return Err(FrameError::BadReserved);
    }

    if frame_bytes as u64 != HEADER_BODY_BYTES as u64 + meta_bytes as u64 + data_bytes as u64 {
        return Err(FrameError::BadLength);
    }
    if let Some(max) = opts.max_meta_bytes
        && meta_bytes > max
    {
        return Err(FrameError::MetaTooLarge);
    }
    if !opts.codecs.contains(codec) {
        return Err(FrameError::BadCodec);
    }
    if codec == spec::codec::NONE && data_bytes != 0 {
        return Err(FrameError::BadCodec);
    }
    if let Some(pinned) = opts.session
        && session != pinned
    {
        return Err(FrameError::BadSession);
    }
    if seq == 0 {
        return Err(FrameError::BadSeq);
    }
    if Header::correlation_required(kind) {
        if correlation == 0 {
            return Err(FrameError::BadCorrelation);
        }
    } else if correlation != 0 {
        return Err(FrameError::BadCorrelation);
    }
    // R5 §3.6: a CANCEL rides the control stream and names its target in
    // metadata, so the header field decides this before any metadata is read.
    if kind == spec::type_::CANCEL && stream != 0 {
        return Err(FrameError::BadCorrelation);
    }

    // The length identity above proves both regions sit inside the record.
    let meta_start = HEADER_BYTES;
    let data_start = meta_start + meta_bytes as usize;
    let data_end = data_start + data_bytes as usize;
    let meta = &record[meta_start..data_start];
    // R5 §3.3: the metadata region is strict UTF-8. Exactly `metaBytes` bytes
    // are scanned, so a sequence the data region would complete is still cut.
    if core::str::from_utf8(meta).is_err() {
        return Err(FrameError::BadMetadata);
    }
    Ok(Frame {
        header: Header {
            kind,
            codec,
            session,
            seq,
            stream,
            correlation,
            meta_bytes,
            data_bytes,
        },
        meta,
        data: &record[data_start..data_end],
    })
}

// --- encode ------------------------------------------------------------------

/// Bytes a record with these payload sizes occupies, or `None` when the record
/// is not representable: the `frameBytes` field is a u32, and the record has to
/// be addressable on this host.
pub const fn encoded_len(meta_len: usize, data_len: usize) -> Option<usize> {
    let payload = match (meta_len as u64).checked_add(data_len as u64) {
        Some(n) => n,
        None => return None,
    };
    let frame_bytes = match payload.checked_add(HEADER_BODY_BYTES as u64) {
        Some(n) => n,
        None => return None,
    };
    if frame_bytes > u32::MAX as u64 {
        return None;
    }
    // A 32-bit host — the PSP is one — cannot hold a record the u32 field can
    // still name, so the prefix is added in usize and checked there.
    (frame_bytes as usize).checked_add(LENGTH_PREFIX_BYTES)
}

/// Encodes one record into `out` and returns the bytes written.
///
/// Applies the same rules [`decode`] enforces, so a frame this function
/// accepts round-trips through the peer's decoder. The written bytes are
/// identical to what `framework/src/relay/frame.ts` produces for the same
/// input; `tests/fixtures/relay/vectors/` pins that.
pub fn encode_into(
    input: &FrameInput<'_>,
    out: &mut [u8],
    opts: &FrameOptions,
) -> Result<usize, EncodeError> {
    if !(spec::type_::REQUEST..=spec::type_::INVALIDATE).contains(&input.kind) {
        return Err(FrameError::BadType.into());
    }
    if !opts.codecs.contains(input.codec) {
        return Err(FrameError::BadCodec.into());
    }
    if input.codec == spec::codec::NONE && !input.data.is_empty() {
        return Err(FrameError::BadCodec.into());
    }
    if input.seq == 0 {
        return Err(FrameError::BadSeq.into());
    }
    if Header::correlation_required(input.kind) {
        if input.correlation == 0 {
            return Err(FrameError::BadCorrelation.into());
        }
    } else if input.correlation != 0 {
        return Err(FrameError::BadCorrelation.into());
    }
    if input.kind == spec::type_::CANCEL && input.stream != 0 {
        return Err(FrameError::BadCorrelation.into());
    }
    if core::str::from_utf8(input.meta).is_err() {
        return Err(FrameError::BadMetadata.into());
    }

    let wire_bytes = match encoded_len(input.meta.len(), input.data.len()) {
        Some(n) => n,
        None => return Err(FrameError::BadLength.into()),
    };
    if let Some(max) = opts.max_meta_bytes
        && input.meta.len() as u64 > max as u64
    {
        return Err(FrameError::MetaTooLarge.into());
    }
    if let Some(max) = opts.max_wire_bytes
        && wire_bytes as u64 > max as u64
    {
        return Err(FrameError::WireTooLarge.into());
    }
    if out.len() < wire_bytes {
        return Err(EncodeError::BufferTooSmall { needed: wire_bytes });
    }

    let frame_bytes = (wire_bytes - LENGTH_PREFIX_BYTES) as u32;
    let out = &mut out[..wire_bytes];
    out[..HEADER_BYTES].fill(0);
    out[h::FRAME_BYTES_OFFSET..][..4].copy_from_slice(&frame_bytes.to_le_bytes());
    out[h::MAGIC_OFFSET..][..4].copy_from_slice(&spec::MAGIC);
    out[h::MAJOR_OFFSET] = spec::frame::MAJOR as u8;
    out[h::MINOR_OFFSET] = spec::frame::MINOR as u8;
    out[h::TYPE_OFFSET] = input.kind;
    out[h::FLAGS_OFFSET] = 0;
    out[h::HEADER_BYTES_OFFSET..][..2].copy_from_slice(&(HEADER_BYTES as u16).to_le_bytes());
    out[h::CODEC_OFFSET..][..2].copy_from_slice(&input.codec.to_le_bytes());
    out[h::SESSION_OFFSET..][..8].copy_from_slice(&input.session.to_le_bytes());
    out[h::SEQ_OFFSET..][..4].copy_from_slice(&input.seq.to_le_bytes());
    out[h::STREAM_OFFSET..][..4].copy_from_slice(&input.stream.to_le_bytes());
    out[h::CORRELATION_OFFSET..][..4].copy_from_slice(&input.correlation.to_le_bytes());
    out[h::META_BYTES_OFFSET..][..4].copy_from_slice(&(input.meta.len() as u32).to_le_bytes());
    out[h::DATA_BYTES_OFFSET..][..4].copy_from_slice(&(input.data.len() as u32).to_le_bytes());
    // RESERVED_OFFSET stays zero from the fill above.
    let meta_end = HEADER_BYTES + input.meta.len();
    out[HEADER_BYTES..meta_end].copy_from_slice(input.meta);
    out[meta_end..].copy_from_slice(input.data);
    Ok(wire_bytes)
}

// --- record reassembly -------------------------------------------------------

/// Cuts length-prefixed records out of split or coalesced transport input,
/// using one caller-owned buffer and no allocation.
///
/// The buffer's length is the wire ceiling: a prefix declaring more than it
/// holds is [`FrameError::WireTooLarge`] before any byte accumulates, so a
/// forged prefix cannot drive a large copy.
///
/// ```
/// # use pocket_relay::{FrameOptions, RecordReader, decode};
/// # fn run(stream: &[u8]) -> Result<(), pocket_relay::FrameError> {
/// let mut storage = [0u8; 4096];
/// let mut reader = RecordReader::new(&mut storage)?;
/// let mut offset = 0;
/// while offset < stream.len() {
///     offset += reader.feed(&stream[offset..])?;
///     if let Some(record) = reader.record() {
///         let frame = decode(record, &FrameOptions::default())?;
///         let _ = frame.header.seq;
///         reader.consume_record();
///     }
/// }
/// # Ok(())
/// # }
/// ```
#[derive(Debug)]
pub struct RecordReader<'b> {
    buf: &'b mut [u8],
    have: usize,
}

impl<'b> RecordReader<'b> {
    /// Wraps a buffer. It must hold at least one 48-byte header; its length is
    /// the largest record this reader will accept.
    pub fn new(buf: &'b mut [u8]) -> Result<Self, FrameError> {
        if buf.len() < HEADER_BYTES {
            return Err(FrameError::ShortHeader);
        }
        Ok(Self { buf, have: 0 })
    }

    /// The wire ceiling: the buffer's length.
    pub const fn max_wire_bytes(&self) -> usize {
        self.buf.len()
    }

    /// Drops any partial record. Call after a transport reconnect.
    pub fn reset(&mut self) {
        self.have = 0;
    }

    /// Copies from `chunk` and returns the bytes taken, which is never past the
    /// end of the record in progress. When the return leaves [`Self::record`]
    /// non-`None`, read it and call [`Self::consume_record`] before feeding
    /// again. A protocol error leaves the reader empty; the caller must close
    /// the attachment rather than resynchronise, since the stream offset of the
    /// next record is no longer known.
    pub fn feed(&mut self, chunk: &[u8]) -> Result<usize, FrameError> {
        if chunk.is_empty() || self.record().is_some() {
            return Ok(0);
        }
        let mut taken = 0;

        if self.have < LENGTH_PREFIX_BYTES {
            let want = (LENGTH_PREFIX_BYTES - self.have).min(chunk.len());
            self.buf[self.have..self.have + want].copy_from_slice(&chunk[..want]);
            self.have += want;
            taken += want;
            if self.have < LENGTH_PREFIX_BYTES {
                return Ok(taken);
            }
            let declared = u32_at(self.buf, 0);
            if (declared as usize) < HEADER_BODY_BYTES {
                self.have = 0;
                return Err(FrameError::BadPrefix);
            }
            if declared as u64 + LENGTH_PREFIX_BYTES as u64 > self.buf.len() as u64 {
                self.have = 0;
                return Err(FrameError::WireTooLarge);
            }
        }

        let wire_bytes = u32_at(self.buf, 0) as usize + LENGTH_PREFIX_BYTES;
        let want = (wire_bytes - self.have).min(chunk.len() - taken);
        self.buf[self.have..self.have + want].copy_from_slice(&chunk[taken..taken + want]);
        self.have += want;
        Ok(taken + want)
    }

    /// The complete record, once one is buffered.
    pub fn record(&self) -> Option<&[u8]> {
        if self.have < LENGTH_PREFIX_BYTES {
            return None;
        }
        let wire_bytes = u32_at(self.buf, 0) as usize + LENGTH_PREFIX_BYTES;
        (self.have == wire_bytes).then(|| &self.buf[..wire_bytes])
    }

    /// Releases the buffered record so the next one can accumulate.
    pub fn consume_record(&mut self) {
        if self.record().is_some() {
            self.have = 0;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const META: &[u8] = br#"{"op":"relay.ping"}"#;

    fn request(codec: u16, data: &'static [u8]) -> FrameInput<'static> {
        FrameInput {
            kind: spec::type_::REQUEST,
            codec,
            session: 0x0102_0304_0506_0708,
            seq: 1,
            stream: 0,
            correlation: 1,
            meta: META,
            data,
        }
    }

    fn encode(input: &FrameInput<'_>, out: &mut [u8]) -> Result<usize, EncodeError> {
        encode_into(input, out, &FrameOptions::unbounded())
    }

    #[test]
    fn encode_then_decode_returns_the_same_header() {
        let mut out = [0u8; 256];
        let input = request(spec::codec::JSON, b"{\"x\":1}");
        let n = encode(&input, &mut out).unwrap();
        assert_eq!(n, encoded_len(META.len(), 7).unwrap());
        let frame = decode(&out[..n], &FrameOptions::unbounded()).unwrap();
        assert_eq!(frame.header.kind, input.kind);
        assert_eq!(frame.header.codec, input.codec);
        assert_eq!(frame.header.session, input.session);
        assert_eq!(frame.header.seq, input.seq);
        assert_eq!(frame.header.stream, input.stream);
        assert_eq!(frame.header.correlation, input.correlation);
        assert_eq!(frame.meta, input.meta);
        assert_eq!(frame.data, input.data);
    }

    #[test]
    fn the_encoded_header_is_little_endian_at_the_spec_offsets() {
        let mut out = [0u8; 256];
        let input = request(spec::codec::JSON, b"ab");
        let n = encode(&input, &mut out).unwrap();
        assert_eq!(&out[h::MAGIC_OFFSET..][..4], b"PRLY");
        assert_eq!(u32_at(&out, h::FRAME_BYTES_OFFSET) as usize, n - LENGTH_PREFIX_BYTES);
        assert_eq!(u16_at(&out, h::HEADER_BYTES_OFFSET) as usize, HEADER_BYTES);
        assert_eq!(u64_at(&out, h::SESSION_OFFSET), input.session);
        // The session's low byte sits first: little-endian, not the hex order.
        assert_eq!(out[h::SESSION_OFFSET], 0x08);
        assert_eq!(u32_at(&out, h::META_BYTES_OFFSET) as usize, META.len());
        assert_eq!(u32_at(&out, h::DATA_BYTES_OFFSET), 2);
        assert_eq!(u32_at(&out, h::RESERVED_OFFSET), 0);
        assert_eq!(out[h::FLAGS_OFFSET], 0);
    }

    #[test]
    fn encode_applies_every_rule_decode_applies() {
        let mut out = [0u8; 256];
        let bad_type = FrameInput { kind: 0, ..request(spec::codec::NONE, b"") };
        assert_eq!(encode(&bad_type, &mut out), Err(FrameError::BadType.into()));
        let bad_type = FrameInput { kind: 6, ..request(spec::codec::NONE, b"") };
        assert_eq!(encode(&bad_type, &mut out), Err(FrameError::BadType.into()));

        let zero_seq = FrameInput { seq: 0, ..request(spec::codec::NONE, b"") };
        assert_eq!(encode(&zero_seq, &mut out), Err(FrameError::BadSeq.into()));

        let no_correlation = FrameInput { correlation: 0, ..request(spec::codec::NONE, b"") };
        assert_eq!(encode(&no_correlation, &mut out), Err(FrameError::BadCorrelation.into()));

        let push = FrameInput {
            kind: spec::type_::PUSH,
            correlation: 7,
            ..request(spec::codec::NONE, b"")
        };
        assert_eq!(encode(&push, &mut out), Err(FrameError::BadCorrelation.into()));
        let push = FrameInput { correlation: 0, ..push };
        assert!(encode(&push, &mut out).is_ok(), "PUSH carries no correlation");

        // R5 §3.6: a CANCEL rides stream 0; its target stream is metadata.
        let cancel = FrameInput { kind: spec::type_::CANCEL, ..request(spec::codec::NONE, b"") };
        assert!(encode(&cancel, &mut out).is_ok(), "CANCEL on the control stream");
        let off_stream = FrameInput { stream: 1, ..cancel };
        assert_eq!(encode(&off_stream, &mut out), Err(FrameError::BadCorrelation.into()));
        let request_off_stream = FrameInput { stream: 1, ..request(spec::codec::NONE, b"") };
        assert!(encode(&request_off_stream, &mut out).is_ok(), "only CANCEL is bound to stream 0");

        // Codec 0 means "no data region"; data with it is a contradiction.
        assert_eq!(
            encode(&request(spec::codec::NONE, b"x"), &mut out),
            Err(FrameError::BadCodec.into())
        );
        assert_eq!(
            encode(&request(spec::codec::EXTENSION_MIN, b"x"), &mut out),
            Err(FrameError::BadCodec.into()),
            "an extension codec is refused until negotiated"
        );

        // R5 §3.3: metadata is strict UTF-8. A stray byte is refused before
        // anything is written, as the peer's decoder would refuse the record.
        let not_utf8 =
            FrameInput { meta: b"{\"op\":\"relay.p\xffng\"}", ..request(spec::codec::NONE, b"") };
        let mut untouched = [0u8; 256];
        assert_eq!(encode(&not_utf8, &mut untouched), Err(FrameError::BadMetadata.into()));
        assert!(untouched.iter().all(|&b| b == 0), "a refused frame wrote nothing");
    }

    /// R5 §3.6: a CANCEL rides the control stream. Review 965 built this
    /// record from the legal `cancel` vector by writing 1 over the stream
    /// field; the same edit on a REQUEST is a legal stream change.
    #[test]
    fn decode_refuses_a_cancel_off_the_control_stream() {
        let mut out = [0u8; 256];
        let cancel = FrameInput { kind: spec::type_::CANCEL, ..request(spec::codec::NONE, b"") };
        let n = encode(&cancel, &mut out).unwrap();
        assert!(decode(&out[..n], &FrameOptions::unbounded()).is_ok());
        out[h::STREAM_OFFSET..][..4].copy_from_slice(&1u32.to_le_bytes());
        assert_eq!(decode(&out[..n], &FrameOptions::unbounded()), Err(FrameError::BadCorrelation));
        out[h::TYPE_OFFSET] = spec::type_::REQUEST;
        let frame = decode(&out[..n], &FrameOptions::unbounded()).unwrap();
        assert_eq!(frame.header.stream, 1);
    }

    /// R5 §3.3: the metadata region is strict UTF-8. The check covers exactly
    /// `metaBytes` bytes: a lead byte that ends the region is incomplete even
    /// when the first data byte would complete the sequence.
    #[test]
    fn decode_refuses_metadata_that_is_not_utf8() {
        let mut out = [0u8; 256];
        let input = request(spec::codec::OPAQUE_BYTES, b"\xa9\x00");
        let n = encode(&input, &mut out).unwrap();
        assert!(decode(&out[..n], &FrameOptions::unbounded()).is_ok());

        // One metadata byte is not UTF-8; the header is intact.
        let mut stray = out;
        stray[HEADER_BYTES + 2] = 0xff;
        assert_eq!(decode(&stray[..n], &FrameOptions::unbounded()), Err(FrameError::BadMetadata));

        // The last metadata byte becomes a two-byte lead; the data region
        // already opens with the continuation byte 0xa9. Valid across the
        // boundary, invalid within the region.
        let mut cut = out;
        cut[HEADER_BYTES + META.len() - 1] = 0xc3;
        assert_eq!(decode(&cut[..n], &FrameOptions::unbounded()), Err(FrameError::BadMetadata));

        // Multibyte UTF-8 passes: the rule is validity, not ASCII.
        let unicode = FrameInput {
            meta: "{\"op\":\"relay.ping\",\"note\":\"café 协议 🎮\"}".as_bytes(),
            ..input
        };
        let n = encode(&unicode, &mut out).unwrap();
        let frame = decode(&out[..n], &FrameOptions::unbounded()).unwrap();
        assert_eq!(frame.meta, unicode.meta);
    }

    #[test]
    fn an_extension_codec_works_once_negotiated() {
        let mut out = [0u8; 256];
        let mut codecs = CodecSet::DEFINED;
        codecs.insert(spec::codec::EXTENSION_MIN).unwrap();
        let opts = FrameOptions::unbounded().with_codecs(codecs);
        let input = request(spec::codec::EXTENSION_MIN, b"x");
        let n = encode_into(&input, &mut out, &opts).unwrap();
        assert_eq!(decode(&out[..n], &opts).unwrap().header.codec, spec::codec::EXTENSION_MIN);
        // The same bytes are refused by a peer that did not negotiate it.
        assert_eq!(
            decode(&out[..n], &FrameOptions::unbounded()),
            Err(FrameError::BadCodec)
        );
    }

    #[test]
    fn encode_enforces_the_receivers_limits_and_the_buffer() {
        let input = request(spec::codec::JSON, b"0123456789");
        let wire = encoded_len(META.len(), 10).unwrap();

        let mut out = [0u8; 256];
        let tight = FrameOptions::unbounded().with_limits(wire as u32, META.len() as u32);
        assert!(encode_into(&input, &mut out, &tight).is_ok(), "the ceiling is inclusive");

        let narrow = FrameOptions::unbounded().with_limits(wire as u32 - 1, 2048);
        assert_eq!(encode_into(&input, &mut out, &narrow), Err(FrameError::WireTooLarge.into()));

        let thin = FrameOptions::unbounded().with_limits(65536, META.len() as u32 - 1);
        assert_eq!(encode_into(&input, &mut out, &thin), Err(FrameError::MetaTooLarge.into()));

        let mut small = [0u8; 8];
        assert_eq!(
            encode(&input, &mut small),
            Err(EncodeError::BufferTooSmall { needed: wire })
        );
        // The limit check runs first: a refused frame never reports the buffer.
        assert_eq!(
            encode_into(&input, &mut small, &narrow),
            Err(FrameError::WireTooLarge.into())
        );
    }

    #[test]
    fn encode_leaves_a_longer_buffer_untouched_past_the_record() {
        let mut out = [0xaau8; 512];
        let n = encode(&request(spec::codec::JSON, b"xy"), &mut out).unwrap();
        assert!(out[n..].iter().all(|&b| b == 0xaa), "encode wrote past the record");
    }

    #[test]
    fn encoded_len_refuses_a_frame_past_the_u32_field() {
        assert_eq!(encoded_len(0, 0), Some(HEADER_BYTES));
        // The largest frameBytes the u32 field can name still needs four more
        // bytes of prefix, so the last representable record is short of it.
        let max_payload = u32::MAX as usize - HEADER_BODY_BYTES;
        assert_eq!(encoded_len(0, max_payload - LENGTH_PREFIX_BYTES), Some(u32::MAX as usize));
        assert_eq!(encoded_len(0, max_payload + 1), None, "past the u32 field");
        // Sizes no slice could have must report None, not wrap to a small one.
        assert_eq!(encoded_len(usize::MAX / 2, usize::MAX / 2), None);
        assert_eq!(encoded_len(usize::MAX, usize::MAX), None);
        assert_eq!(encoded_len(usize::MAX, 0), None);
    }

    /// The receiver's guarantees are inclusive: a record of exactly
    /// `maxWireBytes`, or metadata of exactly `maxMetaBytes`, is admitted. A
    /// peer that refused at the boundary would reject frames the TypeScript
    /// codec considers legal, since it checks the same two limits inclusively.
    #[test]
    fn the_wire_and_meta_ceilings_are_inclusive_on_decode() {
        let mut out = [0u8; 512];
        let input = request(spec::codec::JSON, b"0123456789");
        let n = encode(&input, &mut out).unwrap();
        let record = &out[..n];

        let exact = FrameOptions::unbounded().with_limits(n as u32, META.len() as u32);
        assert!(decode(record, &exact).is_ok(), "a record at the ceiling is admitted");

        let narrow = FrameOptions::unbounded().with_limits(n as u32 - 1, META.len() as u32);
        assert_eq!(decode(record, &narrow), Err(FrameError::WireTooLarge));

        let thin = FrameOptions::unbounded().with_limits(n as u32, META.len() as u32 - 1);
        assert_eq!(decode(record, &thin), Err(FrameError::MetaTooLarge));
    }

    /// `frameBytes` counts the 44-byte header body, so 44 is the smallest legal
    /// value: an empty-metadata, no-data frame. 43 cannot describe a record.
    #[test]
    fn the_smallest_legal_frame_bytes_is_the_header_body() {
        let mut out = [0u8; 64];
        let empty = FrameInput { meta: b"", ..request(spec::codec::NONE, b"") };
        let n = encode(&empty, &mut out).unwrap();
        assert_eq!(n, HEADER_BYTES, "an empty frame is the header alone");
        assert_eq!(
            u32_at(&out, h::FRAME_BYTES_OFFSET) as usize,
            HEADER_BODY_BYTES,
            "frameBytes counts the header body, not the prefix"
        );
        assert!(decode(&out[..n], &FrameOptions::unbounded()).is_ok());

        // One below the header body describes no record at all.
        let mut short = out;
        short[h::FRAME_BYTES_OFFSET..][..4]
            .copy_from_slice(&((HEADER_BODY_BYTES - 1) as u32).to_le_bytes());
        assert_eq!(
            decode(&short[..n], &FrameOptions::unbounded()),
            Err(FrameError::BadPrefix)
        );
        for below in [0u32, 1, 43] {
            short[h::FRAME_BYTES_OFFSET..][..4].copy_from_slice(&below.to_le_bytes());
            assert_eq!(
                decode(&short[..n], &FrameOptions::unbounded()),
                Err(FrameError::BadPrefix),
                "frameBytes {below}"
            );
        }
    }

    #[test]
    fn a_session_pin_refuses_the_bootstrap_session() {
        let mut out = [0u8; 256];
        let input = FrameInput { session: 0, ..request(spec::codec::NONE, b"") };
        let n = encode(&input, &mut out).unwrap();
        let pinned = FrameOptions::unbounded().with_session(0x0102_0304_0506_0708);
        assert_eq!(decode(&out[..n], &pinned), Err(FrameError::BadSession));
        assert!(decode(&out[..n], &FrameOptions::unbounded()).is_ok());
        assert!(decode(&out[..n], &FrameOptions::unbounded().with_session(0)).is_ok());
    }

    #[test]
    fn codec_set_holds_its_capacity_and_collapses_duplicates() {
        let mut set = CodecSet::new();
        assert!(set.is_empty());
        assert!(!set.contains(spec::codec::NONE), "an empty set accepts nothing");
        for i in 0..CodecSet::CAPACITY as u16 {
            set.insert(i).unwrap();
            set.insert(i).unwrap();
        }
        assert_eq!(set.len(), CodecSet::CAPACITY);
        assert_eq!(set.insert(9999), Err(FrameError::BadCodec));
        assert_eq!(set.insert(0), Ok(()), "a value already present still fits");

        let from_slice = CodecSet::from_slice(&[1, 1, 2, 2, 3]).unwrap();
        assert_eq!(from_slice.len(), 3);
        let mut too_many = [0u16; CodecSet::CAPACITY + 1];
        for (i, v) in too_many.iter_mut().enumerate() {
            *v = i as u16;
        }
        assert_eq!(CodecSet::from_slice(&too_many), Err(FrameError::BadCodec));
    }

    #[test]
    fn default_options_match_the_spec_defaults() {
        let d = FrameOptions::default();
        assert_eq!(d.max_wire_bytes, Some(spec::limits::DEFAULT_MAX_WIRE_BYTES));
        assert_eq!(d.max_meta_bytes, Some(spec::limits::DEFAULT_MAX_META_BYTES));
        assert_eq!(d.codecs, CodecSet::DEFINED);
        assert_eq!(d.session, None);
        assert_eq!(FrameOptions::unbounded().max_wire_bytes, None);
    }

    /// Every frame the encoder accepts must decode back to the same header and
    /// the same two regions, across the whole field space.
    #[test]
    fn round_trip_holds_over_a_generated_sweep() {
        let mut state = 0x243f_6a88_85a3_08d3u64; // splitmix64
        let mut next = move || {
            state = state.wrapping_add(0x9e37_79b9_7f4a_7c15);
            let mut z = state;
            z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
            z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
            z ^ (z >> 31)
        };
        let mut payload = [0u8; 4096];
        for (i, b) in payload.iter_mut().enumerate() {
            *b = i as u8;
        }
        // Metadata must be UTF-8: a text with 1-, 2-, 3- and 4-byte sequences,
        // repeated to fill the buffer and cut on a character boundary below.
        const TEXT: &[u8] = "{\"op\":\"relay.ping\",\"note\":\"café 协议 🎮 \"}".as_bytes();
        let mut text = [0u8; 1024];
        for (i, b) in text.iter_mut().enumerate() {
            *b = TEXT[i % TEXT.len()];
        }
        let mut out = [0u8; 8192];
        let kinds = [
            spec::type_::REQUEST,
            spec::type_::RESPONSE,
            spec::type_::PUSH,
            spec::type_::CANCEL,
            spec::type_::INVALIDATE,
        ];
        let codecs = [
            spec::codec::NONE,
            spec::codec::JSON,
            spec::codec::R5G6B5LE,
            spec::codec::OPAQUE_BYTES,
        ];

        let mut checked = 0;
        for _ in 0..2000 {
            let r = next();
            let kind = kinds[(r % 5) as usize];
            let codec = codecs[((r >> 8) % 4) as usize];
            let mut meta_len = ((r >> 16) % 1024) as usize;
            while meta_len > 0 && (text[meta_len] & 0xc0) == 0x80 {
                meta_len -= 1; // never cut inside a multibyte sequence
            }
            let data_len = if codec == spec::codec::NONE {
                0
            } else {
                ((r >> 32) % 3072) as usize
            };
            let input = FrameInput {
                kind,
                codec,
                session: next(),
                seq: (next() as u32).max(1),
                stream: if kind == spec::type_::CANCEL { 0 } else { next() as u32 },
                correlation: if Header::correlation_required(kind) {
                    (next() as u32).max(1)
                } else {
                    0
                },
                meta: &text[..meta_len],
                data: &payload[..data_len],
            };
            let n = encode(&input, &mut out).expect("generated frame encodes");
            assert_eq!(n, HEADER_BYTES + meta_len + data_len);
            let frame = decode(&out[..n], &FrameOptions::unbounded()).expect("it decodes back");
            assert_eq!(frame.header.kind, input.kind);
            assert_eq!(frame.header.codec, input.codec);
            assert_eq!(frame.header.session, input.session);
            assert_eq!(frame.header.seq, input.seq);
            assert_eq!(frame.header.stream, input.stream);
            assert_eq!(frame.header.correlation, input.correlation);
            assert_eq!(frame.meta, input.meta);
            assert_eq!(frame.data, input.data);
            assert_eq!(frame.header.wire_bytes(), n as u64);
            checked += 1;
        }
        assert_eq!(checked, 2000);
    }

    #[test]
    fn error_codes_are_the_shared_wire_spellings() {
        assert_eq!(FrameError::BadMagic.as_str(), "BAD_MAGIC");
        assert_eq!(FrameError::WireTooLarge.as_str(), spec::frame_error::WIRE_TOO_LARGE);
        // Distinct variants must not collapse onto one code.
        let all = [
            FrameError::ShortHeader, FrameError::BadPrefix, FrameError::BadMagic,
            FrameError::BadVersion, FrameError::BadType, FrameError::BadFlags,
            FrameError::BadHeaderSize, FrameError::BadReserved, FrameError::BadLength,
            FrameError::Truncated, FrameError::WireTooLarge, FrameError::MetaTooLarge,
            FrameError::BadCodec, FrameError::BadSession, FrameError::BadSeq,
            FrameError::BadCorrelation, FrameError::BadMetadata, FrameError::BadEnvelope,
        ];
        for (i, a) in all.iter().enumerate() {
            for b in &all[i + 1..] {
                assert_ne!(a.as_str(), b.as_str(), "{a:?} and {b:?} share a code");
            }
        }
        assert_eq!(all.len(), 18);
    }
}
