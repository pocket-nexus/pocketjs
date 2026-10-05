# PocketJS Wii Homebrew host

PocketJS Wii is a static library for a devkitPPC Homebrew application. **The application owns `main`, controller polling, GX and video setup, frame presentation, and vblank.** PocketJS boots one `.pocket` guest, advances it in fixed **1/60-second** steps, and draws its **480×272 logical surface** into the GX destination rectangle chosen by the caller.

**The Wii profile is `wii-dev`, HostOps ABI 7, and is not registered as a production target.** Build its guest with `bun tools/wii.ts <app>`; the generic `bun pocket` command does not select Wii.

## Tested toolchain

The development build checks used this toolchain:

| Tool | Tested version |
| --- | --- |
| devkitPPC | r50-1; GCC 16.1.0, binutils 2.46.0, newlib 4.6.0.20260123-4 |
| devkitppc-rules | 1.2.1-1 |
| libogc | 3.1.0-1 |
| gamecube-tools | 1.0.7-1 (`elf2dol`) |
| Rust | nightly `2026-07-02`, with `rust-src` |
| Bun | 1.3.3 |
| QuickJS | `ba5bdd0dc013518768e76cd9e05cd30ed53dd35b` |

The tested devkitPro installation was `/opt/devkitpro`. Set these variables for another install location:

```sh
export DEVKITPRO=/opt/devkitpro
export DEVKITPPC="$DEVKITPRO/devkitPPC"
export PATH="$DEVKITPPC/bin:$DEVKITPRO/tools/bin:$PATH"
rustup toolchain install nightly-2026-07-02 --component rust-src
```

The Rust toolchain file in `hosts/wii/core` selects that nightly. If the pinned QuickJS checkout is not already in Cargo's cache, fetch it with:

```sh
cargo fetch --manifest-path hosts/psp/Cargo.toml
```

## Build the library, guest, and example

Run these commands from the PocketJS repository root. `hero` names the directory `apps/hero`; the package output name comes from that app's `pocket.json`.

```sh
bun tools/wii.ts --library
bun tools/wii.ts hero
make -C hosts/wii/example
```

The library build exports these files:

| File | Contents |
| --- | --- |
| `dist/wii/pocket_wii.h` | Public C API and input constants |
| `dist/wii/libpocketjs_wii.a` | PocketJS C host and GX renderer |
| `dist/wii/quickjs/libquickjs.a` | QuickJS runtime |
| `dist/wii/core/powerpc-gekko-eabi/release/libpocketjs_wii_core.a` | Rust core |
| `dist/wii/guest/<output>.pocket` | Guest package built for `wii-dev`, ABI 7 |
| `hosts/wii/example/build/boot.dol` | Linked Homebrew example |

For an app in this repository, replace `hero` with its directory name under `apps/`. To embed another `.pocket` file in the example, pass its path as `GUEST_PACKAGE`, for example:

```sh
make -C hosts/wii/example GUEST_PACKAGE=/path/to/app.pocket
```

To embed the package in your own build, generate a C array and include that header where you call `pocket_wii_boot`:

```sh
xxd -i -n guest_package /path/to/app.pocket > guest_package.h
```

The example Makefile shows the complete linker inputs. A separate project includes only `pocket_wii.h` for PocketJS calls and links the three archives in this order. Newlib `-lc` comes before them; libogc's `-lwiiuse -lbte -logc -lm` follows them:

```make
DIST := /path/to/pocketjs/dist/wii
CFLAGS += -I$(DIST) -I$(LIBOGC_INC)
LDFLAGS += $(MACHDEP) -Wl,--gc-sections -Wl,--no-undefined \
  -Wl,-u,memset -Wl,-u,memcpy
LIBS += -L$(LIBOGC_LIB) -lc \
  $(DIST)/libpocketjs_wii.a \
  $(DIST)/quickjs/libquickjs.a \
  $(DIST)/core/powerpc-gekko-eabi/release/libpocketjs_wii_core.a \
  -lfat -lwiiuse -lbte -logc -lm

$(CC) $(LDFLAGS) $(OBJECTS) $(LIBS) -o boot.elf
$(DEVKITPRO)/tools/bin/elf2dol boot.elf boot.dol
```

Keep `-lc` before the Rust archive and retain `-Wl,-u,memset -Wl,-u,memcpy`. The Wii link probe found that libogc's BSS initialization can erase its stack if Rust's weak `compiler_builtins` `memset` is selected; the forced newlib symbols avoid that failure. `-lfat` is for the example's SD log and can be omitted by hosts that do not use libfat. Use `$(DEVKITPRO)/tools/bin/elf2dol` on the linked ELF to produce `boot.dol`.

## C host loop

Inside the host's `main`, initialize video and GX before this loop. `poll_buttons`, `poll_nunchuk_or_center`, frame setup, host state binding, host drawing, and presentation are host-defined:

```c
#include <stdio.h>
#include <gccore.h>
#include <ogc/lwp_watchdog.h>
#include "pocket_wii.h"
#include "guest_package.h" /* generated with xxd -i -n guest_package */

/* Implement these with the application's libogc input and GX code. */
uint32_t poll_buttons(void);
uint32_t poll_nunchuk_or_center(void);
void begin_gx_frame(void);
void bind_host_gx_state(void);
void draw_host_content(void);
void draw_more_host_content(void);
void present_and_wait_for_vblank(void);

int main(void) {
  /* Initialize video/GX and controller polling here. */
  if (pocket_wii_boot(guest_package, guest_package_len) != 0) {
    printf("PocketJS boot: %s\n", pocket_wii_last_error());
    return 1;
  }

  uint64_t last = gettime();
  uint64_t phase = 0;
  for (;;) {
    uint32_t buttons = poll_buttons();
    uint32_t analog = poll_nunchuk_or_center();
    uint64_t now = gettime();
    phase += diff_ticks(last, now) * 60;
    last = now;
    while (phase >= PPC_TIMER_CLOCK) {
      phase -= PPC_TIMER_CLOCK;
      if (pocket_wii_tick(buttons, analog) != 0) {
        printf("PocketJS tick: %s\n", pocket_wii_last_error());
        goto done;
      }
    }

    begin_gx_frame();
    bind_host_gx_state();
    draw_host_content();
    if (pocket_wii_draw(80, 80, 480, 272) != 0) {
      printf("PocketJS draw: %s\n", pocket_wii_last_error());
      goto done;
    }
    bind_host_gx_state();
    draw_more_host_content();
    present_and_wait_for_vblank();
  }

done:
  pocket_wii_shutdown();
  return 1;
}
```

Call `pocket_wii_tick` once for each elapsed 1/60-second step, not once per video frame. The example's integer phase scheduler produces 60 ticks over a synthetic second at both 50 Hz and 60 Hz presentation rates. It passes the latest sampled input to every due step. A host can call `pocket_wii_draw` once in its current GX frame; **the host owns GX initialization, frame begin/end, framebuffer copy, swap, and vblank.** PocketJS changes GX state while drawing, so bind the host state again before later host drawing. `x`, `y`, `width`, and `height` are GX target pixels; width and height must be nonzero.

The example embeds the package with `xxd -i`; a host may instead load the bytes and pass that buffer. **Keep the package buffer readable and unchanged from a successful `pocket_wii_boot` until `pocket_wii_shutdown`.** One guest may be active. Shutdown is safe with no guest and permits a later boot. Check every nonzero return with `pocket_wii_last_error`; its string remains valid until the next boot, tick, draw, or shutdown call.

## Input mapping

`pocket_wii_tick` accepts the PocketJS button mask and two packed 8-bit axes. Set `analog` to `(x << 8) | y`; each axis is 0–255 and 128 is center. Use `POCKET_WII_ANALOG_CENTER` (`0x8080`) when no supported stick is attached.

The example polls Wii Remotes, attached Nunchuks and Classic Controllers, and GameCube controllers through libogc. It combines held buttons across connected channels:

| PocketJS input | Wii Remote | Nunchuk | Classic Controller | GameCube controller |
| --- | --- | --- | --- | --- |
| Cross | A | — | A | A |
| Circle | B | — | B | B |
| Triangle | 2 | — | Y | Y |
| Square | 1 | — | X | X |
| Select | Minus | — | Minus | — |
| Start | Plus | — | Plus | Start |
| D-pad | D-pad | — | D-pad | D-pad |
| Left trigger | — | Z | ZL or full L | L trigger |
| Right trigger | — | C | ZR or full R | R trigger |
| Analog axes | — | Nunchuk stick | — | — |

The first detected Nunchuk stick supplies both axes. The example uses libogc's per-stick minimum, center, and maximum calibration values to map each axis to 0–255. If no Nunchuk stick is available, it sends `0x8080`. The library does not poll controllers; applications own input polling and mapping.

## Current limits and verification

The renderer check passed in **Dolphin 2606 with Vulkan**. Its Wii fixture covers rectangles, nested clips, transformed alpha images, baked glyphs, and Wii Remote A input; **all ten pixel samples pass in both before-A and after-A captures**. The live hero capture is illustrative and does not replay the Web golden input tape. See the [Wii renderer fixture captures, checker, samples, and golden comparison](check/w25/README.md).

The example reports the video standard and VI/EFB/XFB dimensions at startup, then reports presentation rate, PocketJS tick rate, and WPAD/PAD state every five seconds. It samples newlib `mallinfo()` once per second. Pressing **Wiimote HOME** shuts down and reboots the embedded guest in the same process. For an SD log, create `sd:/apps/wii-pocketjs/` and place `boot.dol` there; the example writes `sd:/apps/wii-pocketjs/wii-host.log`, overwriting it on each launch. **Heap samples exclude GX and video buffers and can miss shorter allocation peaks.**

The corrected DOL booted on a Wii, and its visuals looked good in both **50 Hz and 60 Hz** modes. The initial run showed a red WPAD marker, no apparent response from a GameCube controller in port 1, and no collected SD log; without the later PAD and SD diagnostics, those observations did not confirm input or logging. **Physical input, cadence, heap measurements, SD writes, and HOME shutdown/reboot remain unverified.** Keep `wii-dev` out of the production registry until those checks are recorded.

The supported guest profile is currently `wii-dev` ABI 7, built through `tools/wii.ts`. It does not provide Wii Remote IR input, audio, networking, package updates, an auxiliary display, a compositor surface, or native text. QuickJS Atomics are disabled for this target, and `setPropBatch` is omitted because its current `Float64Array` payload is native-endian; the scalar `setProp` path remains available. The target's advertised capabilities are buttons, left analog input, and baked glyph text.
