# pocket-render

DrawList decoding and vertex building, texture and glyph page retention, and
damage tracking for PocketJS renderers.

## Install

```toml
[dependencies]
pocket-render = "0.16.0"
pocket-drivers = "0.16.0"
```

## Example

```rust
use pocket_drivers::{spec::draw_op, DamageRect};
use pocket_render::{damage::DamagePlan, DrawOps, Record, DRAW_LIST_VERSION};

let words = [draw_op::RECT, 0, 16 | (8 << 16), 0xff0000ff];
let mut ops = DrawOps::new(&words, DamageRect::new(0, 0, 320, 240));
let rectangle = ops.next().unwrap().unwrap();
let Record::Rect(fields) = rectangle.record().unwrap() else { panic!() };
assert_eq!((fields.width, fields.height, fields.color), (16, 8, 0xff0000ff));
assert!(ops.next().is_none());
assert!(DRAW_LIST_VERSION > 0);

let plan = DamagePlan::<8>::full(DamageRect::new(0, 0, 320, 240));
assert!(plan.is_full_redraw());
```

The crate root decodes the closed DrawList operation set. `Operation::record`
decodes a record's fields: XY words as signed 16-bit coordinates, WH words as
unsigned 16-bit extents, texture coordinates from their IEEE-754 bits, and a
gradient's corner colors through `gradient_corners`. The `batch` module builds
driver-defined vertices and merges adjacent draw ranges with equal texture and
clip keys. The `build` module walks a DrawList into a vertex stream and
batches; a driver's `Backend` supplies the vertex type, the texture and clip
keys, where solid fills sample, how images and glyphs resolve, which records
draw, and the quad diagonal. The walk owns vertex order and batch boundaries.

| Module | Contents |
| --- | --- |
| `tex_cache` | Device textures keyed by handle and revision, retained until the last submission that reads them retires |
| `glyph_pages` | Font coverage expansion into guarded A8 pages and masks, and ABGR4444 pages retained by submission |
| `damage` | DrawList comparison into disjoint damage regions per persistent target, with prepare, commit and abort through `DamageTransaction` |

## Environment and compatibility

Rust 1.93 or later. `no_std` with `alloc`; the only dependencies are
`pocket-drivers` and `pocket-spec`. Decoding uses a fixed clip stack and does
not allocate; the vertex walk appends to the caller's vectors.

The operation format is closed and versioned. Unknown, truncated, or unbalanced
records are errors. Consumers apply physical output scaling after decoding.
Keep one damage history per persistent physical target; commit it after
successful output and abort or invalidate it on failure.

`pocket-draw-ops`, `pocket-glyph-pages` and `pocket-tex-cache` re-export the
crate root, `glyph_pages` and `tex_cache` under their former paths for one
release.

Use matching PocketJS crate releases and compiler contracts. Application package
format, binding generation, and DrawList version are checked at their respective
boundaries; a Cargo version alone does not replace those checks.

## Documentation and license

- [API reference](https://docs.rs/pocket-render)
- [Source](https://github.com/pocket-nexus/pocketjs/tree/main/engine/render)
- [PocketJS documentation](https://pocketjs.pocket.nexus/docs/)

MIT. The published crate includes the copyright notice and full license in `LICENSE`.
