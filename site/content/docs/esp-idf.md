# ESP-IDF

PocketJS supports ESP32-P4, ESP32-S3, ESP32-C3 and ESP32-C6 through ESP-IDF components.
**One Rust archive owns package admission, UI state, frame input encoding and
presentation.** The product registers a guest, package source, input sources
and display outputs. ESP32-P4 can add PPA rendering; S3, C3 and C6 use software
rasterization.

## Components

| Component | Responsibility |
| --- | --- |
| `pocket_runtime` | Runtime archive, host allocation hooks and package embedding |
| `pocket_guest_quickjs` | Generated UI bindings and espressif/quickjs-ng 0.14.0 |
| `pocket_display_esp_lcd` | RGB565 strips for SPI/I80 panels with GRAM |
| `pocket_render_esp_ppa` | P4 acceleration with software fallback |
| `pocket_input_touch` | One esp_lcd_touch contact with logical coordinate scaling |
| `pocket_input_gpio` | GPIO and ADC button masks with debounce |
| `pocket_runner` | Optional FreeRTOS task and frame deadlines |

Only `pocket_runner` creates a task. The firmware owns board initialization,
input hardware, panel handles and component lifetimes. RGB/MIPI framebuffer
outputs require a separate display driver.

The components require ESP-IDF `>=6.0,<6.3`. A prebuilt `.pocket` requires
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

pocketjs_embed_package(
    TARGET ${COMPONENT_LIB}
    NAME dashboard
    PACKAGE "../dashboard.pocket"
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
equal the package's binding generation, and admits the package's host-input
variant by the [admission](/docs/platform-contracts/#admission) rules: raster
density, animation class, rate against the cadences, viewport, presentation
and capabilities. The generated `pocketjs_package_dashboard.h` exports package
storage and admitted application geometry. `pocket_profile.h` supplies the
program's host contract facts, independent of the package.

`pocketjs_compile_app(TARGET <target> NAME <name> MANIFEST <pocket.app.json>)`
compiles an application and exports the host contract.
`pocketjs_profile_header(TARGET <target> NAME <name>)` exports the host contract
without an application. These two helpers require the Pocket CLI. Their
dependency files track application imports, host contracts and host config
imports, including new modules learned on a rebuild.

All three helpers accept `HOST_CONFIG`, defaulting to the project root's
`pocket.host.config.ts`. `PROFILE_EXPORT_DIR` defaults to
`<current-binary-directory>/pocketjs/<name>/profile`. Offline embedding requires
`pocket.host.json` and `pocket_profile.h` to exist there before configuration.

## Register a runtime

**`pocket_runtime_config.profile` points at `pocket_profile.facts`**, the
`pocket_profile_facts` record in the exported `pocket_profile.h`: variant id,
cadences, panel sizes, logical viewports, presentations, raster density,
animation class, capability names and the input classes the host contract requires.
The runtime copies the record at creation and reads no JSON.
`pocket_runtime_create` returns `NULL` when the configuration's `tick_hz`
differs from the facts' `tick_hz`, the highest cadence. After boot,
`pocket_runtime_get_timing` reports the package rate, the cadence to schedule
`pocket_runtime_tick` at, and the core ticks each call advances. The CMake helpers add the `pocket_runtime` include directory,
which holds the `pocket_runtime.h` that `pocket_profile.h` includes.

The following setup uses an initialized display adapter. Error handling must
release every object created before a failed registration.

```c
#include "pocket/guest_idf.h"
#include "pocket/package_source.h"
#include "pocket/display_esp_lcd.h"
#include "pocketjs_package_dashboard.h"
#include "pocket_profile.h"
#include <string.h>

const pocketjs_package_host_contract_t *host =
    &pocketjs_package_dashboard_contract;
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
    pocketjs_package_dashboard.data,
    pocketjs_package_dashboard.size,
};
```

The runtime reads the package in place, so the bytes stay unchanged until the
runtime is destroyed. A program that verified the package itself, through
`pocket_idf_package_open`, sets `.flags = POCKET_MEMORY_PACKAGE_VERIFIED` and
the runtime admits it without a second hash pass.

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

`pocket_runtime_boot` validates the package, installs its assets, evaluates the
guest and presents the initial tree. A package built for a host contract that
names `esp-idf-quickjs-ng-0.14.0` under `bytecode.engine` carries its bundles
as that engine's serialized objects, which the guest reads instead of parsing
source (docs/PLATFORM.md, "Bytecode"). The baked font atlases of a package the
runtime reads in place stay in the package: their coverage cells are read from
flash or PSRAM where they are, and a slot is copied only when a streaming font
writes into it. `pocket_runtime_tick` runs one guest frame,
advances the core by the package rate divided by the cadence, and presents. A returned display or renderer failure has
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
immutable-buffer patch. Package storage remains live until guest shutdown.
The package and JavaScript heap limits do not bound all native allocations;
display buffers and accelerator staging have their own budgets.

## Validation

The `smoke` and `runner` examples compile for both targets. Their transfer-hash
sink exercises runtime registration and strip output; it does not initialize
a physical panel. Host regressions cover package admission, immutable buffers,
promise errors, two pending DMA buffers, per-buffer waits, terminal drain,
the bounded wait timeout and software pixel parity. Final device acceptance
must exercise the product's panel, input sources, PPA output, reset recovery
and task stop/join behavior.
