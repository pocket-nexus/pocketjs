# ESP-IDF

PocketJS supports ESP32-P4, ESP32-S3, ESP32-C3 and ESP32-C6 through ESP-IDF components.
**One Rust archive owns bundle admission, UI state, frame input encoding and
presentation.** The product registers a guest, package source, input sources
and display outputs. ESP32-P4 can add PPA rendering; S3, C3 and C6 use software
rasterization.

## Components

| Component | Responsibility |
| --- | --- |
| `pocket_runtime` | Runtime archive, host allocation hooks and bundle embedding |
| `pocket_guest_quickjs` | Generated UI bindings and espressif/quickjs-ng 0.14.0 |
| `pocket_display_esp_lcd` | RGB565 strips for SPI/I80 panels with GRAM |
| `pocket_render_esp_ppa` | P4 acceleration with software fallback |
| `pocket_input_touch` | One esp_lcd_touch contact with logical coordinate scaling |
| `pocket_input_gpio` | GPIO and ADC button masks with debounce |
| `pocket_runner` | Optional FreeRTOS task and frame deadlines |

Only `pocket_runner` creates a task. The firmware owns board initialization,
input hardware, panel handles and component lifetimes. RGB/MIPI framebuffer
outputs require a separate display driver.

The components require ESP-IDF `>=6.0,<6.3`. A prebuilt bundle (`.pkb`) requires
Python 3 at the embed step. Compiling an application from source requires Bun
and the Pocket CLI. The default Rust archive can be built from source or
supplied with its build receipt.

## Build the native archive

```sh
bun tools/packaging/esp-idf/native.ts --target esp32p4 --archiver /path/to/llvm-ar
bun tools/packaging/esp-idf/native.ts --target esp32s3 --cargo /path/to/xtensa-rust/bin/cargo
bun tools/packaging/esp-idf/native.ts --target esp32c3
bun tools/packaging/esp-idf/native.ts --target esp32c6
```

The P4 command uses the pinned RISC-V compiler. S3 requires the supplied Xtensa
compiler. The output is `libpocket_idf_runtime.a` under
`platforms/esp-idf/pocket_runtime/lib/<target>/`, beside its receipt.
The archive contains the runtime, software rasterizer and PPA factory. PPA's
IDF hardware callbacks belong to `pocket_render_esp_ppa`.

`POCKETJS_RUST_FROM_SOURCE=ON` enables source builds during IDF configuration.
With source builds disabled, `POCKET_RUNTIME_ARCHIVE` selects a prepared
archive. The receipt identifies compiler, target, source inputs and archive
hash; release staging checks those fields.

For the generic archive without the PPA factory, `pocket sdk export` obtains
a release SDK. `pocket sdk build` compiles it from a source checkout. A program
links one selected archive.

## Embed an application

Add the selected components to the project's component search path. A main
component that uses a prebuilt application can declare:

```cmake
idf_component_register(
    SRCS "main.c"
    INCLUDE_DIRS "."
    REQUIRES pocket_runtime pocket_guest_quickjs pocket_display_esp_lcd)

pocketjs_embed_bundle(
    TARGET ${COMPONENT_LIB}
    NAME dashboard
    BUNDLE "../dashboard.pkb"
    PROFILE_EXPORT_DIR "../profile-export")
```

The firmware root contains `pocket.host.config.ts`, the host config that
names the program's host contract, `pocket.host.json`. Export the host contract
before an offline build:

```sh
pocket host export --config pocket.host.config.ts --out profile-export
```

**The embed step uses Python and prebuilt artifacts; it does not invoke Bun.**
It reads the exported `pocket.host.json`, requires its `hostAbi` stamp to
equal the bundle's binding generation, and admits the bundle's host-input
section by the [admission](/docs/platform-contracts/#admission) rules: raster
density, animation class, rate against the cadences, viewport, presentation
and capabilities. The generated `pocketjs_bundle_dashboard.h` exports the
bundle's storage (`pocketjs_embedded_bundle_t`) and admitted application
geometry (`pocketjs_bundle_host_contract_t`, declared in `pocket/bundle.h`).
`pocket_profile.h` supplies the program's host contract facts, independent of
the bundle.

`pocketjs_compile_app(TARGET <target> NAME <name> [HOST_CONFIG <file>]
[PROJECT_ROOT <directory>] [PROFILE_EXPORT_DIR <directory>]
[COMPILER_RECEIPT <file>] [DEPENDS …])` compiles the `app` section of the
host config for its one host and exports the host contract. `PROJECT_ROOT`
defaults to the config's directory; the plan's entries are relative to it.
`pocketjs_profile_header(TARGET <target> NAME <name>)` exports the host contract
without an application. These two helpers require the Pocket CLI. Their
dependency files track application imports, the font faces `app.fonts` names,
host contracts and host config imports, including new modules learned on a
rebuild.

All three helpers accept `HOST_CONFIG`, defaulting to the project root's
`pocket.host.config.ts`. `PROFILE_EXPORT_DIR` defaults to
`<current-binary-directory>/pocketjs/<name>/profile`. Offline embedding requires
`pocket.host.json` and `pocket_profile.h` to exist there before configuration.

## Register a runtime

**`pocket_runtime_config.profile` points at `pocket_profile.facts`**, the
`pocket_profile_facts` record in the exported `pocket_profile.h`: host id,
cadences, panel sizes, logical viewports, presentations, raster density,
animation class, capability names and the input classes the host contract requires.
The runtime copies the record at creation and reads no JSON.
`pocket_runtime_create` returns `NULL` when the configuration's `tick_hz`
differs from the facts' `tick_hz`, the highest cadence. After boot,
`pocket_runtime_get_timing` reports the application rate, the cadence to schedule
`pocket_runtime_tick` at, and the core ticks each call advances. The CMake helpers add the `pocket_runtime` include directory,
which holds the `pocket_runtime.h` that `pocket_profile.h` includes.

The following setup uses an initialized display adapter. Error handling must
release every object created before a failed registration.

```c
#include "pocket/guest_idf.h"
#include "pocket/package_source.h"
#include "pocket/display_esp_lcd.h"
#include "pocketjs_bundle_dashboard.h"
#include "pocket_profile.h"
#include <string.h>

const pocketjs_bundle_host_contract_t *host =
    &pocketjs_bundle_dashboard_contract;
pocket_runtime_config config = {
    .struct_size = sizeof(config),
    .host_abi = pocket_profile.host_abi,
    .tick_hz = pocket_profile.tick_hz,
    .heap_limit = 4 * 1024 * 1024,
    .frame_buffer_budget = pocket_display_esp_lcd_buffer_bytes(display),
    .profile = pocket_profile.facts,
};
memcpy(config.profile_hash, pocket_profile.profile_hash, 32);
pocket_runtime *runtime = pocket_runtime_create(&config);

pocket_guest_idf_config guest_config = {
    .heap_limit = 4 * 1024 * 1024,
    .stack_limit = 256 * 1024,
    .prefer_psram = true,
};
pocket_guest_idf *guest = pocket_guest_idf_create(&guest_config);
pocket_memory_package package = {
    pocketjs_bundle_dashboard.data,
    pocketjs_bundle_dashboard.size,
};
```

The runtime reads the bundle in place, so the bytes stay unchanged until the
runtime is destroyed. A program that verified the bundle itself, through
`pocket_idf_package_open`, sets `.flags = POCKET_MEMORY_PACKAGE_VERIFIED` and
the runtime admits it without a second hash pass.

**`pocket/package_facts.h` admits an application before boot.**
`pocket_idf_package_open` takes a bundle in memory;
`pocket_idf_package_open_source` takes a `pocket_package_source_v1` and its
context and admits what the source holds, a bundle or the sections its
`sections` callback states, through the path boot takes. Both fill
`pocket_idf_package_facts`, a record whose `struct_size` the caller sets: the
JavaScript, pak and plan sections, the app id (`app_id`, `app_id_length`,
UTF-8 without a terminator), the plan's viewport, auxiliary surface and raster
density, and the bundle's footer and payload hashes (`package_hash`,
`payload_hash`, zero for stated sections). For stated sections the app id is
the plan's `app.id`. The source form never calls `take`, so the same source
boots the program afterwards. A source without an `all` callback is read into
memory the call releases; the four pointers are then `NULL` with their lengths
set.

**`pocket_idf_package_feature` reads one feature of the plan by its id
string**, a registered id or one the host contract defines:

```c
bool files = false;
if (pocket_idf_package_feature(&facts, "data.fs", &files) == POCKET_PACKAGE_OPEN_OK && files) {
  /* mount the application's file tree */
}
```

It writes `true` when the plan's `features.<name>` is `true` and `false` when
it is `false` or absent, and returns `POCKET_PACKAGE_OPEN_BAD_ARGUMENT` for a
record whose `plan` is `NULL`. A program that keeps per-application state
names it from the app id; the record carries no store layout.

Check creation results, then check each registration result against
`POCKET_STATUS_OK`:

```c
pocket_runtime_set_package_source(runtime, pocket_memory_package_vtable(), &package);
pocket_runtime_set_guest(runtime, pocket_guest_idf_vtable(), guest);
pocket_runtime_add_display(runtime, pocket_display_esp_lcd_vtable(), display,
                           POCKET_RENDERER_SOFTWARE);
```

Register each input device with `pocket_runtime_add_input_source`. Its
`pocket_input_source_v1` declares input classes and contributes device facts
during polling. Every input class required by the host contract must be present.
The runtime resolves contact hits and encodes the guest frame arguments.

`pocket_runtime_boot` validates the bundle, installs its assets, evaluates the
guest and presents the initial tree. A bundle built for a host contract that
names `esp-idf-quickjs-ng-0.14.0` under `bytecode.engine` carries its scripts
as that engine's serialized objects, which the guest reads instead of parsing
source (docs/PLATFORM.md, "Bytecode"). The baked font atlases of a bundle the
runtime reads in place stay in the bundle: their coverage cells are read from
flash or PSRAM where they are, and a slot is copied only when a streaming font
writes into it. Its images and sprites are decoded into PSRAM when first drawn;
`pocket_runtime_set_texture_budget` bounds the decoded bytes kept past a frame,
releasing the least recently drawn textures beyond it until a frame draws them
again. `pocket_runtime_tick` runs one guest frame,
advances the core by the application rate divided by the cadence, and presents. A returned display or renderer failure has
terminated all device access for that frame. A guest failure stops further
turns; read `pocket_guest_idf_error` for engine diagnostics.

## Displays and PPA

Create `pocket_display_esp_lcd` after configuring the panel for RGB565.
Its configuration accepts panel and IO handles, dimensions, strip rows,
buffer count, byte order and a pixel-buffer budget.
**The budget counts both DMA buffers.** The driver allocates no full-frame
scratch buffer. With two strips, the coordinator can render into one while
DMA reads the other. **Each buffer's wait ends when the panel IO has reported
that buffer's own transfers complete**, through `on_color_trans_done`; the
other buffer's transfer keeps streaming. A wait longer than 1000 ms returns
`POCKET_STATUS_FAILED` and keeps that buffer reserved until its transfer
lands.

The display reports panel identity and generation to retain damage history.
Call `pocket_display_esp_lcd_invalidate` after a panel reset or external write,
while no runtime call is active. It drains pending transfers and makes the
next frame repaint the panel. The driver must have exclusive use of color
transfers on its panel IO and owns the IO's color-transfer callback.

On P4, create the hardware device with `pocketjs_esp32p4_ppa_create`, pass its
status operations to `pocket_render_esp_ppa_create`, and register the returned
renderer with `pocket_runtime_add_renderer`. Use that renderer ID when adding
the display. The smoke example contains the complete setup.

PPA handles supported fills, glyph coverage and RGB565 transfers. An
unsupported operation, or a transaction the IDF driver rejects, falls back to
software before hardware writes; the first rejection per operation is logged
with its IDF error name. **A strip whose address or byte length is not a
multiple of the DMA cache line renders in software.** Each strip repaints the
frame's damage rectangles and no other pixels. The A8 mask staging budget is
separate from display pixel storage.

## Scheduling and destruction

A product can call `pocket_runtime_tick` from its owner task at the cadence
`pocket_runtime_get_timing` reports. The optional `pocket_runner_start` takes
the booted runtime, the task configuration and an output pointer; it schedules
ticks at that cadence with the shared rational-microsecond schedule. Falling behind can skip wall
clock slots without inventing guest frames.

Set the runner's interrupt callback to `pocket_guest_idf_interrupt` through a
`void *` wrapper. `pocket_runner_stop` interrupts the guest, wakes the owner and
joins it. A timeout retains the runner and its contexts; retry stop before
releasing them.

After the task has joined:

1. Destroy the runtime with `pocket_runtime_destroy`.
2. Destroy the guest with `pocket_guest_idf_destroy`.
3. Destroy any PPA renderer, then its hardware device.
4. Destroy the display adapter, then the product's panel and IO handles.

The generated guest protects borrowed PAK bytes using the verified QuickJS
immutable-buffer patch. Bundle storage remains live until guest shutdown.
The bundle and JavaScript heap limits do not bound all native allocations;
display buffers and accelerator staging have their own budgets.

## Native AOT applications

**The components on this page boot bundles; `pocket_runtime.h` has
no entry for a compiled application.** `pocket_runtime_boot` and
`pocket_runtime_boot_deferred` admit a package source. An application compiled
by [MicroTS](/docs/microts/) links into the firmware as a Rust static library
that the product owns. That library drives `pocket_runtime::Runtime` through
its Rust API, and the product's repository holds every file of it.

The library crate:

- uses `no_std` with `alloc`, and depends on `microts` with the `runtime`
  feature, `pocket-runtime`, `pocket-drivers` and `pocket-raster`;
- includes the generated `include.rs`, which declares `mod generated`,
  `TICK_HZ`, `load_fonts`, `load_images`, `load_fonts_in_place` and
  `load_images_in_place`;
- implements `microts::runtime::AotApp`: `mount` loads `styles.bin`, the fonts
  and the images and constructs the generated `AppApp`; `frame` converts a
  `GuestFrame` into `microts::Input` and leaves `Input::now_ms` at its default,
  which the generated `frame` replaces with the model-clock time that
  `ActionHandler` holds read;
- registers an `AotGuest`, its input sources, `pocket_raster::RasterRenderer`
  and a `DisplayOutput`, then calls `Runtime::boot_aot_deferred` with the
  exported `PROFILE_HASH`, the viewport and `TICK_HZ`;
- defines the global allocator over the IDF heap, the panic handler and the
  `extern "C"` functions its C caller uses.

[`programs/ipodnano/src/lib.rs`](https://github.com/pocket-nexus/pocketjs/blob/main/programs/ipodnano/src/lib.rs)
is a complete library of this shape for the iPod nano's Rockbox firmware.
**The C display and input components register through `pocket_runtime.h`**,
so an AOT library supplies Rust implementations of `DisplayOutput` and
`InputSource` from `pocket-drivers`.

### Build the library

The host config declares an `aot` recipe. `pocket build` checks the generated
sources against the host contract, exports the profile and runs Cargo with
`POCKETJS_AOT_DIR`, `POCKETJS_AOT_INCLUDE` and `POCKETJS_PROFILE_RS` set:

```ts
// pocket.host.config.ts
import { cargo, defineHostConfig } from "@pocketjs/framework/host-config";

export default defineHostConfig({
  host: "./pocket.host.json",
  app: {
    entry: "app/App.tsx",
    framework: "solid",
    viewport: { logical: [320, 240], presentation: "native" },
    features: ["input.buttons", "text.glyphs.baked"],
    aot: true,
  },
  build: {
    hosts: ["darwin-arm64", "linux-x64"],
    input: "aot",
    steps: cargo({
      manifest: "firmware/Cargo.toml",
      target: "riscv32imafc-unknown-none-elf",
      targetDirectory: "{outdir}/cargo",
    }),
    artifact: "{outdir}/cargo/riscv32imafc-unknown-none-elf/release/libfirmware.a",
  },
});
```

```sh
pocket compile --config pocket.host.config.ts --aot --out dist/aot
pocket build --config pocket.host.config.ts --aot-dir dist/aot --out dist/build
```

Without `--aot-dir`, `pocket build` runs the AOT compile of the config's `app`
section itself before the recipe.

The AOT compile reads the layout oracle `platforms/web/pocketjs.wasm` from
PocketJS. The npm package ships it; a project that pins PocketJS as a Git
submodule runs `bun tools/wasm.ts` in the submodule before the first compile
(needs `rustup target add wasm32-unknown-unknown`). See
[AOT source generation](/docs/cli/#aot-source-generation).

The crate's `build.rs` calls `pocket_profile_build::emit`, which copies the
exported profile to `OUT_DIR/pocket_profile.rs`. The library includes that
file and `$POCKETJS_AOT_DIR/include.rs`. **The Cargo step passes `--locked`**:
commit the crate's `Cargo.lock`. A `toolchain` field on the step names the
rustup toolchain that has the target installed.

The IDF component that calls the library imports the archive and keeps the
hooks the archive calls back into:

```cmake
add_library(firmware STATIC IMPORTED GLOBAL)
set_target_properties(firmware PROPERTIES IMPORTED_LOCATION "${FIRMWARE_ARCHIVE}")
target_link_libraries(${COMPONENT_LIB} PUBLIC firmware)
target_link_options(${COMPONENT_LIB} INTERFACE
    "-Wl,--undefined=firmware_alloc" "-Wl,--undefined=firmware_free"
    "-Wl,--undefined=firmware_panic")
```

An application project outside a framework checkout declares
`@pocketjs/framework` and `solid-js` or `vue` in its own `package.json`, as
`pocket create` writes them. AOT analysis resolves the view framework and
framework subpaths such as `@pocketjs/framework/animation` through the
project's `node_modules`; a missing package fails with `Cannot find module`.

### Targets

| IDF target | Rust target | Requirement |
| --- | --- | --- |
| `esp32p4` | `riscv32imafc-unknown-none-elf` | Remove the soft-float compiler-rt members from the archive |
| `esp32c6` | `riscv32imac-unknown-none-elf` | None |
| `esp32c3` | `riscv32imc-unknown-none-elf` | Select an atomic compare-and-swap fallback |
| `esp32s3` | `xtensa-esp32s3-none-elf` | Espressif's Rust toolchain with `buildStd: ["core", "alloc"]` |

**A `riscv32imafc` static library carries compiler-rt objects built for the
soft-float ABI; IDF's ESP32-P4 objects use `ilp32f`.** IDF's libgcc and ROM
supply the same symbols, and the linker rejects a soft-float object that it
extracts into an `ilp32f` link.
`platforms/esp-idf/pocket_runtime/prepare_archive.cmake` deletes those archive
members; run it with `-DPOCKETJS_ARCHIVE`, `-DPOCKETJS_ARCHIVER` and
`-DPOCKETJS_TARGET=esp32p4` before the IDF link.

**`riscv32imc` has no atomic compare-and-swap instruction.** `portable-atomic`
stops the build with `dependents require atomic CAS but not available on this
target by default`. The library enables the `critical-section` feature of
`microts` and provides a `critical_section::Impl`, or sets the
`portable_atomic_unsafe_assume_single_core` cfg in its rustflags. The
`microts` crate documentation states the requirements of each choice.

### Memory and stack

**IDF's main task stack defaults to 3584 bytes**
(`CONFIG_ESP_MAIN_TASK_STACK_SIZE`). The iPod nano program gives its Runtime
128 KiB because an 8 KiB stack did not hold a layout solve. Create a task with
its own stack for the Runtime.

**The generated `load_fonts` and `load_images` copy their data into the
heap; `load_fonts_in_place` and `load_images_in_place` read it from flash.**
Both pairs take `&mut microts::Ui`, and `mount` calls one of them.
`load_fonts` parses each atlas into an owned buffer with `load_font_atlas`
and `load_images` copies each image's pixels with `upload_img_entry`, while
the `include_bytes!` originals stay in flash. `load_fonts_in_place` passes
each atlas to `load_font_atlas_shared`, which reads the coverage cells from
the `include_bytes!` data. `load_images_in_place` passes each image to
`upload_img_entry_from`: **a texture's pixels are copied into the heap when a
frame first draws it**, and `set_texture_budget` releases textures beyond the
budget that the previous frame did not draw. Reading flash costs more per
access than reading internal RAM. On the host, an application with 119,952
bytes of atlases and one 128 × 128 RGBA image held 186,408 heap bytes after
the copying pair and 3,400 after the in-place pair; its first frame added the
image's 65,536 bytes. A `DisplayOutput` that keeps a full frame, as
the iPod nano program's does, holds two bytes per RGB565 pixel: 153,600 bytes
at 320 × 240.

**The image embeds the application.** A changed view or model is a new
firmware image; an AOT guest rejects a bundle's JavaScript payload.

**The repository contains no ESP32 AOT program and no CI job for this path.**
Device timing, pixels and input are the product's acceptance checks.
[M5Stack firmware](#m5stack-firmware) holds AOT programs for ESP32-P4 and
ESP32-S3 boards.

## M5Stack firmware

[pocket-nexus/m5stack-firmware](https://github.com/pocket-nexus/m5stack-firmware)
is the reference firmware for M5Stack boards. **Each application is one set of
Solid TSX views and TypeScript models that builds in JS mode (a bundle in the
QuickJS guest) and in AOT mode (MicroTS-generated Rust, no JavaScript
engine).** Kconfig selects the mode: `CONFIG_M5_POCKET_APP_MODE_JS` or
`CONFIG_M5_POCKET_APP_MODE_AOT`.

| Board | SoC | Display | Application | Modes |
| --- | --- | --- | --- | --- |
| Tab5 | ESP32-P4, 32 MB PSRAM | 720×1280 MIPI-DSI, touch | Factory demo recreation | JS, AOT |
| StopWatch (C152) | ESP32-S3, 8 MB PSRAM | 466×466 round AMOLED, touch | Factory demo recreation | JS, AOT |
| StickS3 (K150) | ESP32-S3, 8 MB PSRAM | 135×240 IPS | Seven sensor, key and audio demos | JS, AOT |
| AtomS3, AtomS3R | ESP32-S3, no PSRAM used | 128×128 IPS | Factory demo recreation | AOT |

**The AtomS3 builds AOT mode only: with 512 KB of SRAM and no PSRAM, it runs
out of internal RAM while the QuickJS guest boots.**

The repository's layers map onto this page:

| Path | Responsibility |
| --- | --- |
| `platforms/esp-idf/m5_bsp_<board>` | Power, buses, panel, touch, keys, sensors and audio; returns ESP-IDF handles and does not depend on PocketJS |
| `platforms/esp-idf/m5_pocket_app` | Display and input drivers over those handles, the frame task, and a device bridge that carries named values and string requests between `main` and the application's `device.ts` |
| `programs/<board>/main` | Board bring-up, sensor publishing and request handling |
| `programs/<board>/aot` | The AOT library crate described in [Native AOT applications](#native-aot-applications) |
| `third_party/pocketjs` | PocketJS as a git submodule; the firmware builds the runtime archive from its sources |

Each [release](https://github.com/pocket-nexus/m5stack-firmware/releases)
ships one merged flash image per board and mode, written at offset `0x0` with
esptool. The repository's README lists the toolchain versions, the build and
flash commands for both modes, image sizes per mode and the known differences
from the factory firmware.

## Validation

The `smoke` and `runner` examples compile for both targets. Their transfer-hash
sink exercises runtime registration and strip output; it does not initialize
a physical panel. Host regressions cover bundle admission, immutable buffers,
promise errors, two pending DMA buffers, per-buffer waits, terminal drain,
the bounded wait timeout and software pixel parity. Final device acceptance
must exercise the product's panel, input sources, PPA output, reset recovery
and task stop/join behavior.
