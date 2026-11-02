//! Media container readers, transport messages, and byte codecs.
//!
//! The caller owns file and socket I/O. This crate interprets borrowed bytes
//! and assembles an in-memory stream using the same container layout.

#![no_std]

extern crate alloc;

pub mod codec;
pub mod stream;
pub mod stream_rx;
pub mod wire;

use pocket_spec as spec;

#[inline]
fn rd_u16(bytes: &[u8], offset: usize) -> Option<u16> {
    let value = bytes.get(offset..offset.checked_add(2)?)?;
    Some(u16::from_le_bytes([value[0], value[1]]))
}

#[inline]
fn rd_u32(bytes: &[u8], offset: usize) -> Option<u32> {
    let value = bytes.get(offset..offset.checked_add(4)?)?;
    Some(u32::from_le_bytes([value[0], value[1], value[2], value[3]]))
}

#[cfg(test)]
mod tests;
