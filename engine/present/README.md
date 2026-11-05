# pocket-present

Forwarding crate for damage tracking, software composition, the presentation coordinator, and e-ink refresh scheduling.

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

Rust 1.93 or later. `no_std`; the crate contains no code of its own.

**Every public path re-exports the item itself**, so values and types pass
between code that names the former path and code that names the new one.

| Former path | Item |
| --- | --- |
| `pocket_present::damage`, `transaction` and the root damage types | `pocket_render::damage` |
| `pocket_present::compositor`, `incremental` | `pocket_raster::compositor`, `pocket_raster::incremental` |
| `pocket_present::coordinator`, `Coordinator`, `DisplayId`, `PresentError`, `RendererId` | `pocket_runtime::coordinator` |
| `pocket_present::ink` | `pocket_drivers::ink` |

This crate is published for one release after `pocket-render` and is then
deprecated. New code depends on the crates in the right column.

Use matching PocketJS crate releases and compiler contracts. Application package
format, binding generation, and DrawList version are checked at their respective
boundaries; a Cargo version alone does not replace those checks.

## Documentation and license

- [API reference](https://docs.rs/pocket-present)
- [Source](https://github.com/pocket-nexus/pocketjs/tree/main/engine/present)
- [PocketJS documentation](https://pocketjs.pocket.nexus/docs/)

MIT. The published crate includes the copyright notice and full license in `LICENSE`.
