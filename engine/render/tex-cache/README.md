# pocket-tex-cache

Versioned texture storage with submission-scoped retention for graphics drivers.

## Install

```toml
[dependencies]
pocket-tex-cache = "0.16.0"
```

## Example

```rust
use pocket_tex_cache::{TextureCache, TextureKey};

let mut cache = TextureCache::new(4, 1024);
let key = TextureKey { handle: 1, revision: 1 };
cache.get_or_upload(key, 4, Some(7), || Ok::<_, ()>(vec![255u8; 4]), drop).unwrap();
assert_eq!(cache.resident_bytes(), 4);
// The device must have finished submission 7 before this call.
cache.retire(7, drop);
cache.clear(drop).unwrap();
assert!(cache.is_empty());
```

## Environment and compatibility

Rust 1.93 or later. `no_std` with `alloc`; no other crate dependencies.

The driver supplies upload/free callbacks and completion events. Pinned versions cannot be evicted. Retire submissions after device completion, then clear the cache while the native device remains valid.

## Documentation and license

- [API reference](https://docs.rs/pocket-tex-cache)
- [Source](https://github.com/pocket-nexus/pocketjs/tree/main/engine/render/tex-cache)
- [PocketJS documentation](https://pocketjs.pocket.nexus/docs/)

MIT. The published crate includes the copyright notice and full license in `LICENSE`.
