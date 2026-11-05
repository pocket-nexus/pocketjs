# pocketjs-core

Retained UI trees, layout, text atlases, animation, and DrawList emission for PocketJS.

## Install

```toml
[dependencies]
pocketjs-core = "0.16.0"
```

## Example

```rust
use pocketjs_core::Ui;

let mut ui = Ui::new();
ui.set_viewport(320.0, 240.0);
let node = ui.create_node(0);
assert!(node > 0);
let _draw_list = ui.draw();
// A host submits the DrawList and borrowed resources to its renderer.
```

## Environment and compatibility

Rust 1.93 or later. `no_std` with `alloc`; layout uses taffy. The host supplies allocation and I/O.

This crate emits drawing operations. Use `pocket-runtime` for package admission, guests, input and frame scheduling; a renderer and display present the result. The `counters` feature exposes layout diagnostics and validation hooks.

The crate defines the `Physics` trait for `ui.physics` and contains no engine. `Ui::set_physics` installs one; `tick` steps it after animation tracks, and the engine writes only the `physics_values` layer of the nodes it poses.

Use matching PocketJS crate releases and compiler contracts. Application package
format, binding generation, and DrawList version are checked at their respective
boundaries; a Cargo version alone does not replace those checks.

## Documentation and license

- [API reference](https://docs.rs/pocketjs-core)
- [Source](https://github.com/pocket-nexus/pocketjs/tree/main/engine/core)
- [PocketJS documentation](https://pocketjs.pocket.nexus/docs/)

MIT. The published crate includes the copyright notice and full license in `LICENSE`.
