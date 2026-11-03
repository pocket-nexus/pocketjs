# pocket-glyph-pages

Forwarding crate for `pocket_render::glyph_pages`: font coverage expansion, guarded glyph pages, and A8 masks.

## Install

```toml
[dependencies]
pocket-glyph-pages = "0.16.0"
pocket-drivers = "0.16.0"
```

## Example

```rust
use pocket_drivers::FontView;
use pocket_glyph_pages::GlyphPageLayout;

let bitmap = [255u8; 4];
let font = FontView {
    bitmap: &bitmap, cell_w: 2, cell_h: 2,
    raster_density: 1, glyph_count: 1,
};
let page = GlyphPageLayout::new(font, 0).unwrap();
let mut coverage = vec![0; page.coverage_bytes()];
assert!(page.expand_a8(font, &mut coverage));
assert!(coverage.contains(&255));
```

## Environment and compatibility

Rust 1.93 or later. `no_std`; the crate contains no code of its own.

**Every public path re-exports the item itself**, so values and types pass
between code that names the former path and code that names the new one.

| Former path | Item |
| --- | --- |
| `pocket_glyph_pages::*` | `pocket_render::glyph_pages::*` |

This crate is published for one release after `pocket-render` and is then
deprecated. New code depends on the crates in the right column.

Use matching PocketJS crate releases and compiler contracts. Application package
format, binding generation, and DrawList version are checked at their respective
boundaries; a Cargo version alone does not replace those checks.

## Documentation and license

- [API reference](https://docs.rs/pocket-glyph-pages)
- [Source](https://github.com/pocket-nexus/pocketjs/tree/main/engine/render/glyph-pages)
- [PocketJS documentation](https://pocketjs.pocket.nexus/docs/)

MIT. The published crate includes the copyright notice and full license in `LICENSE`.
