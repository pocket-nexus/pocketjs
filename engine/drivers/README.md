# pocket-drivers

Device traits, borrowed render resources, input records, and package byte sources shared by PocketJS hosts and drivers.

## Install

```toml
[dependencies]
pocket-drivers = "0.16.0"
```

## Example

```rust
use pocket_drivers::DamageRect;

let viewport = DamageRect::new(0, 0, 320, 240);
let requested = DamageRect::new(-10, 20, 50, 60);
assert_eq!(requested.intersect(viewport), DamageRect::new(0, 20, 50, 60));
```

## Environment and compatibility

Rust 1.93 or later. `no_std` with `alloc`; the embedding program supplies an allocator.

Drivers own device I/O. The runtime owns registration and frame scheduling. Borrowed resources must remain valid for the lifetime required by each submission. The `target` module states how a renderer issues the device target handles its displays present, who owns the renderer, and the order in which a renderer, its displays and their targets are destroyed.

The `ink` module schedules partial, dynamic and full e-ink refreshes from host
timestamps and the panel's busy state; it holds no framebuffer or panel handle.

Use matching PocketJS crate releases and compiler contracts. Application package
format, binding generation, and DrawList version are checked at their respective
boundaries; a Cargo version alone does not replace those checks.

## Documentation and license

- [API reference](https://docs.rs/pocket-drivers)
- [Source](https://github.com/pocket-nexus/pocketjs/tree/main/engine/drivers)
- [PocketJS documentation](https://pocketjs.pocket.nexus/docs/)

MIT. The published crate includes the copyright notice and full license in `LICENSE`.
