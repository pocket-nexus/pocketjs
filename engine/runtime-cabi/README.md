# pocket-runtime-cabi

The canonical C interface owns runtime instances and accepts registered guest,
renderer, display, input and package implementations. **Driver registration
selects the backend.** Profile IDs, targets and devices are not Cargo features.

The SDK builds this crate with **default features disabled** and contains no GLES driver. A C program supplies
the six `pocket_host_*` functions. The `std` feature supplies standard allocator,
clock and host integration; it is the Rust crate's default convenience setting.
`external-runtime` omits this crate's no-std allocator and panic handlers when
an embedding Rust program owns them.

The public features are checked by
`tests/fixtures/cargo-features/contracts.ts`. Native programs select and link
renderers in their own composition.
