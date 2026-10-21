# ESP-IDF component maintenance

PocketJS publishes six caller-driven components and one optional task runner
from `hosts/esp-idf/components`. **ESP32-P4 and ESP32-S3 consume the same C ABI
and package contract.** P4 can add the PPA component; S3 always uses the
software RGB565 path.

## Dependency gates

```text
pocketjs_package
pocketjs_guest -> quickjs-ng
pocketjs_ui_core
pocketjs_ui_qjs -> pocketjs_guest + pocketjs_ui_core
pocketjs_render_rgb565 -> pocketjs_ui_core
pocketjs_esp32p4_ppa -> pocketjs_render_rgb565 + esp_driver_ppa
pocketjs_runner -> pocketjs_ui_qjs
```

Only `pocketjs_runner` calls `xTaskCreatePinnedToCore`. Only
`pocketjs_esp32p4_ppa` includes PPA driver headers. Package, core, and renderer
must not acquire a QuickJS dependency.

## Native archives

**One Rust archive per target supplies the UI and RGB565 C interfaces.**
The UI component owns that archive and its receipt:

```text
pocketjs_ui_core/lib/<target>/libpocketjs_idf_ui_core.a
pocketjs_ui_core/lib/<target>/build-receipt.json
```

Build P4 with a Rust installation that provides
`riscv32imafc-unknown-none-elf`:

```sh
bun tools/esp-idf-native.ts --target esp32p4
```

Build S3 with a Rust installation whose `cargo` and `rustc` support
`xtensa-esp32s3-none-elf`:

```sh
bun tools/esp-idf-native.ts \
  --target esp32s3 \
  --cargo /path/to/xtensa-rust/bin/cargo
```

The script does not download or select a toolchain. Release compiler commits
are pinned in `hosts/esp-idf/native/toolchains.json`. Each invocation builds
the shared runtime archive. The receipt records the compiler, Rust target, build policy, source
digest, archive digest, byte size, and P4 archiver identity.
If the host's default `ar` cannot resolve GNU archive long names, pass LLVM or
GNU ar with `--archiver /path/to/llvm-ar`.

The component build accepts `POCKETJS_RUST_FROM_SOURCE=ON` for development.
P4 runs a locked `cargo build --no-default-features`; S3 additionally uses
`-Zbuild-std=core,alloc`. Missing Cargo, target support, or linker state is an
error with no installation side effect.

The compatibility crates under `hosts/esp-idf/native` re-export
`engine/runtime-cabi`; only `ui-core` produces a static archive. The RGB565 C
component depends on the UI component for its native symbols. The archive
contains one allocator and panic handler, backed by the six `pocket_host_*`
hooks in `ui_core.c`. The general renderer crate is `engine/backends/rgb565`;
PPA driver code remains in the optional P4 component.

**Rust OOM is fatal; returned asset-loading errors are transactional.**
Asset parsing and allocation happen before the live core is changed.
Registry allocation failure and malformed input leave the binding reusable.

**The P4 preparation step removes Rust-bundled soft-float compiler-rt C
members. ESP-IDF provides the equivalent runtime symbols through ROM or
libgcc under its `ilp32f` ABI.**

## Package contract

`pocket.host.json` is validated against
`contracts/schema/pocket-idf-host-1.json`. Its canonical SHA-256 travels in the
resolved plan, generated C contract, and `.pocket` host-input section.

The generic build plan carries a versioned `hostExtension` with its JSON
payload and payload hash. Only the IDF adapter interprets profile hash and
tick rate. Section kind 7 is a 104-byte little-endian record:

| Offset | Field |
| ---: | --- |
| 0 | `PHST` magic |
| 4 | format version 1 |
| 8 | HostOps ABI |
| 12 | tick rate |
| 16–28 | logical and physical width/height |
| 32 | raster density |
| 36 | presentation enum |
| 40 | 32-byte host-profile SHA-256 |
| 72 | 32-byte resolved-plan SHA-256 |

The variant table still carries target id and HostOps ABI. Device admission
checks both copies, every numeric host field, and the profile hash before
returning JS or PAK bytes. The JSON plan remains in section kind 2 for artifact
inspection and is not parsed during device boot.

`tools/esp-idf-contracts.ts` generates C/Rust FFI declarations and layout
assertions from `contracts/spec/idf-native.ts`, and wire constants from the
package specifications. `--check` rejects stale generated files. The TS,
Rust, C and Python readers consume `tests/fixtures/packages/corpus`.

The guest uses `JS_SetImmutableArrayBuffer` for borrowed PAK bytes. The
Registry QuickJS 0.14.0 source needs two extra immutable checks: typed-array
reverse and species-created write destinations. `prepare_quickjs.py`
verifies the input source hash and prepares a build-directory copy; it never
edits managed components. **Dependency upgrades require reviewing this
patch and passing the immutable-buffer regression tests.**

## CI

`.github/workflows/esp-idf.yml` is manually dispatched for release validation
and runs:

- host contract/package, depfile, receipt, and native Rust tests;
- native archive builds for both targets;
- ESP-IDF `release/v6.0` and `release/v6.1` firmware builds for both targets;
- the same generated `.pocket` in each firmware build.

**The committed package fixture and this workflow use Bun 1.3.14.** Bundle
bytes are compiler-versioned; update the pin and fixture in the same change.

The smoke application renders a 320×240 logical UI. The P4 build includes the
PPA component. The S3 build uses `MINIMAL_BUILD` and excludes PPA from component
discovery and the link map.

Run native host regressions without a board after resolving the pinned
QuickJS component in an IDF example:

```sh
bun tools/esp-idf-contracts.ts --check
bun tools/esp-idf-host-tests.ts
bun test tests/idf-incremental.test.ts tests/idf-release.test.ts tests/idf-package-corpus.test.ts
```

`POCKETJS_QUICKJS_SOURCE` may point at another copy of that exact component
source. Host tests compile the real C wrappers, the shared Rust archive, and
QuickJS. They inject C allocation failures, reject stale frame views, check
Promise identity, and exercise immutable PAK writes. The package fuzz target
and scratch-corpus instructions are in `hosts/esp-idf/tests/fuzz`.

## Hardware release gates

Before a component release:

1. Flash `examples/smoke` to the Waveshare ESP32-P4 test board. Require the
   fixed framebuffer hash and non-zero FILL, BLEND, and SRM counters.
2. Flash the S3 build to AtomS3R. Require the same software-reference pixel
   hash and no PPA symbols in the map.
3. Run 10,000 caller-driven turns on both boards and compare heap before and
   after the steady-state interval.
4. Run `examples/runner` for 30 seconds. Require the configured cadence, zero
   ordinary skipped frames, and a successful stop/join.
5. Archive UART receipts, map files, component versions, native-archive
   receipts, and firmware SHA-256 values with the release record.

## Registry release

`components/versions.json` specifies each component version and its internal
dependency ranges. The current release uses exact dependencies; the verifier
does not require all components to share one version. Upload components only
after their dependency versions exist in the Registry.

Before staging, `tools/esp-idf-release.ts` verifies both target archive receipts,
recomputes source and archive hashes, checks compiler/build policy and sizes,
and checks generated contracts and component versions. Archive preparation
rules participate in the source digest. **Stale archives cannot be staged
with newer source.** The script stages files; it does not upload to Registry.

Run the verifier independently with `bun tools/esp-idf-native-receipt.ts`.
The UI component's source-build vendor tree includes the runtime, C ABI,
renderer backend, and their Rust dependencies. The RGB565 component consumes
that archive through its UI component dependency.

Every component's `documentation` URL must resolve to the ESP-IDF guide. Build
the site and the two example projects before publishing. A release is rejected
if the prebuilt package path needs Bun or if the default native-archive path
invokes Cargo.
