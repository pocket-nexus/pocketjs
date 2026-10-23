# keyos

The PocketJS UI runtime on **Foundation's Passport Prime**, a 480×800 touch
device running KeyOS (a Xous microkernel) on one Cortex-A5. The `passport-prime`
target (`tools/passport-prime-profile.ts`) gives an app a **480×760 logical
surface at density 1**: gui-server draws the collapsed Control Center over the
top 40 rows of the panel.

| Directory | Contents |
| --- | --- |
| `runtime/` | `pocketjs-keyos-runtime`: the QuickJS guest (`pocket-mod`), the `ui` surface (`pocket-ui-surface`), the touch contact latch, damage planning, band painting (`Runtime::paint_rows`), and the presenter that decides which regions a lent framebuffer needs. It has no KeyOS SDK dependency. |
| `app/` | The KeyOS app crate: gui-server registration, input messages, the lent-framebuffer loop. `tools/keyos.ts` writes its `app-config.toml` and `gen/` for the selected app. |
| `libc/` | The C library QuickJS links against on `armv7a-unknown-xous-elf`, where Rust's std is the only runtime: headers, and `libc.c` for string search, formatted output, `strtod` and the math functions `compiler_builtins` omits. `runtime/src/libc.rs` exports the allocator and the clocks. |

## Frame loop

1. The app registers a full-screen window and calls `request_redraw`.
   gui-server answers with an `InputMessage::FrameBuffer`: a lent 480×800
   BGRA buffer, **at most 40 per second** (`gui_server_api::consts::FPS`).
2. One runtime step per lent buffer: the guest turn with the latched touch
   contacts, the core tick, the DrawList and its damage against the previous
   one. The bundle bakes **40 Hz virtual time** to match.
3. gui-server rotates its buffers and the app cannot identify the one it
   holds, so the presenter names the **damage of the last 8 frames** as
   disjoint rectangles. A buffer gui-server marks as new, and the 8
   presentations after the app becomes visible, get the whole surface.
4. The app paints those rectangles in **32-row bands straight into the lent
   buffer** at row 40 (`raster::render_scaled_argb_rows`). Each band starts at
   the latest op from which opaque rects cover it, so the clear and the layers
   underneath are skipped. The rows written are cleaned from the data cache,
   and the buffer goes back with `submit_frame`.

Touches arrive as Press, Drag and Release messages in panel coordinates. The
contact latch (`runtime/src/contacts.rs`, the Rust form of
`hosts/shared/contact_latch.h`) keeps a tap that starts and ends between two
guest turns in one sample, and assigns each press a fresh 8-bit id. Contacts go
to the guest in the wide wire form (10 bits per axis), since 760 rows exceed
the legacy 9-bit form.

### Memory on Passport Prime

Measured on the device for one 480×760 surface (1.46 MB):

| Operation | Lent framebuffer | App heap |
| --- | --- | --- |
| Fill | 5.5 ms | 12.1 ms |
| Read | 5.4 ms | 10.4 ms |
| Blend (read and write) | 15.3 ms | 27.1 ms |

A band painted three times costs three fills: overdraw is paid in memory
bandwidth, not absorbed by the cache. The app therefore writes every pixel
once, straight into the lent buffer, with no staging copy.

### Garbage collection

QuickJS's cycle collector visits every object: **1.3 s for Pocket Clear's
105,000 objects**. The runtime boots under a 16 MB collection threshold,
then lets the heap grow by 8 MB beyond what boot leaves before a guest turn
collects, and the app collects while gui-server hides it.

## QuickJS without a C library

The device build compiles QuickJS (from `rquickjs-sys`) and `libc/libc.c` with
Apple's clang for `armv7a-none-eabihf` (Thumb-2, NEON, hard float, PIC),
scheduled for the Cortex-A5, against `libc/include` only (`-nostdinc`). `__STDC_NO_ATOMICS__` removes
Atomics and its threads. rquickjs generates its bindings with bindgen against
the same headers. `tools/keyos.ts` sets `CC_`, `CFLAGS_`, `AR_` and
`BINDGEN_EXTRA_CLANG_ARGS_` for the target, and `POCKET_KEYOS_QUICKJS_INCLUDE`
for the shim's `dtoa.h`.

`foundation sim` builds the dev profile; `app/Cargo.toml` builds every
dependency at `opt-level = 3`, because QuickJS at `-O0` overflows its C stack
limit while Pocket Clear boots.

## Commands

```sh
bun tools/keyos.ts preview                 # headless frames → dist/passport-prime/preview
bun tools/keyos.ts sim                     # the Foundation simulator
bun tools/keyos.ts build --release         # signed bundle in hosts/keyos/app/target/keyos/
bun tools/keyos.ts sideload --release      # upload over USB and launch
bun tools/keyos.ts pack --release          # one .app file to install from Settings
```

`--manifest=PATH` selects the app; the default is
`apps/clear/pocket.passport-prime.json`. `preview` takes the actions of
`runtime/examples/preview.rs` (`--tap=X,Y`, `--drag=X0,Y0,X1,Y1,N`,
`--wait=N`, `--shot=NAME`). The KeyOS app id is the first 16 bytes of
`sha256("pocketjs:" + app id)`, so two PocketJS apps install side by side.

### Toolchain

- **Foundation SDK 1.1.0** in `~/.foundation/sdk`
  (`curl -sSfL https://sdk.foundation.xyz/latest/install.sh | bash`).
  `tools/keyos.ts` links `app/.foundation-sdk/current` to it.
- **Rust `nightly-2026-04-11`** with `rust-src` and `llvm-tools` (for
  `llvm-ar`), plus the `armv7a-unknown-xous-elf` sysroot. The SDK's Nix shell
  (`foundation develop`) provides both. Without Nix, install the toolchain with
  rustup, copy `lib/rustlib/armv7a-unknown-xous-elf` from Foundation's
  [rust-keyos release](https://github.com/Foundation-Devices/rust-keyos/releases/download/1.96.0-nightly-2026-04-11/armv7a-unknown-xous-elf_nightly-2026-04-11.zip)
  into the toolchain's `lib/rustlib/`, put `arm-none-eabi-strip` on `PATH`,
  and run the commands with `FOUNDATION_DEVELOP_SHELL=1`.
- **A signing identity** for `build`, `sideload` and `pack`:
  `foundation cert gen <name> --publisher-name … --contact-email …`, then
  `foundation cert install <name>` once per device (Developer Mode on, the
  device unlocked; the device asks to allow the publisher). Set
  `FOUNDATION_SIGNING_IDENTITY=<name>` to write it into `app-config.toml`.

## Device tools

`~/.foundation/sdk/current/bin/foundation-passport-drive` takes screenshots
(`screenshot -o FILE`), taps (`tap X Y`), swipes, streams logs (`logs`), lists
processes and closes or launches apps by PID or app id. Add `--sim` to drive
the simulator. The app logs its frame rate and per-phase times every 5 s.
