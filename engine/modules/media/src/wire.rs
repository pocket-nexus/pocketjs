//! SVC WIRE protocol (PKNT) parsing — the svc mailbox over a socket (byte
//! layout in spec.ts "SVC WIRE protocol"). Pure bounds-checked readers and
//! fixed-size encoders over borrowed byte slices, the stream.rs discipline:
//! the host owns every socket and buffer; this module only interprets bytes,
//! so it stays no_std and unit-testable on any target. Hostile lengths
//! return None, never panic.

use crate::spec::wire;
use crate::{rd_u16, rd_u32};

/// One decoded frame header (HEADER_SIZE bytes).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct FrameHeader {
    pub kind: u8,
    pub flags: u8,
    pub len: u32,
}

/// Parse a frame header. None on short input or a payload length over
/// MAX_PAYLOAD (the reader must close the connection — resync inside a byte
/// stream is impossible).
pub fn parse_frame_header(b: &[u8]) -> Option<FrameHeader> {
    if b.len() < wire::HEADER_SIZE {
        return None;
    }
    let len = rd_u32(b, 4)?;
    if len as usize > wire::MAX_PAYLOAD {
        return None;
    }
    Some(FrameHeader { kind: b[0], flags: b[1], len })
}

/// Encode a frame header into `out` (exactly HEADER_SIZE bytes).
pub fn encode_frame_header(kind: u8, flags: u8, len: u32, out: &mut [u8]) -> bool {
    if out.len() < wire::HEADER_SIZE || len as usize > wire::MAX_PAYLOAD {
        return false;
    }
    out[0] = kind;
    out[1] = flags;
    out[2] = 0;
    out[3] = 0;
    out[4..8].copy_from_slice(&len.to_le_bytes());
    true
}

/// The device's opening handshake: magic · version · reserved · appLen · app.
/// Returns the encoded length, or None when `out` is too small / the app id
/// does not fit its u8 length.
pub fn encode_hello(app: &str, out: &mut [u8]) -> Option<usize> {
    let app = app.as_bytes();
    if app.is_empty() || app.len() > 64 {
        return None;
    }
    let total = 7 + app.len();
    if out.len() < total {
        return None;
    }
    out[0..4].copy_from_slice(&wire::MAGIC.to_le_bytes());
    out[4] = wire::VERSION;
    out[5] = 0;
    out[6] = app.len() as u8;
    out[7..7 + app.len()].copy_from_slice(app);
    Some(total)
}

/// The host's handshake ack: magic · acceptedVersion · flags · reserved.
/// Returns the accepted version.
pub fn parse_hello_ack(b: &[u8]) -> Option<u8> {
    if b.len() < 8 || rd_u32(b, 0)? != wire::MAGIC {
        return None;
    }
    Some(b[4])
}

/// A `file` payload: svc-relative path + whole IMG-entry bytes.
pub fn parse_file<'a>(payload: &'a [u8]) -> Option<(&'a str, &'a [u8])> {
    let path_len = rd_u16(payload, 0)? as usize;
    let blob_at = 2usize.checked_add(path_len)?;
    if payload.len() < blob_at {
        return None;
    }
    let path = core::str::from_utf8(&payload[2..blob_at]).ok()?;
    Some((path, &payload[blob_at..]))
}

/// A `streamOpen` payload: announced path + the verbatim 96-byte header block.
pub fn parse_stream_open<'a>(payload: &'a [u8]) -> Option<(&'a str, &'a [u8])> {
    let (path, block) = parse_file(payload)?;
    if block.len() != crate::spec::stream::HEADER_BLOCK_SIZE {
        return None;
    }
    Some((path, block))
}

/// A `videoSlot` payload (leading fields + palette + indices).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct VideoSlotMsg<'a> {
    pub seq: u32,
    pub frame_index: u32,
    pub w: u32,
    pub h: u32,
    /// Indices are PackBits-RLE (decode to exactly w*h) instead of raw.
    pub rle: bool,
    pub palette: &'a [u8],
    pub indices: &'a [u8],
}

pub fn parse_video_slot<'a>(payload: &'a [u8]) -> Option<VideoSlotMsg<'a>> {
    let palette_at = wire::SLOT_HEADER_SIZE;
    let indices_at = palette_at.checked_add(1024)?;
    if payload.len() < indices_at {
        return None;
    }
    let seq = rd_u32(payload, 0)?;
    let frame_index = rd_u32(payload, 4)?;
    let w = rd_u16(payload, 8)? as u32;
    let h = rd_u16(payload, 10)? as u32;
    let flags = rd_u16(payload, 12)?;
    if seq == 0 {
        return None;
    }
    Some(VideoSlotMsg {
        seq,
        frame_index,
        w,
        h,
        rle: flags & wire::SLOT_FLAG_RLE != 0,
        palette: &payload[palette_at..indices_at],
        indices: &payload[indices_at..],
    })
}

/// An `audioChunk` payload (leading fields + interleaved s16 PCM bytes).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct AudioChunkMsg<'a> {
    pub seq: u32,
    pub start_frame: u32,
    pub pcm: &'a [u8],
}

pub fn parse_audio_chunk<'a>(payload: &'a [u8]) -> Option<AudioChunkMsg<'a>> {
    if payload.len() < wire::CHUNK_HEADER_SIZE {
        return None;
    }
    let seq = rd_u32(payload, 0)?;
    if seq == 0 {
        return None;
    }
    Some(AudioChunkMsg {
        seq,
        start_frame: rd_u32(payload, 4)?,
        pcm: &payload[wire::CHUNK_HEADER_SIZE..],
    })
}

/// A `streamMark` payload: epoch bump / ended marker.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct StreamMarkMsg {
    pub epoch: u32,
    pub ended: bool,
}

pub fn parse_stream_mark(payload: &[u8]) -> Option<StreamMarkMsg> {
    if payload.len() < wire::MARK_SIZE {
        return None;
    }
    Some(StreamMarkMsg {
        epoch: rd_u32(payload, 0)?,
        ended: rd_u16(payload, 4)? & wire::MARK_FLAG_ENDED != 0,
    })
}

/// A discovery beacon datagram. Returns (tcpPort, app, displayName).
pub fn parse_beacon<'a>(datagram: &'a [u8]) -> Option<(u16, &'a str, &'a str)> {
    if rd_u32(datagram, 0)? != wire::BEACON_MAGIC || datagram.get(4).copied()? != wire::VERSION {
        return None;
    }
    let port = rd_u16(datagram, 6)?;
    let app_len = datagram.get(8).copied()? as usize;
    let name_len_at = 9usize.checked_add(app_len)?;
    let name_len = datagram.get(name_len_at).copied()? as usize;
    let name_at = name_len_at + 1;
    let end = name_at.checked_add(name_len)?;
    if datagram.len() < end {
        return None;
    }
    let app = core::str::from_utf8(&datagram[9..name_len_at]).ok()?;
    let name = core::str::from_utf8(&datagram[name_at..end]).ok()?;
    Some((port, app, name))
}
