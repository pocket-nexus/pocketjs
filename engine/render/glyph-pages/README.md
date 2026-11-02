# pocket-glyph-pages

Font coverage expansion, guarded glyph pages, and A8 masks for PocketJS renderers.

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

Rust 1.93 or later. `no_std` with `alloc`; no font shaping library or GPU API is selected.

Font views borrow baked coverage bytes. Drivers upload expanded pages and retire cached pages after the submissions referencing them finish. This crate does not shape text or load system fonts.

Use matching PocketJS crate releases and compiler contracts. Application package
format, binding generation, and DrawList version are checked at their respective
boundaries; a Cargo version alone does not replace those checks.

## Documentation and license

- [API reference](https://docs.rs/pocket-glyph-pages)
- [Source](https://github.com/pocket-nexus/pocketjs/tree/main/engine/render/glyph-pages)
- [PocketJS documentation](https://pocketjs.pocket.nexus/docs/)

MIT. The published crate includes the copyright notice and full license in `LICENSE`.
