# pocket-media

PocketJS media containers, transport messages, stream assembly, and byte codecs.

## Install

```toml
[dependencies]
pocket-media = "0.16.0"
```

## Example

```rust
use pocket_media::codec::packbits_decode;

let mut decoded = [0; 3];
assert!(packbits_decode(&[129, 42], &mut decoded));
assert_eq!(decoded, [42, 42, 42]);
```

## Environment and compatibility

Rust 1.93 or later. `no_std` with `alloc`; no audio device, file, or socket implementation.

Callers provide bytes and own I/O. The codec below uses the PocketJS PackBits variant, whose repeat counts differ from TIFF PackBits. Container and transport formats follow the matching PocketJS protocol version.

Use matching PocketJS crate releases and compiler contracts. Application package
format, binding generation, and DrawList version are checked at their respective
boundaries; a Cargo version alone does not replace those checks.

## Documentation and license

- [API reference](https://docs.rs/pocket-media)
- [Source](https://github.com/pocket-nexus/pocketjs/tree/main/engine/modules/media)
- [PocketJS documentation](https://pocketjs.pocket.nexus/docs/)

MIT. The published crate includes the copyright notice and full license in `LICENSE`.
