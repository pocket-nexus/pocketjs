//! RAM `.pkst` assembler — the receive side of the WIRE stream messages.
//!
//! `RamStream` maintains a byte-exact `.pkst` FILE IMAGE in memory: the same
//! 96-byte header block, the same video/audio rings at the same offsets. A
//! host that receives WIRE videoSlot/audioChunk/streamMark messages applies
//! them here, then points the exact same reader logic (stream.rs
//! parse_header_block / slot_offset / parse_slot_header / chunk_offset) at
//! `buf()` — the file-backed and socket-backed transports share one reader,
//! one torn-frame contract, one golden format.
//!
//! The publish order is preserved verbatim: payload bytes land first, the
//! ring's latestSeq is written after. Over TCP nothing can tear mid-slot,
//! but the reader's seq re-check stays meaningful across epoch resets and
//! writer laps, and keeping the invariant means the two transports are
//! byte-equivalent, not just morally similar.

use alloc::vec;
use alloc::vec::Vec;

use crate::codec;
use crate::spec::stream as st;
use crate::spec::wire;
use crate::stream::{self, StreamHeaders};

pub struct RamStream {
    buf: Vec<u8>,
    /// Ring GEOMETRY parsed at open (fixed for the stream's lifetime). Live
    /// cursors (latestSeq, epoch, ended) are read from `buf` like any reader.
    geo: StreamHeaders,
}

impl RamStream {
    /// Allocate the ring image from a verbatim 96-byte header block (a WIRE
    /// streamOpen payload). The block is validated by the same
    /// parse_header_block every reader runs; a malformed one is refused here,
    /// before any allocation is trusted.
    pub fn open(header_block: &[u8]) -> Option<Self> {
        let geo = stream::parse_header_block(header_block)?;
        let chunk_size = stream::chunk_size(geo.audio.chunk_frames, geo.audio.channels)?;
        let video_end = geo.video_off.checked_add(geo.video.slot_count.checked_mul(geo.video.slot_size)?)?;
        let audio_end = geo.audio_off.checked_add(geo.audio.chunk_count.checked_mul(chunk_size)?)?;
        let total = video_end.max(audio_end).max(st::HEADER_BLOCK_SIZE as u32) as usize;
        let mut buf = vec![0u8; total];
        buf[..st::HEADER_BLOCK_SIZE].copy_from_slice(&header_block[..st::HEADER_BLOCK_SIZE]);
        Some(Self { buf, geo })
    }

    /// The `.pkst` file image — hand it to the stream.rs readers.
    pub fn buf(&self) -> &[u8] {
        &self.buf
    }

    pub fn geometry(&self) -> &StreamHeaders {
        &self.geo
    }

    fn wr_u32(&mut self, off: usize, v: u32) {
        self.buf[off..off + 4].copy_from_slice(&v.to_le_bytes());
    }

    fn wr_u16(&mut self, off: usize, v: u16) {
        self.buf[off..off + 2].copy_from_slice(&v.to_le_bytes());
    }

    /// Apply a WIRE videoSlot: write the slot payload, THEN publish the
    /// ring's latestSeq. Rejects geometry that disagrees with the open
    /// header, palettes that are not 1024 bytes, and indices that are not
    /// (or do not RLE-decode to) exactly w*h.
    pub fn apply_slot(&mut self, msg: &crate::wire::VideoSlotMsg) -> bool {
        let v = self.geo.video;
        if msg.w != v.w || msg.h != v.h || msg.palette.len() != 1024 {
            return false;
        }
        let pixels = (v.w * v.h) as usize;
        let Some(off) = stream::slot_offset(&self.geo, msg.seq) else {
            return false;
        };
        let off = off as usize;
        let indices_at = off + st::SLOT_HEADER_SIZE + 1024;
        if indices_at + pixels > self.buf.len() {
            return false;
        }
        if msg.rle {
            if !codec::packbits_decode(msg.indices, &mut self.buf[indices_at..indices_at + pixels]) {
                return false;
            }
        } else {
            if msg.indices.len() != pixels {
                return false;
            }
            self.buf[indices_at..indices_at + pixels].copy_from_slice(msg.indices);
        }
        self.buf[off + st::SLOT_HEADER_SIZE..indices_at].copy_from_slice(msg.palette);
        // Slot header: seq · frameIndex · w · h · reserved(20B zeros).
        self.wr_u32(off, msg.seq);
        self.wr_u32(off + 4, msg.frame_index);
        self.wr_u16(off + 8, msg.w as u16);
        self.wr_u16(off + 10, msg.h as u16);
        for b in &mut self.buf[off + 12..off + st::SLOT_HEADER_SIZE] {
            *b = 0;
        }
        // Payload is in place — NOW publish the cursor.
        self.wr_u32(st::VRING_OFF + 20, msg.seq.max(self.latest_video_seq()));
        true
    }

    /// Apply a WIRE audioChunk: payload first, latestSeq after.
    pub fn apply_chunk(&mut self, msg: &crate::wire::AudioChunkMsg) -> bool {
        let a = self.geo.audio;
        let bytes = (a.chunk_frames * a.channels * 2) as usize;
        if msg.pcm.len() != bytes {
            return false;
        }
        let Some(off) = stream::chunk_offset(&self.geo, msg.seq) else {
            return false;
        };
        let off = off as usize;
        let pcm_at = off + st::CHUNK_HEADER_SIZE;
        if pcm_at + bytes > self.buf.len() {
            return false;
        }
        self.buf[pcm_at..pcm_at + bytes].copy_from_slice(msg.pcm);
        self.wr_u32(off, msg.seq);
        self.wr_u32(off + 4, msg.start_frame);
        for b in &mut self.buf[off + 8..off + st::CHUNK_HEADER_SIZE] {
            *b = 0;
        }
        self.wr_u32(st::ARING_OFF + 20, msg.seq.max(self.latest_audio_seq()));
        true
    }

    /// Apply a WIRE streamMark: epoch bump and/or the ended flag — the same
    /// header fields the file writer's bumpEpoch()/markEnded() mutate.
    pub fn apply_mark(&mut self, msg: &crate::wire::StreamMarkMsg) {
        self.wr_u32(8, msg.epoch);
        let mut flags = u16::from_le_bytes([self.buf[6], self.buf[7]]);
        if msg.ended {
            flags |= st::FLAG_ENDED;
        }
        self.wr_u16(6, flags);
    }

    fn latest_video_seq(&self) -> u32 {
        u32::from_le_bytes([
            self.buf[st::VRING_OFF + 20],
            self.buf[st::VRING_OFF + 21],
            self.buf[st::VRING_OFF + 22],
            self.buf[st::VRING_OFF + 23],
        ])
    }

    fn latest_audio_seq(&self) -> u32 {
        u32::from_le_bytes([
            self.buf[st::ARING_OFF + 20],
            self.buf[st::ARING_OFF + 21],
            self.buf[st::ARING_OFF + 22],
            self.buf[st::ARING_OFF + 23],
        ])
    }

    const _ASSERT_MSG_SIZES: () = {
        assert!(wire::SLOT_HEADER_SIZE == 16);
        assert!(wire::CHUNK_HEADER_SIZE == 8);
    };
}
