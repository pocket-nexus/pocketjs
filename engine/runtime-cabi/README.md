# pocket-runtime-cabi

The canonical C interface owns runtime instances and accepts registered guest,
renderer, display, input and package implementations. **Driver registration
selects the backend.** Profile IDs, targets and devices are not Cargo features.

The SDK builds this crate with **default features disabled** and does not enable
`legacy-ui`. That dependency graph contains no GLES driver. A C program supplies
the six `pocket_host_*` functions. The `std` feature supplies standard allocator,
clock and host integration; it is the Rust crate's default convenience setting.
`external-runtime` omits this crate's no-std allocator and panic handlers when
an embedding Rust program owns them.

## Compatibility parameters

`legacy-ui` enables the old singleton UI namespace and its optional GLES
dependencies. Existing C shells use it through `programs/native/cabi`. The
canonical instance interface does not use that namespace. The following
parameters affect the compatibility adapter, not canonical driver selection:

- `gles1`: use the GLES 1 adapter instead of GLES 2.
- `software-only`: omit compatibility GL entry-point implementations for a
  framebuffer shell. The entry points report failure without submitting GL.
- `standalone-extension-provider`: export the empty private extension provider
  for shells without a custom provider.
- `boot-stage`: report compatibility boot stages through the program hook.
- `harness-access`: expose the unsafe singleton inspection hook to in-process
  tests; its documented exclusivity requirements still apply.
- `gl-frame-validation`: retain the accepted compatibility build option. The
  extracted GLES drivers own error checks; this option adds no separate path.

These parameters have an exact allowlist in
`tests/fixtures/cargo-features/contracts.ts`. The gate checks both feature names
and dependency expansion, and confirms that the default SDK graph excludes
the compatibility GLES dependencies.
