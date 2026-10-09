# Headless smoke outline (Edgi-Talk / RT-Thread)

**Status:** source outline + docs only. Not a board-CI job yet.

Goal: mirror `hosts/esp-idf/examples/smoke` philosophy — exercise
package → guest → ui_core / ui_qjs → RGB565 prepare / render_strip / commit
against a **RAM framebuffer** with a **fake present**, without LCD/touch
drivers.

## Why it cannot run on-host today

- Needs RT-Thread headers, HyperRAM/`heap_caps` shims, and QuickJS linked the
  same way as the product SCons fragment.
- No POSIX host stub is provided; building requires the Edgi BSP (or a future
  board-CI image).

## Intended flow (when board-CI exists)

1. Build `.pocket` for `apps/edgitalk-m55-smoke` (or a tiny dedicated smoke app).
2. Embed package via `native/generated/` pattern.
3. Build this example against `hosts/rt-thread-edgitalk/native/SConscript`.
4. Run on M55 (or QEMU/BSP CI): print frame hash like IDF smoke `PASS … hash=…`.

## Files

| Path | Role |
| --- | --- |
| `smoke_outline.c` | Headless stub sketch (RAM FB + fake present) |
| `README.md` | This file |

## Related

- ESP reference: `hosts/esp-idf/examples/smoke/main/main.c`
- Host loop: `hosts/rt-thread-edgitalk/native/pocketjs_host_loop.c`
- Tracking CI: defer to P3 / board-CI; platform id still issue #2
