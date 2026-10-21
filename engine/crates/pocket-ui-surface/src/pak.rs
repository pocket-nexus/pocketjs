//! Read-only .pak walker — desktop port of `programs/psp/src/pak.rs` (container
//! format pinned in spec.ts "PAK container constants", generated into
//! `pocketjs_core::spec::pak`). Malformed packs/entries are skipped, never
//! fatal, matching the PSP walker's contract.

pub use pocketjs_core::pak::PakEntry;

/// The blob for `key`, or None for absent keys (same tolerance for
/// malformed packs as the walk).
pub fn find_pak<'a>(pak: &'a [u8], key: &str) -> Option<&'a [u8]> {
    pocketjs_core::pak::find(pak, key)
}

/// Iterate every well-formed entry in `pak`.
pub fn walk_pak(pak: &[u8]) -> Vec<PakEntry<'_>> {
    pocketjs_core::pak::entries(pak).collect()
}
