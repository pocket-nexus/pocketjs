# PocketJS on ESP-IDF

**The product registers its guest, input, display, package source and renderer
on one `pocket_runtime` instance.** The runtime owns package admission, UI
state, input packing, damage tracking and presentation. The product owns tasks,
GPIO configuration, panel setup and package storage.

| Component | Responsibility | Targets |
| --- | --- | --- |
| `pocket_runtime` | One native program archive, six allocator/log hooks and memory package source | P4, S3 |
| `pocket_guest_quickjs` | QuickJS allocation, cancellation and generated guest bindings | P4, S3 |
| `pocket_display_esp_lcd` | RGB565 SPI/I80 GRAM output with one or two DMA strip buffers | P4, S3 |
| `pocket_render_esp_ppa` | P4 FILL, A8 BLEND and SRM operations | P4 |
| `pocket_runner` | Optional owner task using the shared tick schedule | P4, S3 |

The runtime component links `libpocket_idf_runtime.a`. This archive composes
`pocket-runtime-cabi` and the PPA factory. `pocket-raster` supplies the built-in
software renderer. The PPA renderer implements the same public driver contract;
unsupported operations use ordered software fallback.

`examples/smoke` and `examples/prebuilt` register these interfaces in `main.c`.
Their sample display is a transfer-hash sink with two strips; it does not
initialize a physical panel. A product can replace that table with
`pocket_display_esp_lcd_vtable()` after configuring its panel and panel IO.
`examples/runner` registers the same application and joins the owner task
before destroying runtime or driver state.

```sh
pocket profile export --config tests/esp-idf/examples/prebuilt/pocket.runtime-config.ts \
    --out /tmp/pocket-idf-profile
cd tests/esp-idf/examples/prebuilt
idf.py -DPOCKETJS_PROFILE_EXPORT_DIR=/tmp/pocket-idf-profile \
    -DPOCKETJS_RUST_FROM_SOURCE=ON set-target esp32p4
idf.py build
```

A source build uses the caller's Rust toolchain. Registry releases provide
native archives for P4 and S3. Pass `POCKET_RUNTIME_ARCHIVE` to select a prepared
archive, or `POCKETJS_CARGO` with source builds to select a Cargo installation.
The product owns `pocket.runtime-config.ts` and its imported software profile.
`pocket profile export` emits the header and JSON sidecar consumed by the
program and Python embed helper. The prebuilt IDF build needs no Bun or Pocket
CLI once those artifacts exist. Source compilation uses `pocketjs_compile_app`;
`pocketjs_profile_header` exports a profile without an application.

See [component maintenance](../../docs/ESP_IDF.md) for archive receipts,
QuickJS source identity and validation.
