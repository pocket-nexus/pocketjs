# The Pocket Launcher — in-device app switching

One device package — PSP EBOOT, Vita VPK, or Nokia E7 SIS — with every target-compatible
app inside and a Cover Flow picker on top. This document is the contract for
the multi-app host, the three `app*` surface ops, and the SELECT summon policy.
RUNTIMES.md owns the ontology; nothing here changes it — a launcher is an
ordinary Guest that happens to pick the next Guest (rule 5: the capability is
a surface op, not a host branch).

## Model

The runtime stays `⟨Cores, Surfaces, Guest⟩` with exactly ONE guest alive at
a time. "Switching" is the same whole-guest swap every host already performs
(browser `load()`, pocket-mod drop-and-rebuild, golden's per-demo fresh
core): finish the current frame, tear the guest down (free the QuickJS
runtime, drop the `Ui` core), boot the next bundle from scratch (fresh core,
pak feed, fresh realm, eval). There is no suspend: **resume = relaunch**.
The frozen last frame of the interrupted app is a visual affordance handed
to the launcher, not a saved state.

What IS new: the host can hold more than one embedded bundle, expose the
table of them to the guest, accept a switch request, and reserve SELECT as
the system summon chord.

## Surface ops (spec.ts, append-only)

| op | name | signature | semantics |
|----|------|-----------|-----------|
| 39 | `appTable` | `() -> string` | JSON `{ apps: [{output, id, title}], current, resume }`. `current` is the running bundle's output name; `resume` is the app interrupted by the last SELECT summon (null after a cold boot or an explicit launch). Hosts without app switching omit the op (same rule as `debugStats`). |
| 40 | `appLaunch` | `(output: string) -> 0\|1` | Request a switch. The host finishes the CURRENT frame (draw + present), then swaps guests before the next one. Returns 0 for an unknown output (no switch scheduled). Calling it with `current` relaunches fresh. |
| 41 | `appShot` | `() -> handle \| -1` | Texture handle of the frozen frame captured when the running app was summoned away: the full current logical frame downscaled into 256×128 PSM_8888 (stored squeezed; drawn at the current viewport aspect, which undoes it). Console frames are 480×272. Valid in the guest booted by a summon until the next switch; -1 otherwise. |

`@pocketjs/framework/launcher` wraps these (`appTable()`, `launchApp()`,
`frozenShot()`, `launcherActive()`) and degrades to `null`/no-op on hosts
that lack the ops, so the launcher bundle itself stays admissible anywhere.

## SELECT summon policy (host-owned)

A multi-app host (APPS table length > 1) reserves SELECT:

- Guests other than the launcher NEVER see the SELECT bit — the host strips
  `0x0001` from the mask before `frame(mask, analog)`.
- On a SELECT press-edge (host-tracked, not guest-latched) the host captures
  and downscales the framebuffer, then switches to the launcher with
  `resume = <interrupted output>`.
- While the launcher itself runs, SELECT is forwarded untouched (the
  launcher binds it to resume; CIRCLE does the same).

Single-app EBOOTs/VPKs have an APPS table of length 1: no interception and no
ops behavior change. Apps that bind SELECT (e.g. Pocket Talk) keep it in their
standalone package and lose it under the launcher — that is the price of a
system chord, stated here once.

The E7 host spells the same system action with the physical QWERTY
Backspace/Home keys. It forwards that action to the launcher as SELECT and
strips it from every other guest. Escape remains CROSS. Q/E map to the
left/right triggers and T/S to TRIANGLE/SQUARE, so the launcher remains fully
operable without an on-screen controller.

## Admission

The embedded set is COMPUTED, not curated: every `apps/*/pocket.json` whose
manifest resolves against the selected `psp` or `vita` target profile via
`validateAndResolveBuildPlan` (the same admission gate `pocket build` runs —
capability superset + viewport fit). Today both console profiles admit the
same 17 apps and exclude `ipod-nano` (176×132 panel) and `note` (dynamic
viewport). The registry tool prints per-app bundle sizes and takes
`--exclude <output>` for RAM budgeting; nothing is silently dropped.

## Memory math (PSP-1000 floor)

24 MB user RAM. The current 18-package PSP table is 13.6 MiB (including the
3.0 MiB launcher package and its covers). The PSP host runs QuickJS on a 1 MiB
worker stack, leaving a measured 5.27 MiB arena after its 2 MiB safety margin.
The current launcher peaks at 4.74 MiB and leaves about 553 KiB of arena tail;
the worker-stack watermark still reports about 791 KiB free. That is enough
for the measured launcher, but is no longer a generous margin, so release
linking plus a real PSP-1000 boot stays a required admission gate.
Teardown returns a guest's allocations to the arena's segregated free lists;
classes are power-of-two so cross-swap reuse is exact and fragmentation does
not accumulate by construction.

Vita embeds the same target-thinned `.pocket` table as 16-byte-aligned SELF
rodata. Only one QuickJS realm, `Ui`, pak binding, and set of guest texture
handles is live. A swap waits for GXM to go idle, retires those handles and
the font atlas, trims the reusable texture pool to its fixed budget, then
boots the next package; vita2d and input remain process-owned.

## Build pipeline

`bun tools/launcher.ts` owns the artifact chain. `--target psp|vita|symbian`
selects admission, bundle variants, packages, and the native backend; `psp`
is the default for compatibility:

1. **scan** — resolve every app manifest for the selected target and dedupe
   by `app.output`. PSP writes `dist/launcher-registry.{json,tsv}`; Vita writes
   `dist/launcher/vita/launcher-registry.{json,tsv}`. The committed display
   registry is the PSP/Vita/Symbian union, while `appTable()` remains the runtime truth.
   A plain in-repository `scan` is the only command that updates
   `apps/launcher/{registry.generated.ts,images.json}`; external scans leave
   those files untouched.
2. **covers** — boot each admitted app in `hosts/sim`, settle 90 virtual frames,
   render, box-downscale the full frame to 256×128, write
   `apps/launcher/covers/cover-<output>.png` (generated, deterministic —
   the PSP-flavored sim is the target-neutral oracle, so goldens over
   cover-bearing frames stay stable).
3. **pack** — every admitted app + the launcher becomes a `.pocket`
   package (`contracts/spec/pocket-package.ts`) with the selected target variant. PSP uses
   `dist/packages/`; Vita uses `dist/launcher/vita/packages/` so density-2
   bundles never overwrite the PSP/sim outputs. Pack/build materialize a private
   `.launcher-source` under `dist/launcher/<target>/` containing the selected
   registry, image metadata, entry, and cover assets; compiler/watch processes
   never observe a temporary target registry in the committed source tree.
4. **build** — the selected backend embeds those packages VERBATIM
   (`hosts/psp/build.rs` or `hosts/vita/build.rs`; the core reader extracts
   js/pak zero-copy at boot). PSP retains its aggregate FNV-1a64 build
   identity; Vita tracks every package as a Cargo input and preserves each
   `.pocket` footer identity. Outputs are the PSP EBOOT or
   `dist/vita/launcher-main.vpk`; ordinary single-app builds retain their
   classic inline embed.

For `symbian`, scan uses the private `symbian-e7-dev` resolver rather than
pretending the experimental host is a production target. Only apps with a
real dynamic/live viewport are admitted (currently Hero and Note); fixed
480×272 PSP apps are not silently letterboxed into the E7 catalog. The
committed launcher manifest stays byte-identical for PSP/Vita; inside the
locked Symbian transaction the tool derives its E7-only dynamic viewport and
touch/live enhancements. The Symbian pack step always recompiles every guest,
then writes an eight-field `catalog.tsv` and a 16-byte-aligned `catalog.bin`
containing those exact target-thinned `.pocket` files. The Qt host validates
each package footer, target, ABI, and identity before boot. The native builder
reserves a 1 MiB-aligned GCCE writable-data base from the full raw embedded
byte count, so a large catalog cannot overlap the executable's qrc rodata.

```sh
bun tools/launcher.ts build --target psp -- --release
bun tools/launcher.ts build --target vita -- --release
bun tools/launcher.ts build --target symbian
```

The Symbian build may repeat `--include-manifest /absolute/path/to/pocket.json`
to add explicitly requested external projects. The tool resolves each declared
entry by walking up from that manifest, applies the same private E7 admission
gate, and builds the launcher from its isolated target registry without ever
writing the committed display registry; absolute local paths never enter the
emitted registry or source diff. This
extension is deliberately unavailable to PSP/Vita builds, whose computed
in-repository admission set remains unchanged.

## Hosts

- **hosts/psp** — the original native implementation of everything above.
- **hosts/vita** — the same package-table and ops contract with a
  process-global frame/input tape across fresh guests, SELECT interception,
  CPU-oracle frozen shots, and an explicit GXM-safe guest-resource reset.
- **hosts/nokia-e7** — the E7 Qt process owns the fullscreen window, timer,
  keyboard, touch stream, and catalog blob. Each switch happens after a
  synchronous presented frame, then frees the complete QuickJS realm and
  native `Ui` before the next package boots. The launcher background, frozen
  shot, deck origin, title, and footer use the live 640×360/360×640 viewport;
  touch divides the current width into browse/launch thirds.
- **hosts/sim** — `hosts/sim/launcher.ts` drives the same protocol over
  per-guest `bootWorld`s: strips SELECT, performs the downscale with the
  same box filter, uploads the shot into the next world, answers the three
  ops. Switch flows are therefore deterministic traces, golden-able, and
  chaos-provable like any other scenario.
- **web (Pocket Stage)** — the pocketjs.dev hero boots the SAME launcher on
  the wasm core: `site/playground/host.js` `enableAppSwitching()` is the
  browser twin of the native policy (ops overlay per reset, SELECT
  stripping + summon edge, fetch-and-eval swap with the frozen shot
  re-uploaded), fed from `/stage/apps/` which the site build assembles from
  the registry. Verified headlessly by driving the protocol through
  PocketHost (site/verify.ts probe).

## Browse timing and PSP batching

The public behavior is 10 cards per virtual second, not a fixed distance per
host frame. The launcher multiplies its per-tick velocity by
`ticksPerFrame()`, so 60, 30, and 20 Hz host policies cover the same distance
in the same virtual time. A host that deliberately presents at 30 Hz
publishes `__simHz = 30`; the app does not infer hardware speed or branch on
a target name.

On PSP, controller input peeks the newest sample instead of consuming a sample
and potentially waiting for the next controller cycle; vblank present remains
the frame pacer. Perspective correction still subdivides each tilted image,
but the core painter sorts the image as one mesh and emits all of its
`TEX_TRI`s consecutively. The existing GE backend can therefore bind and draw
once per cover/reflection instead of rebinding between interleaved cells.

None of this is a platform capability. Capabilities describe stable public
behavior available to an app, while missed vblanks and scene-dependent GPU
cost are runtime performance. On real PSP hardware, batching cut the full
deck's CPU work from about 42 ms to about 12 ms, but its texture-heavy GE pass
still completed across the third vblank (about 50 ms between presentations).
A multi-app PSP package therefore uses an explicit 20 Hz host policy:
`__simHz = 20`, three fixed core ticks per virtual frame, and a three-vblank
presentation cadence. The deck still covers 10 cards per second and ms-based
animations retain their durations; they are sampled at 20 observations per
second. Standalone PSP apps remain at 60 Hz. This is one process-wide
timebase, never a launcher-name branch or a `slowPsp` capability.

## Verification

- `tests/launcher-sim.test.ts` — admission matrix, the full
  launch/summon/resume protocol on the sim host policy runner
  (hosts/sim/launcher.ts), SELECT stripping + host-edge latching, and
  determinism (two identical journeys hash identically frame by frame).
- `tests/e2e/launcher-ppsspp.ts` (`bun run e2e:launcher`) — the same journey
  on the REAL native host in PPSSPPHeadless with a 20 Hz baked input script.
  A switch discards exactly one presented frame, so the capture signature is
  exact: 77/80 files with gaps precisely at the three switch frames.
- `tests/e2e/launcher-vita3k.ts` (`bun run e2e:launcher:vita`) — builds the real launcher VPK, checks its
  four default LiveArea assets, installs it into an isolated VitaFS, and
  drives launcher → Café → launcher → Chrome → launcher → resumed Chrome →
  launcher → Café. Nine sparse captures must each be 960×544, non-flat,
  native-detail pixels and carry a matching `{appIndex, appOutput, appId}`
  sidecar. Café and Chrome are relaunched at the same guest-local age and
  must be byte-identical, proving deterministic teardown/resource reuse.

  ```sh
  bun run e2e:launcher:vita
  ```

- None of these suites commits launcher pixels as goldens: covers are live sim
  renders of the other demos, and a committed deck PNG would break on any
  demo's visual change. Determinism is asserted by hash equality instead.
- Native gotcha the e2e caught: the GE leaves framebuffer alpha at 0, so
  the frozen-shot capture forces alpha 255 or the background blends away.
- PSP real-hardware functional pass: DONE (PSPLINK, iterated live) — it found the clock
  never being set, the affine seam, the texture-heap OOM, 4444 banding,
  the crop deformation and the sweep seams; each fix is annotated at its
  site. PPSSPP's software GE reproduces most of these; the sim none. The Vita
  VPK also passed real-device switching tests after deterministic Vita3K
  coverage; PSP Cover Flow pacing under held browse input remains a separate
  real-hardware performance gate.

## The launcher app

`apps/launcher` — an ordinary manifest app (requires `text.glyphs.baked` +
`input.buttons`). Cover Flow built on the 2D core's perspective pipeline
(the same TEX_TRI path motions page 4 ships): one `perspective` root, one
screen-aspect (192×109) cover card per app, center card flat, neighbors angled with `rotateY` ±
rail `translateX` + recession `translateZ`. Browse motion is short
`animate()` tweens retargeted per step (springs let a mashed d-pad outrun
the deck — a real-hardware find), so steady state still runs zero per-frame
JS. When summoned, the frozen shot stretches under a dim scrim — the
"overlay" is honest compositing inside one guest, over a baked Aqua-era
stage gradient. All four browse inputs (d-pad LEFT/RIGHT and the L/R
triggers) are ONE mechanism: holding scrubs the deck continuously through
fractional positions at 10 cards/s (per-frame `jump()`s; release tweens
home from the exact fraction), and a quick tap always lands exactly one
card — a flow that ends displaced never rounds back onto its origin.
CIRCLE launches the centered card — console convention; SELECT/CROSS
resume the interrupted app. XMB identity ships in `apps/launcher/psp/`
(Psp.toml + committed icon0/pic1, regenerated by the build's art step); the
Vita VPK carries PocketJS's validated default LiveArea asset set.

## Native process navigation on E7

**An app table with `kind: "native"` identifies installed process navigation.**
Its `launchApp` foregrounds a retained task or starts an installed UID; it does
not replace the current guest. The embedded-catalog relaunch rules above apply
to tables without this marker. The E7 host owns the child return strip and
calls `onNativeAppReturn` before Shell resumes. `closeApp` requests a native
child task to exit. See [the E7 registry and return contract](SYMBIAN_E7.md#installed-app-navigation).
