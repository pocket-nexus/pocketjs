//! Platform-neutral `.pak` feeder: styles.bin, font atlases, images and
//! sprite atlases straight into the core before the app mounts. The same
//! walk as hosts/psp/src/pak.rs; `after_upload` lets a host write a texture
//! back to memory the GPU samples (the PSP GE reads RAM, not the dcache).
//!
//! Malformed packs and entries are skipped, never fatal.

use alloc::string::String;

use pocketjs_core::{spec, Ui};

use crate::{Assets, SpriteAtlas, Texture};

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

/// Feed every recognized entry of `pak` into `ui` and return the named
/// textures and sprite atlases the compiled app binds by name.
pub fn feed(ui: &mut Ui, pak: &[u8], mut after_upload: impl FnMut(&Ui, i32)) -> Assets {
    let mut assets = Assets::default();
    let header_ok =
        rd_u32(pak, 0) == Some(spec::pak::MAGIC) && rd_u16(pak, 4) == Some(spec::pak::VERSION);
    if !header_ok {
        return assets;
    }
    let (Some(count), Some(dir_off), Some(names_off)) =
        (rd_u32(pak, 8), rd_u32(pak, 12), rd_u32(pak, 16))
    else {
        return assets;
    };
    let count =
        (count as usize).min(pak.len().saturating_sub(dir_off as usize) / spec::pak::ENTRY_SIZE);
    for i in 0..count {
        let e = dir_off as usize + i * spec::pak::ENTRY_SIZE;
        let (Some(blob_off), Some(blob_len), Some(name_off), Some(name_len)) = (
            rd_u32(pak, e + 4),
            rd_u32(pak, e + 8),
            rd_u32(pak, e + 12),
            rd_u16(pak, e + 16),
        ) else {
            continue;
        };
        let ns = names_off as usize + name_off as usize;
        let (Some(name_bytes), Some(blob)) = (
            pak.get(ns..ns + name_len as usize),
            pak.get(blob_off as usize..blob_off as usize + blob_len as usize),
        ) else {
            continue;
        };
        let Ok(key) = core::str::from_utf8(name_bytes) else {
            continue;
        };
        if key == "ui:styles" {
            ui.load_styles(blob);
        } else if key.starts_with("ui:font.") {
            ui.load_font_atlas(blob);
        } else if let Some(name) = key.strip_prefix("ui:img.") {
            let (Some(w), Some(h), Some(&psm)) = (rd_u16(blob, 0), rd_u16(blob, 2), blob.get(4))
            else {
                continue;
            };
            let Some(pixels) = blob.get(8..) else {
                continue;
            };
            let handle = ui.upload_texture(pixels, w as u32, h as u32, psm as u32);
            if handle >= 0 {
                after_upload(ui, handle);
                assets.textures.push(Texture {
                    name: String::from(name),
                    handle,
                });
            }
        } else if let Some(name) = key.strip_prefix("ui:sprite.") {
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
            let Some(pixels) = blob.get(16..) else {
                continue;
            };
            let handle = ui.upload_texture(pixels, w as u32, h as u32, psm as u32);
            if handle >= 0 {
                after_upload(ui, handle);
                assets.sprites.push(SpriteAtlas {
                    name: String::from(name),
                    handle,
                    frames,
                    cols,
                    step,
                });
            }
        }
    }
    assets
}
