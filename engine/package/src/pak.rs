//! Allocation-free reader for the immutable PocketJS asset pack.

use pocket_spec as spec;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PakEntry<'a> {
    pub key: &'a str,
    pub blob: &'a [u8],
}

#[derive(Clone)]
pub struct PakEntries<'a> {
    pak: &'a [u8],
    directory_offset: usize,
    names_offset: usize,
    count: usize,
    index: usize,
}

#[inline]
fn read_u16(bytes: &[u8], offset: usize) -> Option<u16> {
    Some(u16::from_le_bytes([
        *bytes.get(offset)?,
        *bytes.get(offset + 1)?,
    ]))
}

#[inline]
fn read_u32(bytes: &[u8], offset: usize) -> Option<u32> {
    Some(u32::from_le_bytes([
        *bytes.get(offset)?,
        *bytes.get(offset + 1)?,
        *bytes.get(offset + 2)?,
        *bytes.get(offset + 3)?,
    ]))
}

pub fn entries(pak: &[u8]) -> PakEntries<'_> {
    let valid =
        read_u32(pak, 0) == Some(spec::pak::MAGIC) && read_u16(pak, 4) == Some(spec::pak::VERSION);
    let (count, directory_offset, names_offset) = if valid {
        match (read_u32(pak, 8), read_u32(pak, 12), read_u32(pak, 16)) {
            (Some(count), Some(directory), Some(names)) => {
                let directory = directory as usize;
                let count = (count as usize)
                    .min(pak.len().saturating_sub(directory) / spec::pak::ENTRY_SIZE);
                (count, directory, names as usize)
            }
            _ => (0, 0, 0),
        }
    } else {
        (0, 0, 0)
    };
    PakEntries {
        pak,
        directory_offset,
        names_offset,
        count,
        index: 0,
    }
}

pub fn find<'a>(pak: &'a [u8], key: &str) -> Option<&'a [u8]> {
    entries(pak)
        .find(|entry| entry.key == key)
        .map(|entry| entry.blob)
}

impl<'a> Iterator for PakEntries<'a> {
    type Item = PakEntry<'a>;

    fn next(&mut self) -> Option<Self::Item> {
        while self.index < self.count {
            let entry = self.directory_offset + self.index * spec::pak::ENTRY_SIZE;
            self.index += 1;
            let (Some(blob_offset), Some(blob_length), Some(name_offset), Some(name_length)) = (
                read_u32(self.pak, entry + 4),
                read_u32(self.pak, entry + 8),
                read_u32(self.pak, entry + 12),
                read_u16(self.pak, entry + 16),
            ) else {
                continue;
            };
            let Some(name_start) = self.names_offset.checked_add(name_offset as usize) else {
                continue;
            };
            let Some(name_end) = name_start.checked_add(name_length as usize) else {
                continue;
            };
            let blob_start = blob_offset as usize;
            let Some(blob_end) = blob_start.checked_add(blob_length as usize) else {
                continue;
            };
            let (Some(name), Some(blob)) = (
                self.pak.get(name_start..name_end),
                self.pak.get(blob_start..blob_end),
            ) else {
                continue;
            };
            let Ok(key) = core::str::from_utf8(name) else {
                continue;
            };
            return Some(PakEntry { key, blob });
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;

    fn fixture() -> alloc::vec::Vec<u8> {
        let mut pak = vec![0u8; 96];
        pak[0..4].copy_from_slice(&spec::pak::MAGIC.to_le_bytes());
        pak[4..6].copy_from_slice(&spec::pak::VERSION.to_le_bytes());
        pak[8..12].copy_from_slice(&1u32.to_le_bytes());
        pak[12..16].copy_from_slice(&32u32.to_le_bytes());
        pak[16..20].copy_from_slice(&64u32.to_le_bytes());
        pak[32..36].copy_from_slice(&7u32.to_le_bytes());
        pak[36..40].copy_from_slice(&80u32.to_le_bytes());
        pak[40..44].copy_from_slice(&4u32.to_le_bytes());
        pak[44..48].copy_from_slice(&0u32.to_le_bytes());
        pak[48..50].copy_from_slice(&3u16.to_le_bytes());
        pak[64..67].copy_from_slice(b"map");
        pak[80..84].copy_from_slice(b"P3D!");
        pak
    }

    #[test]
    fn finds_a_borrowed_blob_without_allocating() {
        let pak = fixture();
        assert_eq!(find(&pak, "map"), Some(&b"P3D!"[..]));
        assert_eq!(find(&pak, "missing"), None);
    }

    #[test]
    fn malformed_ranges_are_skipped() {
        let mut pak = fixture();
        pak[40..44].copy_from_slice(&u32::MAX.to_le_bytes());
        assert_eq!(entries(&pak).count(), 0);
    }
}
