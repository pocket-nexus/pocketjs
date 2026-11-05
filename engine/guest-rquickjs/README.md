# pocket-guest-rquickjs

Generated PocketJS UI bindings and guest lifecycle implemented with rquickjs.

## Install

```toml
[dependencies]
pocket-guest-rquickjs = "0.16.0"
pocket-runtime = "0.16.0"
pocket-drivers = "0.16.0"
pocketjs-core = "0.16.0"
```

## Example

```rust
use pocket_guest_rquickjs::RquickjsGuest;
use pocket_runtime::{Guest, GuestEnvironment, GuestFrame, OpContext};
use pocketjs_core::Ui;

let ops = OpContext::from_ui(Ui::new());
let environment = GuestEnvironment {
    host: "example", host_abi: pocket_drivers::spec::BINDING_GENERATION,
    tick_hz: 60, sim_hz: 60, viewport: [320, 240],
    auxiliary_viewport: None, auxiliary_root: -1, raster_density: 1,
    heap_limit: 1024 * 1024, pak: &[], worker_javascript: &[], assets: None,
};
let mut guest = RquickjsGuest::default();
guest.initialize(ops, &environment).unwrap();
guest.evaluate(b"globalThis.turns = 0; globalThis.frame = () => { turns++; };").unwrap();
guest.frame(&GuestFrame {
    buttons: 0, analog: 0, touches: &[], hits: &[], touch_surfaces: &[],
    right_analog: 0, axis_deltas: &[], motion: None, text: &[],
}).unwrap();
let turns = guest.with(|ctx| ctx.globals().get::<_, u32>("turns").unwrap()).unwrap();
assert_eq!(turns, 1);
guest.shutdown();
```

Run from the PocketJS checkout with `cargo run -p pocket-guest-rquickjs --example guest_turn`.

## Environment and compatibility

Rust 1.93 or later. Requires `std`. rquickjs 0.12 builds QuickJS through `rquickjs-sys`; a C compiler and the target C toolchain must be available.

Use `RquickjsGuest::default()` with `Runtime::set_guest` for application instances. The example exercises the lower-level Guest lifecycle in a host-owned UI. Canonical bindings match the runtime binding generation; legacy profiles exist for compatibility. A realm and heap limit alone do not provide execution-time isolation.

Use matching PocketJS crate releases and compiler contracts. Application package
format, binding generation, and DrawList version are checked at their respective
boundaries; a Cargo version alone does not replace those checks.

## Documentation and license

- [API reference](https://docs.rs/pocket-guest-rquickjs)
- [Source](https://github.com/pocket-nexus/pocketjs/tree/main/engine/guest-rquickjs)
- [PocketJS documentation](https://pocketjs.pocket.nexus/docs/)

MIT. The published crate includes the copyright notice and full license in `LICENSE`.
