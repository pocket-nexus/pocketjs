# pocket-tex-cache

Forwarding crate for `pocket_render::tex_cache`: versioned texture storage with submission-scoped retention.

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

Rust 1.93 or later. `no_std`; the crate contains no code of its own.

**Every public path re-exports the item itself**, so values and types pass
between code that names the former path and code that names the new one.

| Former path | Item |
| --- | --- |
| `pocket_tex_cache::*` | `pocket_render::tex_cache::*` |

This crate is published for one release after `pocket-render` and is then
deprecated. New code depends on the crates in the right column.

Use matching PocketJS crate releases and compiler contracts. Application package
format, binding generation, and DrawList version are checked at their respective
boundaries; a Cargo version alone does not replace those checks.

## Documentation and license

- [API reference](https://docs.rs/pocket-tex-cache)
- [Source](https://github.com/pocket-nexus/pocketjs/tree/main/engine/render/tex-cache)
- [PocketJS documentation](https://pocketjs.pocket.nexus/docs/)

MIT. The published crate includes the copyright notice and full license in `LICENSE`.
