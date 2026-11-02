# pocket-sim

Bounded prediction, reconciliation, command queues, and snapshot sampling for fixed-step simulations.

## Install

```toml
[dependencies]
pocket-sim = "0.16.0"
```

## Example

```rust
use pocket_sim::Predictor;

fn step(position: &mut i32, movement: &i32) { *position += movement; }
let mut predicted = Predictor::<i32, i32, 8>::new(0, 0);
predicted.predict(2, step).unwrap();
predicted.predict(3, step).unwrap();
assert_eq!(*predicted.state(), 5);
// The server observed position 1 after tick 1; replay tick 2's movement.
let correction = predicted.reconcile(1, 1, step).unwrap();
assert!(correction.corrected);
assert_eq!(correction.replayed, 1);
assert_eq!(*predicted.state(), 4);
```

Run from the PocketJS checkout with `cargo run -p pocket-sim --example reconcile`.

## Environment and compatibility

Rust 1.93 or later. `no_std` with `alloc`; no other crate dependencies.

Reducers depend on state, input and immutable configuration. Emit network or audio effects outside the reducer because reconciliation replays it. History capacity is fixed by a const generic; handle full, stale and gap errors at the session boundary.

## Documentation and license

- [API reference](https://docs.rs/pocket-sim)
- [Source](https://github.com/pocket-nexus/pocketjs/tree/main/engine/crates/pocket-sim)
- [PocketJS documentation](https://pocketjs.pocket.nexus/docs/)

MIT. The published crate includes the copyright notice and full license in `LICENSE`.
