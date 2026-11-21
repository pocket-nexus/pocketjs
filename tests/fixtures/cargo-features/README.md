# Public Cargo feature contract

`contracts.ts` is a reviewed list of every publishable workspace crate and its
feature expansion. A new crate or feature requires an explicit update here.
Tests compare this list with source manifests and inspect `cargo tree -e
features` for the workspace and a separate consumer. They exercise disabled
defaults, defaults, and all declared features without compiling a device SDK.

Empty entries have **no public feature parameters**. Platform identity belongs
to the crate name. A renderer or program cannot be selected through a feature
on the portable core or runtime.

The declared parameters are:

- `std`: standard library integration; `external-runtime`: the embedding Rust
  program owns allocator and panic handlers instead of the C archive.
- `pocket-archive/software-renderer`: `pocket_runtime_create` registers the
  software rasterizer as renderer 0 and `pocket_raster_draw_op` draws.
- `counters` and `model-trace`: diagnostic counters and model tracing.
- `critical-section`: portable atomics use the embedding critical-section
  implementation on targets without the required atomics.
- `microts/runtime`: enable the optional canonical runtime dependency.
- `pocket-vita-gxm/runtime-compiler`: permit runtime shader compilation through
  SceShaccCg. It does not select the graphics driver.
- `cabi`: expose the C entry points for the same implementation.
- `mount`: enable optional `pocket-mod` and `anyhow` integration for a module.
- `default`: the declared convenience group of the parameters above.

The SDK test checks that the no-default-feature dependency graph of
`pocket-archive` excludes every GLES crate.

The list records exact dependency edges. Adding a selector to an existing
parameter's expansion fails even if its feature name stays unchanged. Registry
publication is a separate release step; the independent candidate check uses
path dependencies and does not claim a published-crate download.
