# pocket-present

Damage tracking, surface composition, and render/display submission coordination for PocketJS.

## Install

```toml
[dependencies]
pocket-present = "0.16.0"
```

## Example

```rust
use pocket_present::{DamagePlan, DamageRect};

let plan = DamagePlan::<8>::full(DamageRect::new(0, 0, 320, 240));
assert!(plan.is_full_redraw());
assert_eq!(plan.region_count(), 1);
// A renderer must clear and replay drawing in every planned region.
assert_eq!(plan.regions()[0], DamageRect::new(0, 0, 320, 240));
```

## Environment and compatibility

Rust 1.93 or later. `no_std` with `alloc`; renderers and displays are caller-supplied.

Keep one damage history per persistent physical target. Commit it after successful output; abort or invalidate it on failure. Deferred submissions retain resources until render and display waits complete.

Use matching PocketJS crate releases and compiler contracts. Application package
format, binding generation, and DrawList version are checked at their respective
boundaries; a Cargo version alone does not replace those checks.

## Documentation and license

- [API reference](https://docs.rs/pocket-present)
- [Source](https://github.com/pocket-nexus/pocketjs/tree/main/engine/present)
- [PocketJS documentation](https://pocketjs.pocket.nexus/docs/)

MIT. The published crate includes the copyright notice and full license in `LICENSE`.
