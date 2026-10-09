# Native build receipts (Edgi-Talk M55)

`bun tools/rt-thread-edgitalk-native.ts` writes one JSON receipt per crate under
this directory after a successful cargo build:

- `ui-core.edgitalk-m55.build-receipt.json`
- `render-rgb565.edgitalk-m55.build-receipt.json`

Schema mirrors ESP-IDF `build-receipt.json` (schemaVersion 2) but:

- `target` is the host key `edgitalk-m55` (see `../toolchains.json`)
- `rustTarget` is always `thumbv8m.main-none-eabihf`
- `pinnedRustc` is **not** enforced (no official pin yet) — receipt still records
  the live `rustc -Vv` text for reproducibility on a developer machine
- Archives remain where cargo puts them (SConscript `LIBPATH`):
  `hosts/esp-idf/native/{ui-core,render-rgb565}/target/thumbv8m.main-none-eabihf/release/libpocketjs_idf_*.a`

See [`example-build-receipt.json`](./example-build-receipt.json) for the field
layout. Real digests are gitignored; commit only the example + this README.
