# Native host glue — RT-Thread / Edgi-Talk

C glue for PocketJS on Edgi-Talk (PSoC E84 M55 / RT-Thread). Ported and adapted
from [PocketJS_for_Edgi-Talk](https://github.com/1024971823/PocketJS_for_Edgi-Talk)
`projects/Edgi_Talk_M55_PocketJS/applications/pocketjs/`.

## Layout

| Path | Role |
| --- | --- |
| `include/esp_*.h` | ESP→RT shims (`esp_err`, `esp_log`, `esp_heap_caps`) |
| `include/quickjs*.h`, `pocketjs_qjs_ng_compat.h` | QuickJS-ng platform / API compat |
| `pocketjs_rt_compat.c` | `heap_caps_*` → HyperRAM/SPIRAM + strong `memcmp` |
| `quickjs_compat.c` | Minimal `js_std_*` |
| `include/pocketjs/pocketjs_host_board.h` | **Board hooks** (LCD present, touch, embed, product guest) |
| `include/pocketjs/pocketjs_app.h` | `pocketjs_app_start` / `wait_ready` |
| `pocketjs_host_loop.c` | Package/guest/ui/render bring-up + RGB565 turn loop |
| `SConscript` | Shared IDF-component C sources + M55 Rust `LIBPATH` |
| `generated/` | Embed **pattern** + zero-size stub (see `generated/README.md`) |

## Board hooks (product binds these)

The host loop calls weak symbols documented in `pocketjs_host_board.h`. The
overlay should provide strong definitions for:

- Display open + framebuffer
- Partial / full LCD present (`lcd_rect_present_*` / `RTGRAPHIC_CTRL_RECT_UPDATE`)
- Touch sample → `pocketjs_ui_input_t`
- Embedded package + host contract
- Optional guest installs (`__edgi` / dashboard / music / game) and frame hooks

Until the overlay binds hooks and drops its duplicate `pocketjs_app.c` loop, the
product may keep using the in-tree overlay app; this tree is the monorepo SoT
for the portable loop + shims + SCons fragment.

## What stays in the overlay

`pocketjs_wifi*`, `pocketjs_bt*`, `pocketjs_game*`, `pocketjs_synth*`,
`pocketjs_music*`, `pocketjs_dashboard*`, board `main` / backlight / Kconfig,
product-specific generated `.pocket` blobs, BSP patches, BT firmware.

## Include from product SCons

Set `POCKETJS_ROOT` to this monorepo clone, then:

```python
import os
pocketjs_native = os.path.join(POCKETJS_ROOT, 'hosts/rt-thread-edgitalk/native/SConscript')
SConscript(pocketjs_native)
```

Optional env: `POCKETJS_QUICKJS_ROOT`, `POCKETJS_SMOKE_PACKAGE`,
`POCKETJS_DEBUG_TOUCH=1`, `POCKETJS_NATIVE_HOST_LOOP=0` (omit
`pocketjs_host_loop.c` when product still builds `pocketjs_app.c`),
`POCKETJS_NATIVE_PACKAGE_STUB=0` (omit zero-size stub when product embeds). See [`../docs/build.md`](../docs/build.md).

## Native Rust build (P2)

| Path | Role |
| --- | --- |
| `toolchains.json` | Declares `edgitalk-m55` → `thumbv8m.main-none-eabihf` |
| `receipts/` | Build receipt schema + example (digests gitignored) |
| `../../../../tools/rt-thread-edgitalk-native.ts` | Build ui-core + render-rgb565 + write receipts |
| `../../../../tools/rt-thread-edgitalk-contracts.ts` | Shared IDF ABI check + honest RTT TODOs |
| `../../../../contracts/spec/rtt-edgitalk-native.ts` | Lockstep inventory vs `idf-native.ts` |

```sh
bun tools/rt-thread-edgitalk-native.ts --check-prereqs
bun tools/rt-thread-edgitalk-native.ts --dry-run
bun tools/rt-thread-edgitalk-native.ts   # real cargo build when target available
```

Shared C components stay under `hosts/esp-idf/components/` — see
[`../components/README.md`](../components/README.md).

## Remaining extraction

- Overlay `pocketjs_app.c` still contains a full board-entangled copy of the
  loop (ST7102 calibration, direct `lcd_*` externs, dashboard/music/game calls).
  Next thinning step: implement `pocketjs_host_board.h` in the overlay and
  compile `pocketjs_host_loop.c` from this tree instead.
- Real embed still lives in the overlay `generated/`; only the pattern/stub is
  here (no huge `.pocket` vendored).
