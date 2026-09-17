//! Atomic installation of a group of baked UI assets.
//!
//! All parsing and texture allocation happens in a staging core. The live
//! core is only changed after its texture slot storage has been reserved.
//! Invalid input and recoverable reservation failures leave it untouched.
//! Ordinary Rust allocator exhaustion follows the host's fatal OOM policy.

use crate::{rd_u16, spec, tex_alloc, Ui};
use alloc::vec;

#[derive(Clone, Copy)]
pub enum AssetKind {
    Styles,
    Font,
    Image,
    Sprite,
}

pub struct AssetInput<'a> {
    pub kind: AssetKind,
    pub bytes: &'a [u8],
}

#[derive(Debug, PartialEq, Eq)]
pub enum AssetError {
    Invalid,
    NoMemory,
}

impl Ui {
    /// Install all assets, or none. Texture handles are returned at the
    /// corresponding input index; styles and fonts return -1. Neither the
    /// core nor `handles` is modified on an error.
    pub fn load_assets(
        &mut self,
        inputs: &[AssetInput<'_>],
        handles: &mut [i32],
    ) -> Result<(), AssetError> {
        if handles.len() != inputs.len() {
            return Err(AssetError::Invalid);
        }
        if inputs.is_empty() {
            return Ok(());
        }
        let mut staged = Ui::new_with_raster_density(self.raster_density);
        let mut staged_handles = vec![-1; inputs.len()];
        let mut styles = false;
        let mut fonts = [false; spec::MAX_FONT_SLOTS];
        for (index, input) in inputs.iter().enumerate() {
            let b = input.bytes;
            match input.kind {
                AssetKind::Styles => {
                    if styles || !staged.load_styles(b) {
                        return Err(AssetError::Invalid);
                    }
                    styles = true;
                }
                AssetKind::Font => {
                    let slot = *b.get(12).ok_or(AssetError::Invalid)? as usize;
                    if slot >= fonts.len() || fonts[slot] || !staged.load_font_atlas(b) {
                        return Err(AssetError::Invalid);
                    }
                    fonts[slot] = true;
                }
                AssetKind::Image => {
                    let handle = staged.upload_img_entry(b);
                    if handle < 0 {
                        return Err(AssetError::Invalid);
                    }
                    staged_handles[index] = handle;
                }
                AssetKind::Sprite => {
                    if b.len() < 16 || b[5] != 0 {
                        return Err(AssetError::Invalid);
                    }
                    let w = rd_u16(b, 0).ok_or(AssetError::Invalid)? as u32;
                    let h = rd_u16(b, 2).ok_or(AssetError::Invalid)? as u32;
                    let frames = rd_u16(b, 6).ok_or(AssetError::Invalid)? as u32;
                    let cols = rd_u16(b, 8).ok_or(AssetError::Invalid)? as u32;
                    let step = rd_u16(b, 10).ok_or(AssetError::Invalid)?;
                    if frames == 0
                        || cols == 0
                        || step == 0
                        || w % cols != 0
                        || h % frames.div_ceil(cols) != 0
                    {
                        return Err(AssetError::Invalid);
                    }
                    let handle = staged.upload_texture(&b[16..], w, h, b[4] as u32);
                    if handle < 0 {
                        return Err(AssetError::Invalid);
                    }
                    staged_handles[index] = handle;
                }
            }
        }
        let additional = staged.textures.len().saturating_sub(self.tex_free.len());
        if self.textures.len().saturating_add(additional) > spec::TEX_SLOT_MASK as usize + 1 {
            return Err(AssetError::NoMemory);
        }
        self.textures
            .try_reserve(additional)
            .map_err(|_| AssetError::NoMemory)?;

        // No fallible operation or allocation is allowed below this point.
        if styles {
            self.styles = staged.styles;
        }
        for slot in 0..spec::MAX_FONT_SLOTS {
            if staged.fonts.atlas(slot as u8).is_some() {
                self.font_revisions[slot] = self.font_revisions[slot].wrapping_add(1);
            }
        }
        self.fonts.merge_atlases(&mut staged.fonts);
        for handle in &mut staged_handles {
            if *handle >= 0 {
                let texture = staged.textures[*handle as usize].tex.take().unwrap();
                *handle = tex_alloc(&mut self.textures, &mut self.tex_free, texture);
            }
        }
        handles.copy_from_slice(&staged_handles);
        self.layout.dirty = true;
        self.bump_raster_revision();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_late_invalid_entry_preserves_resources_handles_and_revision() {
        let mut core = Ui::new();
        let existing = core.upload_texture(&[11, 22, 33, 255], 1, 1, spec::psm::PSM_8888);
        let revision = core.raster_revision();
        let image = [1, 0, 1, 0, 3, 0, 0, 0, 44, 55, 66, 255];
        let inputs = [
            AssetInput {
                kind: AssetKind::Image,
                bytes: &image,
            },
            AssetInput {
                kind: AssetKind::Font,
                bytes: b"bad-font",
            },
        ];
        let mut handles = [123, 456];
        assert_eq!(
            core.load_assets(&inputs, &mut handles),
            Err(AssetError::Invalid)
        );
        assert_eq!(handles, [123, 456]);
        assert_eq!(core.raster_revision(), revision);
        assert_eq!(core.texture(existing).unwrap().pixels, &[11, 22, 33, 255]);
        assert_eq!(core.textures.len(), 1);
        core.load_assets(&inputs[..1], &mut handles[..1]).unwrap();
        assert_eq!(handles[0], existing + 1);
        assert_eq!(core.texture(handles[0]).unwrap().pixels, &image[8..]);
    }
}
