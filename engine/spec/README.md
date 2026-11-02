# pocket-spec

Generated PocketJS operation codes, data formats, and input constants. Use this crate when implementing a compatible runtime, driver, or package reader.

## Install

```toml
[dependencies]
pocket-spec = "0.16.0"
```

## Example

```rust
use pocket_spec::{BINDING_GENERATION, DRAW_LIST_VERSION};

assert!(BINDING_GENERATION > 0);
assert!(DRAW_LIST_VERSION > 0);
```

## Environment and compatibility

Rust 1.93 or later. #![no_std] without an allocator or platform SDK.

Keep operation numbers, binding generation and DrawList version aligned with the application compiler. Source definitions live in `contracts/spec`; generated Rust is shipped in the crate, so consumers do not need Bun.

Use matching PocketJS crate releases and compiler contracts. Application package
format, binding generation, and DrawList version are checked at their respective
boundaries; a Cargo version alone does not replace those checks.

## Documentation and license

- [API reference](https://docs.rs/pocket-spec)
- [Source](https://github.com/pocket-nexus/pocketjs/tree/main/engine/spec)
- [PocketJS documentation](https://pocketjs.pocket.nexus/docs/)

MIT. The published crate includes the copyright notice and full license in `LICENSE`.
