# Components — prefer sharing ESP-IDF sources

This host does **not** fork PocketJS C components.

## Consume shared trees

`native/SConscript` compiles the same sources as the ESP-IDF host:

| Shared component | Path under monorepo |
| --- | --- |
| package | `hosts/esp-idf/components/pocketjs_package/` |
| guest | `hosts/esp-idf/components/pocketjs_guest/` |
| ui_core | `hosts/esp-idf/components/pocketjs_ui_core/` |
| ui_qjs | `hosts/esp-idf/components/pocketjs_ui_qjs/` |
| render_rgb565 | `hosts/esp-idf/components/pocketjs_render_rgb565/` |

Rust staticlibs are the same crates under `hosts/esp-idf/native/{ui-core,render-rgb565}`
rebuilt for `thumbv8m.main-none-eabihf` via
`bun tools/rt-thread-edgitalk-native.ts`.

## Host-owned (this tree)

| Piece | Location |
| --- | --- |
| ESP→RT shims + QuickJS compat | `../native/include/`, `../native/*.c` |
| Portable host loop + board hooks | `../native/pocketjs_host_loop.c`, `pocketjs_host_board.h` |
| SCons fragment | `../native/SConscript` |
| Product Wi-Fi / BT / `__edgi` | **overlay only** (not here) |

## Do not

- Copy C sources from `hosts/esp-idf/components/` into this directory.
- Vendor BT firmware, BSP patches, or a full RT-Thread project here.
- Add a Registry `versions.json` until upstream accepts an M55 target (P3).

See [`../docs/build.md`](../docs/build.md) and [`../native/README.md`](../native/README.md).
