# pocket-draw-ops

Borrowed DrawList decoding and logical-pixel clipping for PocketJS renderers.

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
assert!(ops.next().is_none());
assert!(DRAW_LIST_VERSION > 0);
```

## Environment and compatibility

Rust 1.93 or later. `no_std`; decoding uses a fixed clip stack and does not allocate.

The operation format is closed and versioned. Unknown, truncated, or unbalanced records are errors. Consumers apply physical output scaling after decoding.

Use matching PocketJS crate releases and compiler contracts. Application package
format, binding generation, and DrawList version are checked at their respective
boundaries; a Cargo version alone does not replace those checks.

## Documentation and license

- [API reference](https://docs.rs/pocket-draw-ops)
- [Source](https://github.com/pocket-nexus/pocketjs/tree/main/engine/render/draw-ops)
- [PocketJS documentation](https://pocketjs.pocket.nexus/docs/)

MIT. The published crate includes the copyright notice and full license in `LICENSE`.
