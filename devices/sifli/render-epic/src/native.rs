//! The `.epic` native texture table baked by `tools/build/sifli/epic.ts`.
//!
//! Little-endian. A 16-byte header (magic `EPIC`, version 1, entry count,
//! total length, reserved) precedes 32-byte entries sorted by source digest:
//! u64 source, u32 payload offset (a multiple of 64), u32 payload length,
//! u16 width, u16 height, u8 [`NativeFormat`], u8 IMG flags, 10 reserved
//! bytes. An L8 payload starts with its 1024-byte BGRA palette.
//!
//! The source digest is FNV-1a 64 over the portable texture as the core
//! holds it: width and height as u16, the PSM code as u8, the PSM_T8
//! palette, then the decoded pixels. Package textures carry no names on this
//! side of the runtime, so the digest is what pairs a native copy with the
//! texture it replaces.

use pocket_drivers::TexView;
use pocket_spec as spec;

use crate::executor::NativeFormat;

pub const MAGIC: u32 = u32::from_le_bytes(*b"EPIC");
pub const VERSION: u16 = 1;
const HEADER_BYTES: usize = 16;
const ENTRY_BYTES: usize = 32;
const PAYLOAD_ALIGN: usize = 64;
const PALETTE_BYTES: usize = 1024;

/// One native copy from the table.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NativeTexture<'a> {
    pub format: NativeFormat,
    pub width: u32,
    pub height: u32,
    pub flags: u8,
    pub pixels: &'a [u8],
    pub palette: Option<&'a [u8]>,
}

/// A validated table. Construction checks every entry, so lookups only
/// slice.
#[derive(Clone, Copy, Debug)]
pub struct NativeTable<'a> {
    bytes: &'a [u8],
    count: usize,
}

impl<'a> NativeTable<'a> {
    /// `None` for a malformed table, or a table whose storage is not 64-byte
    /// aligned.
    pub fn parse(bytes: &'a [u8]) -> Option<Self> {
        if bytes.len() < HEADER_BYTES
            || !(bytes.as_ptr() as usize).is_multiple_of(PAYLOAD_ALIGN)
            || u32_at(bytes, 0) != MAGIC
            || u16_at(bytes, 4) != VERSION
            || u32_at(bytes, 8) as usize != bytes.len()
        {
            return None;
        }
        let count = u16_at(bytes, 6) as usize;
        let entries_end = HEADER_BYTES.checked_add(count.checked_mul(ENTRY_BYTES)?)?;
        if entries_end > bytes.len() {
            return None;
        }
        let table = Self { bytes, count };
        let mut previous = None;
        for index in 0..count {
            let source = table.source(index);
            if previous.is_some_and(|previous| previous >= source) {
                return None;
            }
            previous = Some(source);
            table.entry(index)?;
        }
        Some(table)
    }

    pub fn len(&self) -> usize {
        self.count
    }

    pub fn is_empty(&self) -> bool {
        self.count == 0
    }

    /// The native copy of the texture whose source digest is `source`.
    pub fn find(&self, source: u64) -> Option<NativeTexture<'a>> {
        let (mut low, mut high) = (0, self.count);
        while low < high {
            let middle = (low + high) / 2;
            match self.source(middle).cmp(&source) {
                core::cmp::Ordering::Less => low = middle + 1,
                core::cmp::Ordering::Greater => high = middle,
                core::cmp::Ordering::Equal => return self.entry(middle),
            }
        }
        None
    }

    fn source(&self, index: usize) -> u64 {
        u64_at(self.bytes, HEADER_BYTES + index * ENTRY_BYTES)
    }

    fn entry(&self, index: usize) -> Option<NativeTexture<'a>> {
        let at = HEADER_BYTES + index * ENTRY_BYTES;
        let offset = u32_at(self.bytes, at + 8) as usize;
        let length = u32_at(self.bytes, at + 12) as usize;
        let width = u16_at(self.bytes, at + 16) as u32;
        let height = u16_at(self.bytes, at + 18) as u32;
        let format = match self.bytes[at + 20] {
            0 => NativeFormat::Rgb565,
            1 => NativeFormat::Bgra8888,
            2 => NativeFormat::L8,
            _ => return None,
        };
        let payload = self.bytes.get(offset..offset.checked_add(length)?)?;
        let texels = (width as usize).checked_mul(height as usize)?;
        if width == 0 || height == 0 || !offset.is_multiple_of(PAYLOAD_ALIGN) {
            return None;
        }
        let (palette, pixels) = match format {
            NativeFormat::Rgb565 => (None, payload),
            NativeFormat::Bgra8888 => (None, payload),
            NativeFormat::L8 => {
                let (palette, pixels) = payload.split_at_checked(PALETTE_BYTES)?;
                (Some(palette), pixels)
            }
        };
        let bytes_per_texel = match format {
            NativeFormat::Rgb565 => 2,
            NativeFormat::Bgra8888 => 4,
            NativeFormat::L8 => 1,
        };
        if pixels.len() != texels.checked_mul(bytes_per_texel)? {
            return None;
        }
        Some(NativeTexture {
            format,
            width,
            height,
            flags: self.bytes[at + 21],
            pixels,
            palette,
        })
    }
}

/// FNV-1a 64 of a portable texture, as the baker computes it. `None` for a
/// layout the baker does not convert.
pub fn source_digest(view: &TexView<'_>) -> Option<u64> {
    let bytes_per_texel = match view.psm {
        spec::psm::PSM_5650 | spec::psm::PSM_4444 => 2,
        spec::psm::PSM_8888 => 4,
        spec::psm::PSM_T8 => 1,
        _ => return None,
    };
    let length = (view.w as usize)
        .checked_mul(view.h as usize)?
        .checked_mul(bytes_per_texel)?;
    let mut hash = Fnv::new();
    hash.write(&(view.w as u16).to_le_bytes());
    hash.write(&(view.h as u16).to_le_bytes());
    hash.write(&[view.psm as u8]);
    if view.psm == spec::psm::PSM_T8 {
        hash.write(view.palette?.get(..PALETTE_BYTES)?);
    }
    hash.write(view.pixels.get(..length)?);
    Some(hash.finish())
}

struct Fnv(u64);

impl Fnv {
    const fn new() -> Self {
        Self(0xcbf2_9ce4_8422_2325)
    }
    fn write(&mut self, bytes: &[u8]) {
        for &byte in bytes {
            self.0 = (self.0 ^ byte as u64).wrapping_mul(0x0100_0000_01b3);
        }
    }
    const fn finish(&self) -> u64 {
        self.0
    }
}

fn u16_at(bytes: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([bytes[at], bytes[at + 1]])
}

fn u32_at(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap())
}

fn u64_at(bytes: &[u8], at: usize) -> u64 {
    u64::from_le_bytes(bytes[at..at + 8].try_into().unwrap())
}
