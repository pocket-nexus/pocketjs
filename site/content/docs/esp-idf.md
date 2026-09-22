# ESP-IDF

PocketJS supports ESP32-P4 and ESP32-S3 as ESP-IDF components. **The six base
components do not own the firmware task, input drivers, display controller,
physical buffers, or presentation.** A product selects the components it
needs and calls them from its native code. The optional runner is the only
component that creates an owner task.

## Requirements

| Input | Requirement |
| --- | --- |
| ESP-IDF | `>=6.0,<6.2` |
| JavaScript engine | `espressif/quickjs-ng` 0.14.0, pulled by `pocketjs_guest` |
| Prebuilt `.pocket` | Python 3 for the embed step; no Bun and no `pocket` CLI during `idf.py build` |
| Source application | Installed `pocket` CLI and Bun |
| Native core | Prebuilt in Registry releases; Rust is optional for consumers |

P4 and S3 share the same package, guest, UI, and renderer interfaces. P4 may
add PPA acceleration. S3 executes the complete RGB565 software path.

## Components

```text
pocketjs_package
pocketjs_guest -> quickjs-ng
pocketjs_ui_core
pocketjs_ui_qjs -> pocketjs_guest + pocketjs_ui_core
pocketjs_render_rgb565 -> pocketjs_ui_core
pocketjs_esp32p4_ppa -> pocketjs_render_rgb565 + esp_driver_ppa
pocketjs_runner -> pocketjs_ui_qjs
```

For an S3 UI, declare `pocketjs_package`, `pocketjs_ui_qjs`, and
`pocketjs_render_rgb565`. For P4, replace the renderer leaf with
`pocketjs_esp32p4_ppa`; it pulls in the renderer. Add `pocketjs_runner` only
when the library should create the owner task.

## Host profile

Each firmware repository owns a `pocket.host.json`. It records the display and
input contract implemented by that product:

```json
{
  "$schema": "https://pocketjs.dev/schema/pocket-idf-host-1.json",
  "version": 1,
  "id": "idf-smoke",
  "platform": "esp-idf",
  "form": "takeover",
  "tickHz": 60,
  "display": {
    "physicalViewport": [320, 240],
    "logicalViewports": [[320, 240]],
    "presentations": ["native"],
    "rasterDensity": 1
  },
  "capabilities": ["input.buttons", "text.glyphs.baked"]
}
```

`id` occupies at most 15 UTF-8 bytes because it is stored in the `.pocket`
variant table. Capabilities describe framework APIs that the firmware
delivers. A GPIO, touch controller, or analog device does not belong in this
file unless the native host converts it into the corresponding PocketJS input
contract. **A profile that advertises `input.touch` is limited to 512×512
logical viewports because each frame carries 9-bit logical coordinates.**

The build hashes the canonical profile. Device admission rejects a package
whose target, HostOps ABI, tick rate, viewport, density, presentation, or
profile hash differs from the compiled host contract.

## Build an application package

### Prebuilt package

Build outside ESP-IDF:

```sh
pocket build \
  --manifest app/pocket.json \
  --host-profile firmware/pocket.host.json \
  --project-root app \
  --outdir dist \
  --output dist/dashboard.pocket
```

Embed the result from the consumer component after
`idf_component_register`:

```cmake
pocketjs_embed_package(
    TARGET ${COMPONENT_LIB}
    NAME dashboard
    PACKAGE "${CMAKE_SOURCE_DIR}/app/dist/dashboard.pocket"
    HOST_PROFILE "${CMAKE_SOURCE_DIR}/firmware/pocket.host.json"
)
```

The generated `pocketjs_package_dashboard.h` exports the borrowed package
bytes and the host contract extracted from its binary host-input section.
During `idf.py build` this path runs one tool: `project_include.cmake` resolves
the IDF `PYTHON` interpreter (or `python3`/`python` from `PATH`) and runs the
component's `tools/embed_package.py`, which turns the `.pocket` file and the
host profile into the generated `.h`, `.c`, and `.S`. **Neither Bun nor the
`pocket` CLI runs**, and the native core and renderer link from the prebuilt
archives unless `POCKETJS_RUST_FROM_SOURCE=ON`.

### Compile from the IDF build

The optional helper invokes an installed PocketJS CLI:

```cmake
pocketjs_compile_app(
    TARGET ${COMPONENT_LIB}
    NAME dashboard
    MANIFEST "${CMAKE_SOURCE_DIR}/app/pocket.json"
    HOST_PROFILE "${CMAKE_SOURCE_DIR}/firmware/pocket.host.json"
    PROJECT_ROOT "${CMAKE_SOURCE_DIR}/app"
)
```

The helper never installs Bun, Node packages, or Rust. A missing `pocket`
executable is a configuration error. Generated JS, PAK, package, C, and
assembly files stay under the IDF build directory.

**The compiler emits a depfile from the bundler graph and resource reads.**
Ninja tracks imported modules, images, fonts, configuration, the host profile,
and compiler inputs. Adding an imported module does not require reconfigure.
`COMPILER_RECEIPT` adds a product-owned toolchain receipt as a dependency;
`DEPENDS` lists additional inputs read by custom build steps.

## Package

Open and select the embedded package before creating the guest:

```c
pocketjs_package_t *package = NULL;
ESP_ERROR_CHECK(pocketjs_package_open(
    pocketjs_package_dashboard.data,
    pocketjs_package_dashboard.size,
    0,
    &package));

pocketjs_package_variant_t app = {
    .struct_size = sizeof(app),
};
ESP_ERROR_CHECK(pocketjs_package_select(
    package,
    &pocketjs_package_dashboard_contract,
    &app));
```

Package, JS, PAK, and plan spans point into the caller-owned source bytes.
Keep those bytes readable until the guest, binding, and package handle have
been destroyed. Storage may be embedded flash, an mmap-capable partition, or
another product-owned source.

**The PAK ArrayBuffer exposed to JavaScript is immutable and still borrows
the source bytes.** No complete PAK copy is allocated in the JS heap.
`pakGet()` returns a writable copy of the requested entry. Native code must
keep the borrowed package readable and unchanged for its documented lifetime.

## Guest

`pocketjs_guest` creates one QuickJS runtime and context. It evaluates an IIFE,
calls `globalThis.frame` once per turn, and drains pending Promise jobs. It has
no UI until a surface is mounted.

```c
pocketjs_guest_config_t config;
pocketjs_guest_config_defaults(&config);
config.prefer_psram = true;

pocketjs_guest_t *guest = NULL;
ESP_ERROR_CHECK(pocketjs_guest_create(&config, &guest));
```

Set `CONFIG_POCKETJS_GUEST_HEAP_LIMIT` in `menuconfig` under
`Component config → PocketJS guest → Default JavaScript heap limit (bytes)`.
**The default is 4194304 bytes (4 MiB) per guest.**
`pocketjs_guest_config_defaults()` copies this value into `config.heap_limit`.
Assign `config.heap_limit` before `pocketjs_guest_create()` to override the
default for that guest.

**The limit is a QuickJS allocation budget.** Reserve memory for native
allocations, display buffers, and allocator overhead. It does not represent
total PSRAM usage or set the garbage collector's trigger threshold.

`pocketjs/guest_quickjs.h` exposes a version-pinned `JSContext *` only for
native surface and extension code. Application hosts that do not install raw
QuickJS functions include `pocketjs/guest.h` instead.

## UI core

The UI core is independent from QuickJS and the RGB565 renderer:

```c
pocketjs_ui_core_config_t config;
pocketjs_ui_core_config_defaults(&config);
config.logical_width = contract.logical_width;
config.logical_height = contract.logical_height;
config.raster_density = contract.raster_density;
config.tick_hz = contract.tick_hz;

pocketjs_ui_core_t *core = NULL;
ESP_ERROR_CHECK(pocketjs_ui_core_create(&config, &core));
```

Native firmware can call the tree mutation API directly without creating a
guest. A `pocketjs_ui_frame_view_t` borrows the latest DrawList and resource
state. **Its pointers expire on the next draw, mutation, or tick.** Its epoch
is a borrow generation, not a snapshot or a logical-state revision.

## UI QuickJS binding

Create the binding with caller-owned guest and core handles, feed its PAK, then
mount before bundle evaluation. **The binding derives viewport and tick rate
from the core; its own config carries only target id and HostOps ABI.**

PAK loading validates and stages resources before committing them to the
core. A returned error leaves the core and binding unchanged and permits a
retry. Successfully installed resources belong to the core.

One guest accepts one UI binding. UI functions capture that binding in native
closures; they do not use the QuickJS context opaque slot. Other native
extensions can coexist in the same guest.

```c
const pocketjs_ui_qjs_config_t binding_config = {
    .struct_size = sizeof(binding_config),
    .target_id = pocketjs_package_dashboard_contract.target_id,
    .host_abi = pocketjs_package_dashboard_contract.host_abi,
};
pocketjs_ui_qjs_t *binding = NULL;
ESP_ERROR_CHECK(
    pocketjs_ui_qjs_create(guest, core, &binding_config, &binding));

ESP_ERROR_CHECK(pocketjs_ui_qjs_feed_pak(binding, app.pak.data, app.pak.size));
ESP_ERROR_CHECK(pocketjs_ui_qjs_mount(binding));
ESP_ERROR_CHECK(pocketjs_guest_eval(
    guest,
    (const char *)app.javascript.data,
    app.javascript.size - 1,
    "dashboard"));
```

One caller-driven frame is:

```c
pocketjs_ui_input_t input = {
    .struct_size = sizeof(input),
    .buttons = buttons,
};
pocketjs_ui_frame_view_t frame = {
    .struct_size = sizeof(frame),
};
ESP_ERROR_CHECK(pocketjs_ui_turn(binding, &input, &frame));
```

The binding converts signed analog axes to the framework range and packs up to
eight logical touch contacts. Touch coordinates must fit the current 9-bit
per-axis frame contract. Hardware SDK types stop in the product input adapter.

## RGB565 renderer

Create one renderer and one target state per persistent physical buffer. The
renderer config's `scale` must equal the UI core's `raster_density`. The
presentation transaction is:

1. `pocketjs_rgb565_prepare` returns zero to eight logical damage rectangles.
2. `pocketjs_rgb565_render_strip` paints each rectangle into a caller-owned
   full-viewport-width strip. Its physical dimensions are
   `logical_width * scale` by `region.height * scale`; pixels outside the
   rectangle's horizontal interval remain unchanged.
3. The product transfers only the rectangle window, or preserves the
   untouched columns before transferring the complete strip. Rotation,
   scaling, and composition stay in this product-owned step.
4. After every transfer succeeds, call `pocketjs_rgb565_commit`.
5. After a partial update or transfer failure, call `pocketjs_rgb565_abort`.

Commit advances only the selected target's history. Double-buffered firmware
therefore keeps two independent target handles. The renderer does not wait on
DMA or retain a pointer to the strip after `render_strip` returns.

## ESP32-P4 PPA

P4 firmware can construct an accelerator and pass its borrowed vtable to
`render_strip`:

```c
pocketjs_esp32p4_ppa_t *ppa = NULL;
ESP_ERROR_CHECK(pocketjs_esp32p4_ppa_create(&ppa));
const pocketjs_rgb565_accelerator_t *accelerator =
    pocketjs_esp32p4_ppa_accelerator(ppa);
```

PPA operations are blocking because CPU fallback commands later in the same
DrawList must observe completed pixels. Destination buffers must satisfy the
IDF PPA DMA/cache contract; 128-byte address and size alignment is the supported
P4 policy. Display presentation uses a separate BSP-owned client when it needs
asynchronous scaling or transfer.

## Optional runner

`pocketjs_runner` owns one task and calls the same synchronous
`pocketjs_ui_turn` function. Its callbacks supply input and consume the frame
view:

```c
pocketjs_runner_config_t config;
pocketjs_runner_config_defaults(&config);
config.sample_input = sample_input;
config.after_turn = render_and_present;
ESP_ERROR_CHECK(pocketjs_runner_start(binding, &config, &runner));
```

The runner reads `tickHz` from the mounted binding's UI core. Deadlines are
derived from `t0 + frame / tickHz`, so 60 Hz is not represented as a drifting
16 ms period. The runner catches up late turns and drops stale turns only after
exceeding `max_lag_us`. `pocketjs_runner_stop` interrupts a running JS turn and
joins the task before returning. It does not destroy any borrowed handle.

## Shutdown

For caller-driven firmware:

1. stop calling `pocketjs_ui_turn`;
2. finish or abort the active renderer transaction;
3. destroy PPA, target states, and renderer;
4. destroy the guest;
5. destroy the UI binding and core;
6. close the package after its borrowed bytes are no longer referenced.

When using the runner, call `pocketjs_runner_stop` before step 2.

## Rust archives

Registry releases contain separate core and renderer archives for P4 and S3:
`pocketjs_ui_core` owns `libpocketjs_idf_ui_core.a`, and
`pocketjs_render_rgb565` owns `libpocketjs_idf_render_rgb565.a`. The renderer
uses C resource views, not the private Rust layout of the core. Set
`POCKETJS_RUST_FROM_SOURCE=ON` only when modifying the core or renderer. The
build checks the developer-provided Cargo, compiler target, and linker and does
not install a Rust toolchain.

The source targets are:

- P4: `riscv32imafc-unknown-none-elf`
- S3: `xtensa-esp32s3-none-elf`

When `POCKETJS_CARGO` selects a custom executable, the component uses the
`rustc` beside it. This keeps the Cargo/compiler pair from the same toolchain.

**For P4, archive preparation removes Rust-bundled soft-float compiler-rt C
members. ESP-IDF supplies the equivalent runtime symbols from ROM or libgcc
under its `ilp32f` ABI.**

## Error and allocation policy

Invalid configuration is rejected with an error code, including raster
density outside `1..=255`. C and QuickJS allocation failures are reported
where their APIs permit recovery. **Rust allocation exhaustion is fatal.**
The native core and renderer do not promise to translate every OOM into
`ESP_ERR_NO_MEM`; provision their memory separately from the guest heap limit.

## Examples

`hosts/esp-idf/examples/smoke` compiles and links the caller-driven package,
guest, UI, renderer, and P4 accelerator path. `examples/runner` executes the
same package on the optional owner task. `examples/prebuilt` builds the same
`smoke` sources against a checked-in `idf-smoke.pocket`, so its build needs no
`pocket` CLI and no Bun. All three use a headless RGB565 buffer; product panel
initialization remains in the BSP.
