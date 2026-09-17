//! Read-only .pak walker: feeds the embedded asset pack (APP_PAK,
//! include_bytes! over .rodata) STRAIGHT to the Rust core BEFORE any JS runs
//! — zero QuickJS-heap transit [R].
//!
//! Container format: spec.ts "PAK container constants" (generated into
//! core spec::pak; byte-compatible with dreamcart .pak). Entry keys
//! written by framework/compiler/pak.ts:
//!   ui:styles        -> Ui::load_styles (styles.bin)
//!   ui:font.<slot>   -> Ui::load_font_atlas (slot is in the blob header)
//!   ui:img.<name>    -> decode the 8-byte IMG header {u16 w, u16 h, u8 psm,
//!                       3B pad} + raw pixels -> Ui::upload_texture; the
//!                       (name, handle) pairs are returned so ffi.rs can
//!                       expose them to JS as ui.__textures (renderer
//!                       registerTexture keys are the bare `src` names).
//!   ui:tile.<name>   -> NOT fed (skipped as unknown): deep-zoom tilesets
//!                       stream one tile at a time through the JS
//!                       loadTileTexture op, which resolves the entry via
//!                       `find` on the `install`ed pak.
//!
//! Malformed packs/entries are skipped, never fatal (an EBOOT with a bad
//! pack still boots to the JS error screen instead of crashing).

use alloc::string::String;
use alloc::vec::Vec;

use pocketjs_core::{spec, Ui};

/// The embedded pak, installed by main.rs before ffi::register so the JS
/// streaming ops (loadTileTexture) can pull blobs straight from .rodata at
/// runtime. One instance, one JS thread — the same main-thread `static mut`
/// contract as ffi::UI.
static mut PAK: &[u8] = &[];

/// Publish the embedded pak for runtime lookups (call once, before
/// ffi::register).
///
/// # Safety
/// Single-threaded main-thread contract (ffi::UI's): no concurrent
/// `install`/`installed` calls exist.
pub unsafe fn install(pak: &'static [u8]) {
    PAK = pak;
    crate::offload_local::install_pak(pak);
}

/// The installed pak (empty slice until `install` runs — every `find` on it
/// just misses).
///
/// # Safety
/// Same single-threaded contract as `install`.
pub unsafe fn installed() -> &'static [u8] {
    PAK
}

#[inline]
fn rd_u16(b: &[u8], off: usize) -> Option<u16> {
    Some(u16::from_le_bytes([*b.get(off)?, *b.get(off + 1)?]))
}

#[inline]
fn rd_u32(b: &[u8], off: usize) -> Option<u32> {
    Some(u32::from_le_bytes([
        *b.get(off)?,
        *b.get(off + 1)?,
        *b.get(off + 2)?,
        *b.get(off + 3)?,
    ]))
}

/// Walk `pak` and feed every recognized entry to `ui`. Returns the image
/// name -> texture-handle table for ffi.rs.
/// One animated sprite atlas registered from the pak (exposed to JS as
/// `ui.__sprites[name] = { handle, frames, cols, step }`, the sprite analog of
/// `ui.__textures`).
pub struct SpriteReg {
    pub name: String,
    pub handle: i32,
    pub frames: u16,
    pub cols: u16,
    pub step: u16,
}

pub fn feed(ui: &mut Ui, pak: &[u8]) -> (Vec<(String, i32)>, Vec<SpriteReg>) {
    let mut textures: Vec<(String, i32)> = Vec::new();
    let mut sprites: Vec<SpriteReg> = Vec::new();
    let Some(()) = (|| {
        if rd_u32(pak, 0)? != spec::pak::MAGIC || rd_u16(pak, 4)? != spec::pak::VERSION {
            return None;
        }
        Some(())
    })() else {
        return (textures, sprites);
    };
    let (Some(count), Some(dir_off), Some(names_off)) =
        (rd_u32(pak, 8), rd_u32(pak, 12), rd_u32(pak, 16))
    else {
        return (textures, sprites);
    };
    // Clamp the walk to what the pack can actually hold: a corrupt count word
    // must not stall boot for ~4.3e9 iterations (or overflow `i * ENTRY_SIZE`
    // on 32-bit) — "malformed packs are skipped, never fatal".
    let count = (count as usize)
        .min(pak.len().saturating_sub(dir_off as usize) / spec::pak::ENTRY_SIZE);
    for i in 0..count {
        let e = dir_off as usize + i * spec::pak::ENTRY_SIZE;
        let (Some(blob_off), Some(blob_len), Some(name_off), Some(name_len)) =
            (rd_u32(pak, e + 4), rd_u32(pak, e + 8), rd_u32(pak, e + 12), rd_u16(pak, e + 16))
        else {
            continue;
        };
        let ns = names_off as usize + name_off as usize;
        let (Some(name_bytes), Some(blob)) = (
            pak.get(ns..ns + name_len as usize),
            pak.get(blob_off as usize..blob_off as usize + blob_len as usize),
        ) else {
            continue;
        };
        let Ok(key) = core::str::from_utf8(name_bytes) else { continue };
        if key == "ui:styles" {
            if !ui.load_styles(blob) {
                psp::dprintln!("[PocketJS pak] bad styles.bin");
            }
        } else if key.starts_with("ui:font.") {
            if !ui.load_font_atlas(blob) {
                psp::dprintln!("[PocketJS pak] bad font atlas {}", key);
            }
        } else if let Some(name) = key.strip_prefix("ui:img.") {
            // IMG entry: 8-byte header {u16 w, u16 h, u8 psm, 3B pad} + pixels
            // (framework/compiler/pak.ts encodeImageEntry).
            let (Some(w), Some(h), Some(&psm)) = (rd_u16(blob, 0), rd_u16(blob, 2), blob.get(4))
            else {
                continue;
            };
            let Some(pixels) = blob.get(8..) else { continue };
            let handle = ui.upload_texture(pixels, w as u32, h as u32, psm as u32);
            if handle >= 0 {
                // The core copied the pixels into 16-byte-aligned storage; the
                // GE samples RAM, not the dcache — write back ONCE at upload.
                crate::ge::writeback_texture(ui, handle);
                textures.push((String::from(name), handle));
            } else {
                psp::dprintln!("[PocketJS pak] bad image {} ({}x{} psm {})", key, w, h, psm);
            }
        } else if let Some(name) = key.strip_prefix("ui:sprite.") {
            // SPRITE entry: 16-byte header {u16 atlasW, u16 atlasH, u8 psm, u8
            // pad, u16 frameCount, u16 cols, u16 frameStep, 4B pad} + atlas
            // pixels (framework/compiler/pak.ts encodeSpriteEntry). The atlas uploads as a
            // normal texture; the core auto-plays the frame cells.
            let (Some(w), Some(h), Some(&psm), Some(frames), Some(cols), Some(step)) = (
                rd_u16(blob, 0),
                rd_u16(blob, 2),
                blob.get(4),
                rd_u16(blob, 6),
                rd_u16(blob, 8),
                rd_u16(blob, 10),
            ) else {
                continue;
            };
            let Some(pixels) = blob.get(16..) else { continue };
            let handle = ui.upload_texture(pixels, w as u32, h as u32, psm as u32);
            if handle >= 0 {
                crate::ge::writeback_texture(ui, handle);
                sprites.push(SpriteReg { name: String::from(name), handle, frames, cols, step });
            } else {
                psp::dprintln!("[PocketJS pak] bad sprite {} ({}x{} psm {})", key, w, h, psm);
            }
        }
        // unknown keys: ignored (forward compatible)
    }
    (textures, sprites)
}

/// Look up one entry's blob by exact key (the runtime side of the streaming
/// ops — e.g. loadTileTexture's `ui:tile.<name>` keys, which `feed` skips as
/// unknown). Same bounds-checked walk as `feed`: malformed packs and misses
/// return None, never panic. O(entries) per call — callers cache the handle,
/// not the lookup.
pub fn find<'a>(pak: &'a [u8], key: &str) -> Option<&'a [u8]> {
    if rd_u32(pak, 0)? != spec::pak::MAGIC || rd_u16(pak, 4)? != spec::pak::VERSION {
        return None;
    }
    let (count, dir_off, names_off) = (rd_u32(pak, 8)?, rd_u32(pak, 12)?, rd_u32(pak, 16)?);
    // Same corrupt-count clamp as `feed`.
    let count = (count as usize)
        .min(pak.len().saturating_sub(dir_off as usize) / spec::pak::ENTRY_SIZE);
    for i in 0..count {
        let e = dir_off as usize + i * spec::pak::ENTRY_SIZE;
        let (Some(blob_off), Some(blob_len), Some(name_off), Some(name_len)) =
            (rd_u32(pak, e + 4), rd_u32(pak, e + 8), rd_u32(pak, e + 12), rd_u16(pak, e + 16))
        else {
            continue;
        };
        let ns = names_off as usize + name_off as usize;
        let Some(name_bytes) = pak.get(ns..ns + name_len as usize) else { continue };
        if name_bytes == key.as_bytes() {
            return pak.get(blob_off as usize..blob_off as usize + blob_len as usize);
        }
    }
    None
}
