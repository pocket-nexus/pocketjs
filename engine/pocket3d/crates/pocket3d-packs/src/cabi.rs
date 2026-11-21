//! The manifest and the reader for a host written in C (`pocket3d_packs.h`).
//!
//! A game's Rust library that a C host links turns the `cabi` feature on and
//! the functions below are in it. The host supplies one function, which
//! copies a range of a piece's file into memory; everything else is here.

use alloc::boxed::Box;
use core::ffi::{c_char, c_void, CStr};

use super::{Manifest, Piece, Reader, Store, NAME_DIGITS, PACK_NAME_BYTES};

/// Copies `bytes` bytes at `at` of the piece's file (`<digits>.bin`, a C string) into `into`. Returns 0
/// when it did.
pub type PieceRead = unsafe extern "C" fn(user: *mut c_void, file: *const c_char, at: u32, into: *mut u8, bytes: u32) -> i32;

struct Host {
    read: PieceRead,
    user: *mut c_void,
}

impl Store for Host {
    type Error = i32;
    fn read(&mut self, piece: &Piece, at: u32, into: &mut [u8]) -> Result<(), i32> {
        let file = piece.file();
        // SAFETY: the host's own function, with a C string and a buffer of the size it is told.
        match unsafe { (self.read)(self.user, file.as_ptr() as *const c_char, at, into.as_mut_ptr(), into.len() as u32) } {
            0 => Ok(()),
            code => Err(code),
        }
    }
}

/// Parses a manifest's text. Null when the text is refused.
///
/// # Safety
/// `text` points at `bytes` readable bytes.
#[no_mangle]
pub unsafe extern "C" fn p3d_packs_parse(text: *const u8, bytes: u32) -> *mut Manifest {
    let Ok(text) = core::str::from_utf8(core::slice::from_raw_parts(text, bytes as usize)) else { return core::ptr::null_mut() };
    match Manifest::parse(text) {
        Ok(manifest) => Box::into_raw(Box::new(manifest)),
        Err(_) => core::ptr::null_mut(),
    }
}

/// # Safety
/// `manifest` came from [`p3d_packs_parse`] and is not used again.
#[no_mangle]
pub unsafe extern "C" fn p3d_packs_free(manifest: *mut Manifest) {
    if !manifest.is_null() {
        drop(Box::from_raw(manifest));
    }
}

/// # Safety
/// `manifest` came from [`p3d_packs_parse`].
#[no_mangle]
pub unsafe extern "C" fn p3d_packs_count(manifest: *const Manifest) -> u32 {
    (&*manifest).packs.len() as u32
}

/// The index of the pack of that name, or -1.
///
/// # Safety
/// `manifest` came from [`p3d_packs_parse`]; `name` is a C string.
#[no_mangle]
pub unsafe extern "C" fn p3d_packs_find(manifest: *const Manifest, name: *const c_char) -> i32 {
    let Ok(name) = CStr::from_ptr(name).to_str() else { return -1 };
    (&*manifest).packs.iter().position(|p| p.name == name).map_or(-1, |i| i as i32)
}

/// Writes a pack's name as a C string into `into` (`P3D_PACK_NAME_BYTES + 1` bytes) and returns its size
/// in bytes, 0 for no such pack.
///
/// # Safety
/// `manifest` came from [`p3d_packs_parse`]; `into` holds `PACK_NAME_BYTES + 1` bytes.
#[no_mangle]
pub unsafe extern "C" fn p3d_packs_name(manifest: *const Manifest, pack: u32, into: *mut c_char) -> u64 {
    let Some(found) = (&*manifest).packs.get(pack as usize) else { return 0 };
    let name = &found.name.as_bytes()[..found.name.len().min(PACK_NAME_BYTES)];
    core::ptr::copy_nonoverlapping(name.as_ptr(), into as *mut u8, name.len());
    *into.add(name.len()) = 0;
    found.bytes
}

/// How many pieces a pack has.
///
/// # Safety
/// `manifest` came from [`p3d_packs_parse`].
#[no_mangle]
pub unsafe extern "C" fn p3d_packs_pieces(manifest: *const Manifest, pack: u32) -> u32 {
    (&*manifest).packs.get(pack as usize).map_or(0, |p| p.pieces.len() as u32)
}

/// Writes a piece's file name as a C string into `file` (`P3D_PIECE_FILE_BYTES` bytes) and returns the
/// piece's size, 0 for no such piece.
///
/// # Safety
/// `manifest` came from [`p3d_packs_parse`]; `file` holds `NAME_DIGITS + 5` bytes.
#[no_mangle]
pub unsafe extern "C" fn p3d_packs_piece(manifest: *const Manifest, pack: u32, piece: u32, file: *mut c_char) -> u32 {
    let Some(found) = (&*manifest).packs.get(pack as usize).and_then(|p| p.pieces.get(piece as usize)) else { return 0 };
    let name = found.file();
    core::ptr::copy_nonoverlapping(name.as_ptr(), file as *mut u8, NAME_DIGITS + 5);
    found.bytes
}

/// Reads `bytes` bytes at `offset` of a pack into `into`. Returns 0 when it did, 1 for a range outside
/// the pack or no such pack, and otherwise what the host's function returned.
///
/// # Safety
/// `manifest` came from [`p3d_packs_parse`]; `into` holds `bytes` bytes; `read` may be called with `user`.
#[no_mangle]
pub unsafe extern "C" fn p3d_packs_read(manifest: *const Manifest, pack: u32, offset: u64, into: *mut u8, bytes: u32, read: PieceRead, user: *mut c_void) -> i32 {
    let Some(found) = (&*manifest).packs.get(pack as usize) else { return 1 };
    let mut reader = Reader::new(found, Host { read, user });
    match reader.read(offset, core::slice::from_raw_parts_mut(into, bytes as usize)) {
        Ok(()) => 0,
        Err(super::ReadError::Pack(_)) => 1,
        Err(super::ReadError::Store(code)) => code,
    }
}
