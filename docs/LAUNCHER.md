# In-device app switching

**A PSP EBOOT or Vita VPK built with a guest registry embeds several app
packages and runs one of them at a time.** The host exposes three `app*`
operations and reserves SELECT to return to app 0, the launcher guest. This
repository holds the host mechanism and the guest API
(`@pocketjs/framework/launcher`); it holds no launcher application. The
Nokia E7 program exposes the same guest operations over an embedded package
catalog or over installed native applications; see "Hosts" below.

## Guest lifecycle

**Each program runs one guest at a time.** A switch finishes the current
frame, destroys its QuickJS realm and Runtime, and boots the selected package
with a fresh Runtime. Resume relaunches the interrupted package. The frozen
frame passed to the launcher is an image; it does not retain guest state.

## Surface ops (spec.ts, append-only)

| op | name | signature | semantics |
|----|------|-----------|-----------|
| 39 | `appTable` | `() -> string` | JSON `{ apps: [{output, id, title}], current, resume }`. `current` is the running bundle's output name; `resume` is the app interrupted by the last SELECT summon (null after a cold boot or an explicit launch). Hosts without app switching omit the op (same rule as `debugStats`). |
| 40 | `appLaunch` | `(output: string) -> 0\|1` | Request a switch. The host finishes the CURRENT frame (draw + present), then swaps guests before the next one. Returns 0 for an unknown output (no switch scheduled). Calling it with `current` relaunches fresh. |
| 41 | `appShot` | `() -> handle \| -1` | Texture handle of the frozen frame captured when the running app was summoned away: the full current logical frame downscaled into 256×128 PSM_8888 (stored squeezed; drawn at the current viewport aspect, which undoes it). Console frames are 480×272. Valid in the guest booted by a summon until the next switch; -1 otherwise. |

`@pocketjs/framework/launcher` wraps these (`appTable()`, `launchApp()`,
`frozenShot()`, `launcherActive()`) and degrades to `null`/no-op on hosts
that lack the ops, so a launcher bundle stays admissible on a single-app host.

## SELECT summon policy (host-owned)

A multi-app host (APPS table length > 1) reserves SELECT:

- Guests other than the launcher NEVER see the SELECT bit — the host strips
  `0x0001` from the mask before `frame(mask, analog)`.
- On a SELECT press-edge (host-tracked, not guest-latched) the host captures
  and downscales the framebuffer, then switches to the launcher with
  `resume = <interrupted output>`.
- While the launcher itself runs, SELECT is forwarded untouched, so the
  launcher can bind it to resume.

Single-app EBOOTs/VPKs have an APPS table of length 1: no interception and no
ops behavior change. An app that binds SELECT keeps it in its standalone
package and loses it in a multi-app image.

## Build inputs

**App 0 is the package given to the native build; a registry file lists the
other guests.** The registry is a TSV file with one
`output<TAB>id<TAB>title` line per guest, in table order. Each guest's
package is `<packages>/<output>.pocket`. `pocket compile --manifest` writes a
`.pocket`; `pocket build --pocket` consumes one. The registry flags follow
`--` and reach the native recipe:

| Flag | PSP | Vita |
|------|-----|------|
| `--launcher-registry=<tsv>` | selects multi-app mode | selects multi-app mode |
| `--launcher-packages=<dir>` | optional; defaults to `packages/` beside the registry | required with the registry |

```sh
pocket build --target psp --pocket launcher.pocket -- \
  --launcher-registry=registry.tsv
pocket build --target vita --pocket launcher.pocket -- \
  --launcher-registry=registry.tsv --launcher-packages=packages
```

`programs/psp/build.rs` and `programs/vita/build.rs` embed the package
files unmodified, app 0 first, through `tools/build/embedded-apps.rs`. The
build fails when an output name falls outside `[A-Za-z0-9_.-]+`, repeats, or
equals app 0's output, and when the registry lists no guest. PSP records one
FNV-1a64 build identity over the embedded files in table order; Vita tracks
every package as a Cargo input and preserves each `.pocket` footer identity.

## Memory

**On PSP the embedded package table is part of the image, so each embedded
byte leaves the guest arena one byte smaller.** The arena is the largest free
kernel block minus a 2 MiB margin (`platforms/psp/alloc/src/arena.rs`); the
PSP-1000 has 24 MB of user RAM, and the host runs QuickJS on a 1 MiB worker
stack. Teardown returns a guest's allocations to the arena's segregated free
lists. The size classes are powers of two, so the next guest reuses the freed
blocks and repeated swaps do not fragment the arena.

Vita embeds the same target-thinned `.pocket` table as 16-byte-aligned SELF
rodata. Only one QuickJS realm, `Ui`, pak binding, and set of guest texture
handles is live. A swap waits for GXM to go idle, retires those handles and
the font atlas, trims the reusable texture pool to its fixed budget, then
boots the next package; vita2d and input remain process-owned.

## Hosts

- **programs/psp** — the package table, the SELECT edge, the frozen-shot
  capture (`src/switch.rs`) and the host-drawn switch veil (`src/veil.rs`).
  The GE leaves framebuffer alpha at 0, so the capture writes alpha 255.
- **programs/vita** — the same package-table and ops contract with a
  process-global frame/input tape across fresh guests, SELECT interception,
  CPU-oracle frozen shots, and an explicit GXM-safe guest-resource reset.
- **programs/nokia-e7** — an embedded catalog instead of a registry:
  `--catalog-index <catalog.tsv> --catalog-blob <catalog.bin>` on
  `pocket symbian build app`. The blob concatenates `.pocket` files at
  16-byte-aligned offsets. Each index row has eight tab-separated fields:
  output, app id, title, byte offset, byte length, logical width, logical
  height, and `live` or `fixed`. Entry zero must carry the app id
  `dev.pocket-nexus.launcher`. With more than one entry the host reserves
  the Backspace/Home key: it maps to SELECT inside entry zero and is removed
  from the other guests' input; a press edge captures the outgoing frame,
  records its output as `resume`, and boots entry zero. A catalog cannot be
  combined with `--navigation`, which switches between applications
  installed as separate SIS packages; see
  [installed-app navigation](SYMBIAN_E7.md#installed-app-navigation).
- **products/3ds** — the launcher is the embedded ROMFS guest and the catalog is
  the set of installed runtime slots on the SD card, not a package table; see
  "Nintendo 3DS: installed apps" below.

## PSP frame rate

**A multi-app PSP image runs at 20 Hz.** When the package table holds more
than one app, `programs/psp/src/main.rs` publishes `__simHz = 20`, advances
the package tick rate divided by 20 core ticks per frame (three at 60 Hz)
and presents on every third vblank. Animations specified in milliseconds
keep their durations and are sampled 20 times per second. A guest that moves
by a per-tick velocity multiplies it by `ticksPerFrame()`, so 60, 30 and
20 Hz hosts cover the same distance in the same virtual time. A single-app
PSP image presents at the cadence the runtime selects from its profile. The
rate is one process-wide timebase, selected by the table length: the host
has no branch on an app name and publishes no capability for it.

## Verification

- `tests/psp-runtime.test.ts` compiles `tools/build/embedded-apps.rs` with
  `rustc --test` (table order, unmodified package bytes, output-name
  validation) and checks how `--launcher-registry` and `--launcher-packages`
  resolve.
- `tests/runtime-build.test.ts` and `tests/runtime-programs.test.ts` cover
  the registry and its packages as declared native build inputs.
- `tests/symbian-navigation.test.ts` covers the E7 navigation table and the
  return gesture.
- No test in this repository boots a multi-app image.

## Nintendo 3DS: installed apps

**The 3DS catalog is the SD card.** The `.3dsx` embeds one package, the
launcher (Pocket Shell, `dev.pocket-nexus.shell`, output `pocket-shell`,
maintained in [pocket-shell](https://github.com/pocket-nexus/pocket-shell)
`shells/3ds/shell`).
Every other directory under
`sdmc:/pocketjs/runtime/apps/<slot>/` (slot = the first 16 hex digits of
SHA-256 of the app id) whose state names a committed active package is an
installed app. Apps arrive there through a Pocket Link install
(`link.install`, contracts/spec/link.ts) or a dev-wire push, each into the
app's own slot.

The ops keep their numbers and meanings, with these differences:

| op | 3DS behaviour |
|----|---------------|
| `appTable` | `{apps:[{output,id,title,version,bytes}], current, resume, launcher, lastError}`. `apps` lists installed slots only, **never the launcher**, sorted by title; `launcher` is the launcher's output; `lastError` is `{output, message}` for the last installed app that failed to boot or threw from a frame, reported once and then `null` (also cleared by the next launch). |
| `appLaunch` | Launching `launcher` returns home. Two slots with one output resolve to the later install. |
| `appShot` | Always `-1`: no frozen frame is kept. |

**An installed app's failure never reaches the launcher's recovery chain.**
Its error is written to its own slot's `last-error.txt`, the host switches to
the launcher, and nothing is committed into the launcher's slot. SELECT
follows the policy above: stripped from installed apps, a host-tracked press
edge returns to the launcher with `resume` set, and the edge detector is
latched at every boot, and an installed app's frame that runs past 50 ms
scans for the edge itself, so a long frame does not hold it back. A switch
runs under a host-drawn transition: a scrim over the old guest's last frame,
an activity indicator while the new guest loads, and the scrim falling away
over its first frames. products/3ds/README.md has the slot and switch details.
