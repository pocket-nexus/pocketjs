//! STREAM container (.pkst) parsing — the host-written video+audio ring file
//! behind the videoOpen/videoTick ops (byte layout in spec.ts "STREAM
//! container"). Pure bounds-checked readers over borrowed byte slices: the
//! native host owns the file IO and the staging buffers; this module only
//! interprets bytes, so it stays no_std and unit-testable on any target.
//!
//! Same hardening rules as the TILESET reader: every offset/length read is
//! checked, hostile values return None instead of panicking, and
//! checked_add/checked_mul keep 32-bit usize (PSP, wasm) from overflowing.

use crate::spec;
use crate::{rd_u16, rd_u32};

/// Video ring geometry + write cursor (header at spec::stream::VRING_OFF).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct VideoRing {
    pub w: u32,
    pub h: u32,
    pub fps_num: u32,
    pub fps_den: u32,
    pub slot_count: u32,
    pub slot_size: u32,
    /// Newest fully-written frame seq (0 = none yet; seqs start at 1).
    pub latest_seq: u32,
    /// Source length in frames (0 = unknown/live).
    pub total_frames: u32,
}

/// Audio ring geometry + write cursor (header at spec::stream::ARING_OFF).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct AudioRing {
    pub sample_rate: u32,
    pub channels: u32,
    pub chunk_frames: u32,
    pub chunk_count: u32,
    /// Newest fully-written chunk seq (0 = none yet; seqs start at 1).
    pub latest_seq: u32,
}

/// The decoded 96-byte header block — everything the reader re-polls per tick.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct StreamHeaders {
    /// Writer discontinuity counter (seek/new source): on a change the reader
    /// drops its ring positions and re-syncs to latest.
    pub epoch: u32,
    /// Source exhausted; latest_seq values are final.
    pub ended: bool,
    pub video_off: u32,
    pub audio_off: u32,
    pub video: VideoRing,
    pub audio: AudioRing,
}

/// One video slot's leading header (SLOT_HEADER_SIZE bytes).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct SlotHeader {
    pub seq: u32,
    pub frame_index: u32,
    pub w: u32,
    pub h: u32,
}

/// One audio chunk's leading header (CHUNK_HEADER_SIZE bytes).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct ChunkHeader {
    pub seq: u32,
    /// Position of the chunk's first sample frame on the source timeline.
    pub start_frame: u32,
}

fn pow2_dim(v: u32) -> bool {
    v > 0 && v <= spec::TEX_MAX_DIM && v & (v - 1) == 0
}

/// Parse + validate the 96-byte header block (bytes from file offset 0).
/// None on short input, bad magic/version, or geometry the reader could not
/// safely index (non-pow2 plane, zero rings, undersized slots, silly PCM
/// shapes) — a malformed stream is refused up front, never bounds-trusted
/// later.
pub fn parse_header_block(b: &[u8]) -> Option<StreamHeaders> {
    use spec::stream as st;
    if b.len() < st::HEADER_BLOCK_SIZE {
        return None;
    }
    if rd_u32(b, 0)? != st::MAGIC || rd_u16(b, 4)? != st::VERSION {
        return None;
    }
    let flags = rd_u16(b, 6)?;
    let epoch = rd_u32(b, 8)?;
    let video_off = rd_u32(b, 12)?;
    let audio_off = rd_u32(b, 16)?;

    if rd_u32(b, st::VRING_OFF)? != st::VRING_MAGIC {
        return None;
    }
    let w = rd_u16(b, st::VRING_OFF + 4)? as u32;
    let h = rd_u16(b, st::VRING_OFF + 6)? as u32;
    let fps_num = rd_u16(b, st::VRING_OFF + 8)? as u32;
    let fps_den = rd_u16(b, st::VRING_OFF + 10)? as u32;
    let slot_count = rd_u32(b, st::VRING_OFF + 12)?;
    let slot_size = rd_u32(b, st::VRING_OFF + 16)?;
    let v_latest = rd_u32(b, st::VRING_OFF + 20)?;
    let total_frames = rd_u32(b, st::VRING_OFF + 24)?;
    if !pow2_dim(w) || !pow2_dim(h) || fps_num == 0 || fps_den == 0 || slot_count == 0 {
        return None;
    }
    // The plane texture is exactly w*h CLUT8 — a slot must carry it whole.
    let need = (st::SLOT_HEADER_SIZE as u32)
        .checked_add(1024)?
        .checked_add(w.checked_mul(h)?)?;
    if slot_size < need {
        return None;
    }
    // The whole ring must be addressable in 32 bits (file offsets are u32).
    video_off.checked_add(slot_count.checked_mul(slot_size)?)?;

    if rd_u32(b, st::ARING_OFF)? != st::ARING_MAGIC {
        return None;
    }
    let sample_rate = rd_u32(b, st::ARING_OFF + 4)?;
    let channels = rd_u16(b, st::ARING_OFF + 8)? as u32;
    let chunk_frames = rd_u32(b, st::ARING_OFF + 12)?;
    let chunk_count = rd_u32(b, st::ARING_OFF + 16)?;
    let a_latest = rd_u32(b, st::ARING_OFF + 20)?;
    if !(1..=2).contains(&channels)
        || !(4000..=48000).contains(&sample_rate)
        || chunk_frames == 0
        || chunk_count == 0
    {
        return None;
    }
    let chunk_size = chunk_size(chunk_frames, channels)?;
    audio_off.checked_add(chunk_count.checked_mul(chunk_size)?)?;

    Some(StreamHeaders {
        epoch,
        ended: flags & st::FLAG_ENDED != 0,
        video_off,
        audio_off,
        video: VideoRing {
            w,
            h,
            fps_num,
            fps_den,
            slot_count,
            slot_size,
            latest_seq: v_latest,
            total_frames,
        },
        audio: AudioRing { sample_rate, channels, chunk_frames, chunk_count, latest_seq: a_latest },
    })
}

/// File offset of the slot holding `seq` (seqs start at 1).
pub fn slot_offset(h: &StreamHeaders, seq: u32) -> Option<u32> {
    if seq == 0 {
        return None;
    }
    let idx = (seq - 1) % h.video.slot_count;
    h.video_off.checked_add(idx.checked_mul(h.video.slot_size)?)
}

/// Whole-chunk byte size (header + PCM payload).
pub fn chunk_size(chunk_frames: u32, channels: u32) -> Option<u32> {
    (spec::stream::CHUNK_HEADER_SIZE as u32)
        .checked_add(chunk_frames.checked_mul(channels)?.checked_mul(2)?)
}

/// File offset of the chunk holding `seq` (seqs start at 1).
pub fn chunk_offset(h: &StreamHeaders, seq: u32) -> Option<u32> {
    if seq == 0 {
        return None;
    }
    let idx = (seq - 1) % h.audio.chunk_count;
    h.audio_off.checked_add(idx.checked_mul(chunk_size(h.audio.chunk_frames, h.audio.channels)?)?)
}

/// Parse a slot's leading header. `expect` pins the ring geometry: a slot
/// whose dims disagree with the stream header is malformed (or torn) and
/// must not be presented.
pub fn parse_slot_header(b: &[u8], expect: &VideoRing) -> Option<SlotHeader> {
    if b.len() < spec::stream::SLOT_HEADER_SIZE {
        return None;
    }
    let seq = rd_u32(b, 0)?;
    let frame_index = rd_u32(b, 4)?;
    let w = rd_u16(b, 8)? as u32;
    let h = rd_u16(b, 10)? as u32;
    if seq == 0 || w != expect.w || h != expect.h {
        return None;
    }
    Some(SlotHeader { seq, frame_index, w, h })
}

/// Parse an audio chunk's leading header.
pub fn parse_chunk_header(b: &[u8]) -> Option<ChunkHeader> {
    if b.len() < spec::stream::CHUNK_HEADER_SIZE {
        return None;
    }
    let seq = rd_u32(b, 0)?;
    if seq == 0 {
        return None;
    }
    Some(ChunkHeader { seq, start_frame: rd_u32(b, 4)? })
}
