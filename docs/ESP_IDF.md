# ESP-IDF component maintenance

**One program archive contains the canonical runtime, software renderer and
PPA factory.** Components under `platforms/esp-idf` supply platform
allocation, the generated QuickJS guest, display transport and an optional
owner task. ESP32-P4 can register PPA; S3, C3 and C6 use the software renderer.

| Component | Dependencies |
| --- | --- |
| `pocket_runtime` | IDF heap/log; one Rust archive |
| `pocket_guest_quickjs` | runtime and espressif/quickjs-ng 0.14.0 |
| `pocket_display_esp_lcd` | runtime and esp_lcd SPI/I80 transport |
| `pocket_render_esp_ppa` | runtime and esp_driver_ppa |
| `pocket_input_touch` | One esp_lcd_touch contact with logical coordinate scaling |
| `pocket_input_gpio` | GPIO and ADC button masks with debounce |
| `pocket_runner` | runtime, FreeRTOS and esp_timer |

Only the runner creates a task. Only the PPA component includes accelerator
headers. Package admission and UI state remain in runtime crates.

## Native archive identity

The runtime component owns:

```text
pocket_runtime/lib/<target>/libpocket_idf_runtime.a
pocket_runtime/lib/<target>/build-receipt.json
```

`hosts/esp-idf/native/runtime` composes `pocket-runtime-cabi` and
`pocket-render-esp-ppa` with its C factory feature. The generic SDK archive has
no platform driver dependency. Both compositions use one allocator and panic
handler backed by the six `pocket_host_*` hooks in `pocket_runtime/src/hooks.c`.

```sh
bun tools/esp-idf-native.ts --target esp32p4 --archiver /path/to/llvm-ar
bun tools/esp-idf-native.ts --target esp32s3 --cargo /path/to/xtensa-rust/bin/cargo
bun tools/esp-idf-native.ts --target esp32c3
bun tools/esp-idf-native.ts --target esp32c6
bun tools/esp-idf-release.ts --output /path/to/staged-components
```

The script uses the supplied toolchain. Compiler commits are pinned in
`tools/build/toolchains/esp-idf/compiler-pins.json`. Receipts record compiler, target,
build policy, source digest, archive digest, byte size and P4 archiver identity.
Release staging verifies these fields before copying files. Vendoring discovers local path dependencies and expands workspace inheritance.
`cargo vendor` includes registry dependencies; the staged workspace builds with
network access disabled and an empty Cargo home. No crate allowlist controls
the source closure. A component release advertises the targets whose verified
archives it contains.

`POCKETJS_RUST_FROM_SOURCE=ON` enables development builds. RISC-V runs a locked
`cargo build --no-default-features`; S3 adds `-Zbuild-std=core,alloc`.
`POCKETJS_CARGO` selects Cargo and its adjacent rustc. `POCKET_RUNTIME_ARCHIVE`
selects an existing prepared archive when source builds are disabled.

**P4 archive preparation removes Rust-bundled soft-float compiler-rt C members.**
ESP-IDF supplies their symbols through ROM or libgcc under its `ilp32f` ABI.
The preparation rules participate in receipt identity.

## Package and profile boundaries

The product owns `pocket.runtime-config.ts` and imports a `defineProfile()`
module. **One profile hash identifies both the program and its application
package.** `pocket profile export --config <file> --out <directory>` writes
`pocket_profile.h` and `pocket-profile.json`. These are build outputs, not
checked-in platform definitions.

`pocketjs_compile_app(TARGET <target> NAME <name> MANIFEST <pocket.json>)`
compiles the application and exports its program profile.
`pocketjs_profile_header(TARGET <target> NAME <name>)` exports a profile without
compiling an application. Both invoke the Pocket CLI and record imported
configuration/profile modules in depfiles. All three CMake helpers accept
`RUNTIME_CONFIG`; its default is the IDF project root's
`pocket.runtime-config.ts`.

`pocketjs_embed_package(TARGET <target> NAME <name> PACKAGE <file>
PROFILE_EXPORT_DIR <directory>)` consumes prebuilt artifacts using Python.
This path requires Python, the package and exported artifacts; it does not
require Bun, the Pocket CLI or the TypeScript config modules. `PROFILE_EXPORT_DIR`
defaults to `<current-binary-directory>/pocketjs/<name>/profile`; export there
before configuring an offline build. Missing exports produce a command naming
the required config and output directory.

The Python helper verifies the sidecar format, exact canonical JSON bytes,
independent binding generation and profile hash before admitting the package.
It does not serialize another copy of the profile identity. The generated
`pocketjs_package_<name>.h` supplies package storage and admitted application
geometry; the program includes `pocket_profile.h` for runtime configuration.

The runtime admits `.pocket` bytes through the shared Rust package loader,
selects target/ABI, installs assets and initializes the guest. Generated guest
bindings publish metadata, dispatch UI operations and pack frame inputs.
The removed C package parser and UI dispatcher have no independent admission
or binding path.

`tools/driver-contracts.ts` generates public C/Rust driver/runtime ABI records.
`tools/esp-idf-contracts.ts` generates package wire constants and Python profile
field names. Both generators support `--check`. TS, Rust and Python readers
consume `tests/fixtures/packages/corpus`.

## QuickJS source preparation

**The immutable package path checks an exact official source digest.**
The espressif/quickjs-ng 0.14.0 source used by the component is at
[Espressif commit 0d0b99456ce9112f4ac4838927ba837949359f9b](https://github.com/espressif/esp-iot-solution/tree/0d0b99456ce9112f4ac4838927ba837949359f9b/components/quickjs-ng).
Its `quickjs-ng/quickjs.c` SHA-256 is
`36128da188cb236ffd029dd3c672ff8f85e5a196a9211e267a515c8efc1ab52c`.
`pocket_guest_quickjs/tools/prepare_quickjs.py` checks this digest and adds
immutable checks for reverse and species-created write destinations in a
build-directory copy. Managed component sources remain untouched. Dependency
upgrades require reviewing the patch and passing immutable-buffer regressions.

The generated guest borrows PAK bytes for this verified immutable profile.
Package storage remains live until guest shutdown. The platform wrapper
supplies heap/stack limits, cancellation and promise rejection reporting.
Guest errors fail the runtime; renderer/display errors drain submitted work
before returning and invalidate presentation history.

## Presentation and task ownership

The SPI/I80 display adapter reserves one or two full-width RGB565 strips under
the configured pixel budget. Two buffers let the coordinator render a strip
while the previous DMA transfer reads the other buffer. Partial damage expands
to full-width rows. Per-panel identity retains damage history; invalidate its
generation after reset or external writes.

**Display wait is terminal on success and returned failure.** The adapter uses
IDF's synchronous parameter transaction to drain color transfers. A failure to
establish the drain is fatal because DMA storage cannot be released. The driver
does not implement RGB/MIPI framebuffer output.

PPA preserves opaque fill, A8 glyph coverage, white-alpha batching and RGB565
SRM. Unsupported operations fall back before hardware writes; failures after
writes abort the frame. A8 payload storage has its own configured budget.

The optional runner uses `pocket_tick_schedule` for deadlines and skipped ticks.
Stop interrupts the guest, wakes the task and joins it. A timeout retains the
runner and its contexts. After a successful join, destroy runtime, guest,
renderer/device and display in that order.

## Validation

```sh
bun tools/driver-contracts.ts --check
bun tools/esp-idf-contracts.ts --check
bun tools/esp-idf-host-tests.ts
bun test tests/idf-embed.test.ts tests/idf-incremental.test.ts tests/idf-release.test.ts tests/idf-package-corpus.test.ts tests/idf-input.test.ts
cargo test --locked --manifest-path Cargo.toml -p pocket-render-esp-ppa --features cabi
```

`POCKETJS_QUICKJS_SOURCE` selects another copy of the exact pinned source.
Host regressions compile the generated guest, platform wrapper and single Rust
archive. Tests cover package admission, immutable writes, promise rejection,
allocator failure, two pending display buffers, reverse waits, DMA drain after
submission failure and old RGB565 pixel/strip parity.

The smoke and runner examples use a transfer-hash sink; they do not initialize
panel hardware. Real panel validation must supply board setup and compare pixels
against the software reference. Final device acceptance covers P4 acceleration,
S3 software output, strip budgets, panel resets, task cadence, stop/join and
steady-state heap use. Keep UART output, maps, hashes and receipts in ignored
`.pocket-build/validation/<task>/<run>/` or an artifact store. No device run is
implied by a host test or firmware link result.
