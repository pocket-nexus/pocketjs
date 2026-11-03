# pocket-raster

Software rasterization of PocketJS DrawLists into CPU framebuffers.

## Install

```toml
[dependencies]
pocket-raster = "0.16.0"
pocket-drivers = "0.16.0"
```

## Example

```rust
use pocket_drivers::{FontView, RenderResources, TexView, spec::draw_op};

struct Resources;
impl RenderResources for Resources {
    fn viewport(&self) -> (f32, f32) { (1.0, 1.0) }
    fn raster_revision(&self) -> u64 { 0 }
    fn texture(&self, _: i32) -> Option<TexView<'_>> { None }
    fn font_atlas(&self, _: u8) -> Option<FontView<'_>> { None }
}
let words = [draw_op::RECT, 0, 1 | (1 << 16), 0xff0000ff];
let mut rgba = [0u8; 4];
pocket_raster::render(&Resources, &words, &mut rgba);
assert_eq!(rgba, [255, 0, 0, 255]);
```

## Environment and compatibility

Rust 1.93 or later. `no_std` with `alloc`; no window system or GPU dependency.

Provide resource views through `pocket-drivers::RenderResources`. Output size, stride and pixel format must match the selected renderer API. The crate does not create a display or shape text.

The `incremental` functions plan damage with a `pocket_render::damage::DamageTracker`,
rasterize only the planned regions, and commit the tracker; keep one tracker per
persistent framebuffer. The `compositor` module paints host-owned surface rasters
in DrawList order between the software-rendered segments.

Use matching PocketJS crate releases and compiler contracts. Application package
format, binding generation, and DrawList version are checked at their respective
boundaries; a Cargo version alone does not replace those checks.

## Documentation and license

- [API reference](https://docs.rs/pocket-raster)
- [Source](https://github.com/pocket-nexus/pocketjs/tree/main/engine/raster)
- [PocketJS documentation](https://pocketjs.pocket.nexus/docs/)

MIT. The published crate includes the copyright notice and full license in `LICENSE`.
