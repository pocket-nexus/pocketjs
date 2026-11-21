//! A game's packs as pieces.
//!
//! A pack is one file a game's program reads sections of. A game with several
//! packs (a map each, a place each) cuts them into **pieces named by their
//! own bytes** and lists them in one manifest. A piece two packs share is
//! stored once and sent once, and a pack that is cooked again changes only
//! the pieces whose bytes changed. Every device reads the same manifest: a
//! browser tab fetches pieces, a handheld opens them as files beside its
//! program.
//!
//! ```text
//! pocket-pack-pieces/2
//! pack street 30515456 5771…(64 hex digits: the SHA-256 of the whole pack)
//! 0f3a9c0d2b7e4a6f8c1d 1088
//! 77c1e2a4b5d6f7081920 2097152
//! pack yards 32338112 91ab…
//! 0f3a9c0d2b7e4a6f8c1d 1088
//! c4d5e6f708192a3b4c5d 1876432
//! ```
//!
//! The first line names the format. A `pack` line starts a pack: its name
//! (lowercase letters, digits and hyphens), its size in bytes and the
//! SHA-256 of its bytes. Each line after it is one piece, in order: the
//! first 20 hexadecimal digits of the SHA-256 of the piece's bytes, and its
//! size. The pieces of a pack, one after another, are the pack. A piece's
//! file is `<digits>.bin`, beside the manifest.
//!
//! [`Manifest`] parses the text, [`Pack::parts`] says which pieces a range of
//! a pack lies in, and [`Reader`] reads a range through a [`Store`], which is
//! the one thing a device supplies: the bytes of a named piece. The crate is
//! `no_std` with `alloc`.
//!
//! Where a pack is cut is the tool's business (`tools/pocket3d-packs.ts`): at
//! the pack's section boundaries, and inside a long section where its
//! content says so. A reader needs none of that.

#![cfg_attr(not(feature = "std"), no_std)]

extern crate alloc;

use alloc::string::String;
use alloc::vec::Vec;
use core::fmt;
use core::ops::Range;

/// The first line of a manifest.
pub const FORMAT: &str = "pocket-pack-pieces/2";
/// Hexadecimal digits in a piece's name.
pub const NAME_DIGITS: usize = 20;
/// The longest name of a pack.
pub const PACK_NAME_BYTES: usize = 24;

/// One piece of a pack: its name and its size.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Piece {
    /// The first digits of the SHA-256 of its bytes, as lowercase hexadecimal text.
    pub name: [u8; NAME_DIGITS],
    pub bytes: u32,
}

impl Piece {
    /// The piece's name as text.
    pub fn name(&self) -> &str {
        // (parse admits hexadecimal digits alone)
        core::str::from_utf8(&self.name).unwrap_or("")
    }

    /// The piece's file beside the manifest: `<name>.bin`, with a zero byte after it for a host in C.
    pub fn file(&self) -> [u8; NAME_DIGITS + 5] {
        let mut out = [0u8; NAME_DIGITS + 5];
        out[..NAME_DIGITS].copy_from_slice(&self.name);
        out[NAME_DIGITS..NAME_DIGITS + 4].copy_from_slice(b".bin");
        out
    }
}

/// One pack of a manifest.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Pack {
    pub name: String,
    /// The pack's size: the sum of its pieces'.
    pub bytes: u64,
    /// The SHA-256 of the whole pack, as lowercase hexadecimal text.
    pub sha256: [u8; 64],
    pub pieces: Vec<Piece>,
    /// Where each piece starts in the pack.
    starts: Vec<u64>,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Manifest {
    pub packs: Vec<Pack>,
}

/// Why a manifest was refused, or a read.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Error {
    /// The text's first line is not [`FORMAT`].
    Format,
    /// A line that is neither a pack nor a piece, by its number from 1.
    Line(u32),
    /// A piece before the first pack, by its line.
    NoPack(u32),
    /// A pack whose pieces do not add up to its size, by its name.
    Size(String),
    /// Two packs of one name.
    Twice(String),
    /// A read past the end of a pack.
    Range { offset: u64, bytes: u64, pack: u64 },
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Format => write!(f, "the manifest is not a \"{FORMAT}\""),
            Error::Line(n) => write!(f, "line {n} of the manifest is neither a pack nor a piece"),
            Error::NoPack(n) => write!(f, "line {n} of the manifest is a piece of no pack"),
            Error::Size(name) => write!(f, "the pieces of the pack \"{name}\" do not make up its size"),
            Error::Twice(name) => write!(f, "the manifest names the pack \"{name}\" twice"),
            Error::Range { offset, bytes, pack } => write!(f, "a read of {bytes} bytes at {offset} runs past the pack's {pack}"),
        }
    }
}

#[cfg(feature = "std")]
impl std::error::Error for Error {}

fn hex(text: &str) -> bool {
    text.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn pack_name(text: &str) -> bool {
    !text.is_empty() && text.len() <= PACK_NAME_BYTES && text.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

impl Manifest {
    pub fn parse(text: &str) -> Result<Manifest, Error> {
        let mut lines = text.lines().map(str::trim_end);
        if lines.next() != Some(FORMAT) {
            return Err(Error::Format);
        }
        let mut packs: Vec<Pack> = Vec::new();
        for (index, line) in lines.enumerate() {
            let number = index as u32 + 2;
            if line.is_empty() {
                continue;
            }
            let mut words = line.split(' ');
            let first = words.next().unwrap_or("");
            if first == "pack" {
                let (Some(name), Some(bytes), Some(sha), None) = (words.next(), words.next(), words.next(), words.next()) else {
                    return Err(Error::Line(number));
                };
                let Ok(bytes) = bytes.parse::<u64>() else { return Err(Error::Line(number)) };
                if !pack_name(name) || sha.len() != 64 || !hex(sha) {
                    return Err(Error::Line(number));
                }
                if packs.iter().any(|p| p.name == name) {
                    return Err(Error::Twice(name.into()));
                }
                let mut sha256 = [0u8; 64];
                sha256.copy_from_slice(sha.as_bytes());
                packs.push(Pack { name: name.into(), bytes, sha256, pieces: Vec::new(), starts: Vec::new() });
            } else {
                let (Some(bytes), None) = (words.next(), words.next()) else { return Err(Error::Line(number)) };
                let Ok(bytes) = bytes.parse::<u32>() else { return Err(Error::Line(number)) };
                if first.len() != NAME_DIGITS || !hex(first) || bytes == 0 {
                    return Err(Error::Line(number));
                }
                let Some(pack) = packs.last_mut() else { return Err(Error::NoPack(number)) };
                let mut name = [0u8; NAME_DIGITS];
                name.copy_from_slice(first.as_bytes());
                pack.starts.push(pack.pieces.iter().map(|p| p.bytes as u64).sum());
                pack.pieces.push(Piece { name, bytes });
            }
        }
        for pack in &packs {
            if pack.pieces.iter().map(|p| p.bytes as u64).sum::<u64>() != pack.bytes {
                return Err(Error::Size(pack.name.clone()));
            }
        }
        Ok(Manifest { packs })
    }

    pub fn pack(&self, name: &str) -> Option<&Pack> {
        self.packs.iter().find(|p| p.name == name)
    }

    /// Every piece the manifest names, each once, in the order they first appear.
    pub fn pieces(&self) -> Vec<Piece> {
        let mut out: Vec<Piece> = Vec::new();
        for piece in self.packs.iter().flat_map(|p| &p.pieces) {
            if !out.iter().any(|o| o.name == piece.name) {
                out.push(*piece);
            }
        }
        out
    }
}

/// The packs a manifest's text names, with their sizes, in its order. It allocates nothing: for a
/// thread that has no allocator yet, or may not use one. A text `Manifest::parse` refuses can still
/// name packs here.
pub fn names(text: &str) -> impl Iterator<Item = (&str, u64)> {
    text.lines().filter_map(|line| {
        let mut words = line.trim_end().strip_prefix("pack ")?.split(' ');
        let name = words.next()?;
        Some((name, words.next()?.parse().ok()?))
    })
}

impl Pack {
    /// Where piece `index` starts in the pack.
    pub fn start(&self, index: usize) -> u64 {
        self.starts[index]
    }

    /// The parts of the pieces a range lies in: each piece's index and the bytes of it the range takes.
    pub fn parts(&self, offset: u64, bytes: u64) -> Result<Vec<(usize, Range<u32>)>, Error> {
        match offset.checked_add(bytes) {
            Some(end) if end <= self.bytes => {}
            _ => return Err(Error::Range { offset, bytes, pack: self.bytes }),
        }
        let mut parts = Vec::new();
        if bytes == 0 {
            return Ok(parts);
        }
        // The last piece that starts at or before the offset.
        let mut index = self.starts.partition_point(|&start| start <= offset) - 1;
        let end = offset + bytes;
        let mut at = offset;
        while at < end {
            let start = self.starts[index];
            let to = end.min(start + self.pieces[index].bytes as u64);
            parts.push((index, (at - start) as u32..(to - start) as u32));
            at = to;
            index += 1;
        }
        Ok(parts)
    }
}

/// Where a device keeps pieces: it copies a range of a named piece into `into`.
pub trait Store {
    type Error;
    fn read(&mut self, piece: &Piece, at: u32, into: &mut [u8]) -> Result<(), Self::Error>;
}

/// Why a read through a [`Reader`] failed: the range, or the device's store.
#[derive(Debug)]
pub enum ReadError<E> {
    Pack(Error),
    Store(E),
}

/// Reads ranges of one pack from its pieces.
///
/// A program reads a section by its place in the pack, as it would from the
/// pack's file: `read(offset, into)`. A section too long to hold twice is read
/// a part at a time with the same call. The reader keeps nothing of a piece:
/// what a device holds of the pieces it read last is its store's choice.
pub struct Reader<'a, S: Store> {
    pub pack: &'a Pack,
    pub store: S,
}

impl<'a, S: Store> Reader<'a, S> {
    pub fn new(pack: &'a Pack, store: S) -> Self {
        Reader { pack, store }
    }

    pub fn read(&mut self, offset: u64, into: &mut [u8]) -> Result<(), ReadError<S::Error>> {
        let mut done = 0usize;
        for (index, range) in self.pack.parts(offset, into.len() as u64).map_err(ReadError::Pack)? {
            let n = (range.end - range.start) as usize;
            self.store.read(&self.pack.pieces[index], range.start, &mut into[done..done + n]).map_err(ReadError::Store)?;
            done += n;
        }
        Ok(())
    }
}

#[cfg(feature = "std")]
mod directory {
    use super::*;
    use std::io::{Read, Seek, SeekFrom};
    use std::path::PathBuf;

    /// Pieces as files of a directory, on a machine with a file system of `std`.
    pub struct Directory(pub PathBuf);

    impl Store for Directory {
        type Error = std::io::Error;
        fn read(&mut self, piece: &Piece, at: u32, into: &mut [u8]) -> Result<(), std::io::Error> {
            let mut file = std::fs::File::open(self.0.join(std::format!("{}.bin", piece.name())))?;
            file.seek(SeekFrom::Start(at as u64))?;
            file.read_exact(into)
        }
    }
}
#[cfg(feature = "std")]
pub use directory::Directory;

#[cfg(feature = "cabi")]
pub mod cabi;

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::format;
    use alloc::vec;

    const A: &str = "0f3a9c0d2b7e4a6f8c1d";
    const B: &str = "77c1e2a4b5d6f7081920";
    const C: &str = "c4d5e6f708192a3b4c5d";
    const SHA: &str = "5771000000000000000000000000000000000000000000000000000000000001";

    fn text() -> String {
        format!("{FORMAT}\npack street 10 {SHA}\n{A} 4\n{B} 6\npack yards 9 {SHA}\n{A} 4\n{C} 5\n")
    }

    /// A store whose pieces are their names' first letters repeated, which counts its reads.
    struct Letters(Vec<(String, u32, usize)>);
    impl Store for Letters {
        type Error = ();
        fn read(&mut self, piece: &Piece, at: u32, into: &mut [u8]) -> Result<(), ()> {
            self.0.push((piece.name().into(), at, into.len()));
            for (i, byte) in into.iter_mut().enumerate() {
                *byte = piece.name[0] + (at as usize + i) as u8;
            }
            Ok(())
        }
    }

    #[test]
    fn the_packs_of_a_text_are_named_without_a_parse() {
        let text = "pocket-pack-pieces/2\npack street 5 00\n0123456789abcdef0123 5\npack yards 7 00\n";
        let named: Vec<(&str, u64)> = names(text).collect();
        assert_eq!(named, [("street", 5), ("yards", 7)]);
    }

    #[test]
    fn a_manifest_lists_packs_and_their_pieces_in_order() {
        let m = Manifest::parse(&text()).unwrap();
        assert_eq!(m.packs.iter().map(|p| (p.name.as_str(), p.bytes, p.pieces.len())).collect::<Vec<_>>(), vec![("street", 10, 2), ("yards", 9, 2)]);
        assert_eq!(m.pack("yards").unwrap().pieces[1].name(), C);
        assert_eq!(m.pack("yards").unwrap().start(1), 4);
        // A piece two packs share is one piece.
        assert_eq!(m.pieces().iter().map(|p| p.name()).collect::<Vec<_>>(), vec![A, B, C]);
        assert_eq!(&m.packs[0].pieces[0].file()[..], format!("{A}.bin\0").as_bytes());
    }

    #[test]
    fn a_manifest_that_does_not_add_up_is_refused() {
        assert_eq!(Manifest::parse("pocket-pack-pieces/1\n"), Err(Error::Format));
        assert_eq!(Manifest::parse(&format!("{FORMAT}\n{A} 4\n")), Err(Error::NoPack(2)));
        assert_eq!(Manifest::parse(&format!("{FORMAT}\npack street 11 {SHA}\n{A} 4\n{B} 6\n")), Err(Error::Size("street".into())));
        assert_eq!(Manifest::parse(&format!("{FORMAT}\npack street 4 {SHA}\n{A} 4\npack street 4 {SHA}\n{A} 4\n")), Err(Error::Twice("street".into())));
        for line in [format!("pack Street 4 {SHA}"), "pack street 4 abc".into(), format!("{A} 0"), format!("{} 4", &A[1..]), format!("{A} 4 5"), "piece".into()] {
            assert_eq!(Manifest::parse(&format!("{FORMAT}\npack ok 4 {SHA}\n{A} 4\n{line}\n")), Err(Error::Line(4)), "{line}");
        }
    }

    #[test]
    fn a_range_lies_in_the_pieces_it_crosses() {
        let m = Manifest::parse(&text()).unwrap();
        let street = m.pack("street").unwrap();
        assert_eq!(street.parts(0, 10).unwrap(), vec![(0, 0..4), (1, 0..6)]);
        assert_eq!(street.parts(3, 2).unwrap(), vec![(0, 3..4), (1, 0..1)]);
        assert_eq!(street.parts(4, 6).unwrap(), vec![(1, 0..6)]);
        assert_eq!(street.parts(10, 0).unwrap(), vec![]);
        assert_eq!(street.parts(5, 6), Err(Error::Range { offset: 5, bytes: 6, pack: 10 }));
    }

    #[test]
    fn a_reader_asks_the_store_for_each_part_once() {
        let m = Manifest::parse(&text()).unwrap();
        let mut reader = Reader::new(m.pack("street").unwrap(), Letters(Vec::new()));
        let mut bytes = [0u8; 5];
        reader.read(2, &mut bytes).unwrap();
        assert_eq!(bytes, [b'0' + 2, b'0' + 3, b'7', b'7' + 1, b'7' + 2]);
        assert_eq!(reader.store.0, vec![(A.into(), 2, 2), (B.into(), 0, 3)]);
        assert!(matches!(reader.read(8, &mut bytes), Err(ReadError::Pack(Error::Range { .. }))));
    }
}
