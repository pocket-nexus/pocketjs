//! Decode the closed DrawList operation set without copying its words.
//!
//! Scissor records contain absolute logical coordinates, already intersected
//! with ancestor clips by the producer. Each operation carries the current
//! clip intersected with the caller's viewport. The decoder and producer use
//! the same DrawList version; unknown operations cannot be skipped because
//! operation headers do not carry a length.

#![no_std]

use pocket_drivers::DamageRect;
use pocket_spec::draw_op;

pub use pocket_spec::DRAW_LIST_VERSION;
pub const MAX_CLIP_DEPTH: usize = 32;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DecodeError {
    UnknownOperation,
    Truncated,
    ClipOverflow,
    ClipUnderflow,
    UnbalancedClip,
}

/// A borrowed record from the original DrawList, including its opcode word.
/// Coordinates in `clip` are logical pixels; the consumer applies its scale.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Operation<'a> {
    pub opcode: u32,
    pub words: &'a [u32],
    pub clip: DamageRect,
}

/// Number of words in the complete operation at `at`.
pub fn word_len(words: &[u32], at: usize) -> Result<usize, DecodeError> {
    let words = words.get(at..).ok_or(DecodeError::Truncated)?;
    let opcode = *words.first().ok_or(DecodeError::Truncated)?;
    let len = match opcode {
        draw_op::RECT => 4,
        draw_op::GRAD_RECT => 6,
        draw_op::GLYPH_RUN => {
            let count = (words.get(1).ok_or(DecodeError::Truncated)? >> 16) as usize;
            3 + count * 2
        }
        draw_op::TEX_QUAD | draw_op::SURFACE_QUAD => 9,
        draw_op::SCISSOR => 3,
        draw_op::SCISSOR_POP => 1,
        draw_op::TRI => 7,
        draw_op::TEX_TRI => 12,
        draw_op::TEXT_RUN => {
            let bytes = *words.get(7).ok_or(DecodeError::Truncated)? as usize;
            8usize
                .checked_add(bytes.div_ceil(4))
                .ok_or(DecodeError::Truncated)?
        }
        _ => return Err(DecodeError::UnknownOperation),
    };
    if len > words.len() {
        Err(DecodeError::Truncated)
    } else {
        Ok(len)
    }
}

/// Signed XY and unsigned width/height packed into two DrawList words.
pub fn logical_rect(xy: u32, wh: u32) -> DamageRect {
    let x = xy as u16 as i16 as i32;
    let y = (xy >> 16) as u16 as i16 as i32;
    DamageRect::new(x, y, x + (wh & 0xffff) as i32, y + (wh >> 16) as i32)
}

/// Allocation-free iterator. An error is yielded once and ends iteration.
/// Reaching the end with an outstanding scissor yields `UnbalancedClip`.
pub struct DrawOps<'a> {
    words: &'a [u32],
    at: usize,
    viewport: DamageRect,
    clip: DamageRect,
    stack: [DamageRect; MAX_CLIP_DEPTH],
    depth: usize,
    finished: bool,
}

impl<'a> DrawOps<'a> {
    pub fn new(words: &'a [u32], viewport: DamageRect) -> Self {
        Self {
            words,
            at: 0,
            viewport,
            clip: viewport,
            stack: [viewport; MAX_CLIP_DEPTH],
            depth: 0,
            finished: false,
        }
    }

    /// The offset of the next record, or the record which failed to decode.
    pub fn position(&self) -> usize {
        self.at
    }

    fn decode(&mut self) -> Result<Operation<'a>, DecodeError> {
        let len = word_len(self.words, self.at)?;
        let words = &self.words[self.at..self.at + len];
        let opcode = words[0];
        match opcode {
            draw_op::SCISSOR => {
                if self.depth == MAX_CLIP_DEPTH {
                    return Err(DecodeError::ClipOverflow);
                }
                self.stack[self.depth] = self.clip;
                self.depth += 1;
                self.clip = self.viewport.intersect(logical_rect(words[1], words[2]));
            }
            draw_op::SCISSOR_POP => {
                if self.depth == 0 {
                    return Err(DecodeError::ClipUnderflow);
                }
                self.depth -= 1;
                self.clip = self.stack[self.depth];
            }
            _ => {}
        }
        self.at += len;
        Ok(Operation {
            opcode,
            words,
            clip: self.clip,
        })
    }
}

impl<'a> Iterator for DrawOps<'a> {
    type Item = Result<Operation<'a>, DecodeError>;

    fn next(&mut self) -> Option<Self::Item> {
        if self.finished {
            return None;
        }
        if self.at == self.words.len() {
            self.finished = true;
            return if self.depth == 0 {
                None
            } else {
                Some(Err(DecodeError::UnbalancedClip))
            };
        }
        let result = self.decode();
        if result.is_err() {
            self.finished = true;
        }
        Some(result)
    }
}

impl core::iter::FusedIterator for DrawOps<'_> {}

pub fn validate(words: &[u32], viewport: DamageRect) -> Result<(), DecodeError> {
    for operation in DrawOps::new(words, viewport) {
        operation?;
    }
    Ok(())
}
