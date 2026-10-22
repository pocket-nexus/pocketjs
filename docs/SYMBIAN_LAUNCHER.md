# Symbian app launcher

**The Symbian launcher builds one Nokia E7 SIS containing a Cover Flow picker
and a catalog of `.pocket` applications.** Its program, profile and build tools
live in the main PocketJS repository alongside the PSP, Vita and 3DS programs.

**One guest is alive at a time.** The Qt host presents the outgoing frame,
releases its Runtime and QuickJS realm, then boots the selected package.
Returning to an interrupted app starts a new guest. The frozen image shown
behind the picker does not preserve application state.

## Build commands

Install the repository dependencies before running the launcher tools:

```sh
bun install --frozen-lockfile
bun tools/launcher.ts scan --target symbian
bun tools/launcher.ts covers --target symbian
bun tools/launcher.ts pack --target symbian
bun tools/launcher.ts build --target symbian
```

`--target symbian` selects the E7 program. `build`
requires the Symbian toolchain described in [SYMBIAN_E7.md](SYMBIAN_E7.md).
`scan`, `covers` and `pack` do not invoke the native SIS compiler. Cover
rendering builds the repository's wasm core, so it requires the fixed Rust
toolchain and `wasm32-unknown-unknown` target.

Each command performs the preceding steps except that **only `scan` without
external manifests updates the committed display metadata**. Build-like
commands leave `apps/launcher/registry.generated.ts` and `images.json`
unchanged. The committed metadata includes the PSP, Vita and Symbian app
sets; each program exposes its admitted subset through `appTable()`.

```sh
bun tools/launcher.ts pack --target symbian --exclude note-main
bun tools/launcher.ts build --target symbian \
  --include-manifest /absolute/project/pocket.json \
  -- --sis-version 0.1.0 --uid 0xE0001234
```

`--exclude` and `--include-manifest` may repeat. `--force` rebuilds cover
images. The native backend accepts `--sis-version` and `--uid` after `--`;
unknown options fail before build metadata is written.

## Admission and source ownership

The scanner reads `apps/*/pocket.json` and resolves each manifest against
`profiles/symbian-e7-dev.ts` using the framework's package resolver. Diagnostics
identify skipped applications. Admission requires the E7 live-viewport
contract; a manifest limited to a fixed console viewport is rejected.

External manifests use the same admission checks. Their entry paths resolve
from the project containing those entries. Duplicate app IDs or output names
fail before compilation. External project paths stay in build state and do
not enter the committed display registry.

**The launcher uses the engine, contracts and program sources in the same
checkout.** Build outputs stay under `dist/launcher/symbian/`; native build
receipts record the inputs used for that invocation.

## Artifacts

The output directory is `dist/launcher/symbian/`:

| Step | Output |
| --- | --- |
| `scan` | `launcher-registry.json` and `launcher-registry.tsv`; a plain scan also refreshes the two committed display metadata files |
| `covers` | Generated PNGs under `apps/launcher/covers/`; the directory is ignored by Git |
| `pack` | Recompiled guest JS/pak files, selected variants under `packages/`, `catalog.tsv` and `catalog.bin` |
| `build` | The native SIS containing the catalog and E7 runtime |

The cover renderer uses the first profile an application admits in PSP, Vita,
Symbian order. It boots the wasm host with that profile's viewport and
density, settles 90 frames, then downsamples to 256×128 pixels. A boot failure uses a
color gradient derived from the output name. Each cover has a separate
reflection image with an alpha ramp. Cover pixels are generated assets, not
committed validation records.

Pack/build creates `.launcher-source/` under the output directory. It
contains the selected registry, image metadata, entry and cover files. The
launcher gets a live E7 viewport and touch enhancements in this private build
input. The package contains one background image and two images per selected
app. A checkout-local lock prevents competing launcher commands from
interleaving generated-source writes; the Symbian build transaction also
serializes the shared native output tree.

**The catalog embeds the exact target-thinned `.pocket` bytes.** Its index has
eight fields per entry and its blob aligns packages to 16 bytes. The host
checks package identity, profile hash and binding generation before boot.
The native builder derives a 1 MiB-aligned GCCE writable-data base from the
embedded byte count so catalog rodata cannot overlap writable data.

## Guest operations and switching

The canonical generated UI binding exposes the host's registered operations:

| Op | API | Result |
| --- | --- | --- |
| 39 | `appTable()` | JSON containing app output, ID and title, plus `current` and `resume` |
| 40 | `appLaunch(output)` | Schedules a switch after the current frame; returns zero for an unknown output |
| 41 | `appShot()` | Texture handle for the frozen 256×128 RGBA frame, or `-1` when no shot is available |

`@pocketjs/framework/launcher` exposes `appTable()`, `launchApp()`,
`frozenShot()` and `launcherActive()`. Hosts that do not register these
operations return the wrapper's unavailable result.

For a catalog containing multiple apps, the E7 host reserves the physical
Backspace/Home action. It maps to SELECT inside the launcher and is removed
from other guests' input. A press edge captures the outgoing frame, records
its output as `resume`, and returns to the picker. An explicit launch clears
that resume state. Escape maps to CROSS, Q/E to the triggers, and T/S to
TRIANGLE/SQUARE.

The picker uses the live landscape or portrait viewport. Touch divides its
width into browse/launch thirds. Button holds move at ten cards per virtual
second; `ticksPerFrame()` supplies the host time scale. Release animates to
the selected card. CIRCLE launches it; SELECT/CROSS relaunch the interrupted
application when a resume entry exists.

## Installed native applications

**An app table with `kind: "native"` denotes process navigation.** Its launch
operation foregrounds a retained task or starts an installed UID instead of
replacing the current guest. The E7 host owns the child return strip and
calls `onNativeAppReturn` before the shell resumes. `closeApp` requests that
child process exit. See the [installed-app navigation contract](SYMBIAN_E7.md#installed-app-navigation).

## Verification

```sh
bun test tests/launcher-symbian.test.ts tests/symbian-runtime.test.ts
bun test tests/symbian-navigation.test.ts tests/symbian-package.test.ts
```

These tests cover display metadata freshness, source locking, source-byte
preservation after failed compilation, isolated launcher compilation with
`1 + 2N` images, catalog encoding, admission and navigation policy. Building
the launcher exercises the wasm artifact and selected guest packages. Device
rendering, input and SIS installation remain separate acceptance steps; a
host test does not establish those device results.
