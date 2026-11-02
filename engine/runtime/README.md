# pocket-runtime

Application instances that own the PocketJS UI, admitted package, guest, input sources, and presentation registrations.

## Install

```toml
[dependencies]
pocket-runtime = "0.16.0"
pocket-drivers = "0.16.0"
```

## Example

```rust
use pocket_runtime::{Cow, InputClasses, Profile, Runtime, RuntimeConfig};

let runtime = Runtime::new(RuntimeConfig {
    profile_hash: [0x5a; 32], // Example identity; production uses exported facts.
    host_abi: pocket_drivers::spec::BINDING_GENERATION,
    heap_limit: 1024 * 1024,
    frame_buffer_budget: 320 * 240 * 4,
    profile: Profile {
        id: Cow::Borrowed("example"),
        cadences: Cow::Borrowed(&[60]),
        viewport: [320, 240],
        logical_viewports: Cow::Borrowed(&[[320, 240]]),
        dynamic_viewport: None,
        presentations: Cow::Borrowed(&[Cow::Borrowed("native")]),
        auxiliary: None,
        auxiliary_logical: Cow::Borrowed(&[]),
        density: 1,
        animation: Cow::Borrowed("composited"),
        capabilities: Cow::Borrowed(&[]),
        required_inputs: InputClasses::NONE,
    },
}).unwrap();
assert!(runtime.op_context().supports_op(1));
assert!(runtime.timing().is_none()); // Timing is chosen when a package boots.
```

Run from the PocketJS checkout with `cargo run -p pocket-runtime --example configure`.

## Environment and compatibility

Rust 1.93 or later. `no_std` with `alloc`; the host provides an allocator, guest engine and device implementations.

The example configures an instance without booting an application. Production hosts use facts exported by `pocket host export`; the sample hash is not a production host identity. Register a package source, guest, renderer, display and required inputs before `boot`, then drive `tick` and call `shutdown` before releasing devices.

Use matching PocketJS crate releases and compiler contracts. Application package
format, binding generation, and DrawList version are checked at their respective
boundaries; a Cargo version alone does not replace those checks.

## Documentation and license

- [API reference](https://docs.rs/pocket-runtime)
- [Source](https://github.com/pocket-nexus/pocketjs/tree/main/engine/runtime)
- [PocketJS documentation](https://pocketjs.pocket.nexus/docs/)

MIT. The published crate includes the copyright notice and full license in `LICENSE`.
