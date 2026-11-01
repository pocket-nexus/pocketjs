use crate::{AssetRegistry, NamedSprite, NamedTexture, RuntimeError};
use alloc::{string::ToString, vec, vec::Vec};
use pocketjs_core::{
    assets::{AssetInput, AssetKind},
    Ui,
};

/// Install the pak's assets. With `storage`, the pak's backing store the
/// runtime keeps alive, font atlases read their cells from it in place.
pub(crate) fn install(
    ui: &mut Ui,
    pak: &[u8],
    storage: Option<alloc::rc::Rc<dyn AsRef<[u8]>>>,
) -> Result<AssetRegistry, RuntimeError> {
    let mut inputs = Vec::new();
    let mut names = Vec::new();
    for entry in
        pocket_package::pak::checked_entries(pak).map_err(|_| RuntimeError::InvalidAssets)?
    {
        let kind = if entry.key == "ui:styles" {
            AssetKind::Styles
        } else if entry.key.starts_with("ui:font.") && entry.key.len() > 8 {
            AssetKind::Font
        } else if entry.key.starts_with("ui:img.") && entry.key.len() > 7 {
            AssetKind::Image
        } else if entry.key.starts_with("ui:sprite.") && entry.key.len() > 10 {
            AssetKind::Sprite
        } else {
            continue;
        };
        names.push(entry.key);
        inputs.push(AssetInput {
            kind,
            bytes: entry.blob,
        });
    }
    let mut handles = vec![-1; inputs.len()];
    ui.load_assets_from(&inputs, &mut handles, storage.as_ref())
        .map_err(|_| RuntimeError::InvalidAssets)?;
    let mut registry = AssetRegistry::default();
    for ((input, key), handle) in inputs.iter().zip(names).zip(handles) {
        match input.kind {
            AssetKind::Image => registry.textures.push(NamedTexture {
                name: key[7..].to_string(),
                handle,
            }),
            AssetKind::Sprite => {
                let get = |at| u16::from_le_bytes([input.bytes[at], input.bytes[at + 1]]) as u32;
                registry.sprites.push(NamedSprite {
                    name: key[10..].to_string(),
                    handle,
                    frames: get(6),
                    columns: get(8),
                    step: get(10),
                });
            }
            _ => {}
        }
    }
    Ok(registry)
}
