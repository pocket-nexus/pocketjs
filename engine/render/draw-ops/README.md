# pocket-draw-ops

Borrowed DrawList decoding, logical-pixel clipping, typed record fields, and
the vertex walk shared by PocketJS triangle renderers.

## Install

```toml
[dependencies]
pocket-draw-ops = "0.16.0"
pocket-drivers = "0.16.0"
```

## Example

```rust
use pocket_draw_ops::{DrawOps, DRAW_LIST_VERSION};
use pocket_drivers::{spec::draw_op, DamageRect};

let words = [draw_op::RECT, 0, 16 | (8 << 16), 0xff0000ff];
let mut ops = DrawOps::new(&words, DamageRect::new(0, 0, 320, 240));
let rectangle = ops.next().unwrap().unwrap();
assert_eq!(rectangle.words, &words);
let pocket_draw_ops::Record::Rect(fields) = rectangle.record().unwrap() else { panic!() };
assert_eq!((fields.width, fields.height, fields.color), (16, 8, 0xff0000ff));
assert!(ops.next().is_none());
assert!(DRAW_LIST_VERSION > 0);
```

`Operation::record` decodes a record's fields: XY words as signed 16-bit
coordinates, WH words as unsigned 16-bit extents, texture coordinates from
their IEEE-754 bits, and a gradient's corner colors through
`gradient_corners`. The `batch` module builds driver-defined vertices and
merges adjacent draw ranges with equal texture and clip keys. The `build`
module walks a DrawList into a vertex stream and batches; a driver's
`Backend` supplies the vertex type, the texture and clip keys, where solid
fills sample, how images and glyphs resolve, which records draw, and the quad
diagonal. The walk owns vertex order and batch boundaries.

## Environment and compatibility

Rust 1.93 or later. `no_std` with `alloc`; decoding uses a fixed clip stack and does not allocate, the vertex walk appends to the caller's vectors.

The operation format is closed and versioned. Unknown, truncated, or unbalanced records are errors. Consumers apply physical output scaling after decoding.

Use matching PocketJS crate releases and compiler contracts. Application package
format, binding generation, and DrawList version are checked at their respective
boundaries; a Cargo version alone does not replace those checks.

## Documentation and license

- [API reference](https://docs.rs/pocket-draw-ops)
- [Source](https://github.com/pocket-nexus/pocketjs/tree/main/engine/render/draw-ops)
- [PocketJS documentation](https://pocketjs.pocket.nexus/docs/)

MIT. The published crate includes the copyright notice and full license in `LICENSE`.
