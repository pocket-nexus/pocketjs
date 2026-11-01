# From launcher to platform — the Pocket app-runtime roadmap

LAUNCHER.md specifies what ships today: one PSP EBOOT or Vita VPK, every
target-admissible app embedded, whole-guest switching behind three append-only
surface ops. This document is the forward design: what turns that launcher
into a platform — a mini-app runtime with an install story, a system
transition, and a DX that stays instant — without breaking the contracts that
got us here.

The one-line thesis: **Pocket is already most of a mini-app runtime, and
its unfair advantage is determinism.** Same bundle + same inputs = same
bytes on screen, on every host. That means third-party packages can be
admission-checked, golden-verified and byte-audited by CI — platform
review as a pure function, not a queue of humans.

## Layers (what exists, what's missing)

| layer | contents | status |
|---|---|---|
| L0 contract | spec.ts ISA, append-only ops, capability registry, app contract admission | SHIPPED — the platform's constitution |
| L1 hosts | psp / vita / sim / web against one HostOps contract; guest lifecycle (boot/teardown/switch) | switching shipped on psp + vita + sim + web |
| L2 distribution | `.pocket` package, on-device install, host-relay push | format 2 (below); install + push next |
| L3 experience | launcher-as-Home, switch veil, DevTools time travel | launcher shipped; veil below |

Rule 5 of RUNTIMES.md stays the platform's first law: every capability a
guest can observe is a surface op behind a capability id — never a host
branch. The launcher followed it (ops 39..41) and stayed testable on every
host; distribution must follow it too.

This document covers the **guest execution class**: one portable bundle
with runtime admission against the host's facts. `app.aot` admits the entry to
AOT compilation; guest hosts reject packages without a guest artifact.

## The switch veil (system transition)

A guest swap has a dead window: teardown is instant but the incoming
bundle's `JS_Eval` blocks the worker for 0.3–0.5 s (dev-trace builds print
boot stages there, which is the "QuickJS log stream" seen on hardware;
production builds hold the last frame). The veil turns that window into a
designed moment:

- After the outgoing frame presents (and the summon shot is captured), the
  HOST owns the GE. It plays a short direct-drawn animation — ~24 vblanks:
  frozen shot (or stage black) dimmed underneath, the baked Pocket mark
  fading in centered, a highlight sweeping across it — then starts the
  eval. The display holds the settled last veil frame through the eval,
  and the incoming guest's first present replaces it.
- Everything is host-side and asset-baked (the mark rasterizes from
  `assets/brand/` at build time into an embedded RGBA texture; the sweep
  is vertex-alpha strips over the same texture, additive-blended — the
  PSP-era way to mask a glow to a glyph without a second texture).
- The guest never knows. No op, no capability, no sim/golden impact: veil
  frames present outside the input-indexed frame loop, so the capture
  identity (input at frame N ↔ file fN) and the e2e switch signature are
  untouched.
- Budget: one 128×128 RGBA texture (64 KB rodata) + ~100 lines of GE code.

Two refinements stack on top later, both cheap: the launcher can play a
200 ms card-zoom before calling `appLaunch` (pure JS, no host change), and
qjsc bytecode (below) shrinks the hold the veil is papering over.

## Host contracts and `.pocket` format 2

A host contract is a `pocket-host/2` JSON document: `id`, `platform`, `form`,
`cadences`, `display`, `panel`, `capabilities` and optional
`roleCapabilities`, `worker`, `limits` and `input`. Built-in host contracts live in
`hosts/<id>/pocket.host.json` and are exported from `@pocketjs/framework/hosts`.
`validatePocketProfile` in `@pocketjs/framework/profile` checks the schema,
reserved names, dynamic viewports, auxiliary screens, worker kinds and contact
coordinate limits.

**The host contract hash (`profileHash`) is SHA-256 over seven fields.** `contracts/spec/profile.ts`
defines their canonical JSON encoding. Object keys sort by UTF-16 code units;
capabilities, cadences and role capabilities sort as sets. The panel, worker
table, limits, input parameters, `hostExtension` and the `hostAbi` stamp are
excluded. **The hash is provenance: a device admits a package by its facts**
(see [admission](../site/content/docs/platform-contracts.md#admission)), so a
renamed host contract or an added capability keeps installed packages running.

The resolved build plan carries the compiled host contract with the package rate
(`profile.tickHz`) and `profileHash`.
`hostBuildEnvironment()` exports `POCKETJS_PROFILE_JSON` and
`POCKETJS_PROFILE_HASH` for the program build. **The program's expected hash
comes from its build input.** A package cannot supply its own expected value.
Programs pass these inputs into shared libraries as configuration values.
Runtime admits declared logical orientations and dynamic viewport bounds before
initializing the guest. CPU outputs and auxiliary screens use one integer
presentation scale; a primary GPU renderer maps the admitted logical viewport
to its registered target.

`contracts/spec/pocket-package.ts` defines the binary container. TypeScript,
Rust and Python readers share maintained valid and malformed fixtures.

| Region | Contents |
| --- | --- |
| Header, 32 bytes | `PCKT`, version 2, manifest length, variant count, string table offset and size, two zero reserved words |
| Manifest | Original `pocket.app.json` bytes, padded to 16 bytes |
| Variant, 64 bytes | Target string offset and size, binding generation, section count and table offset, zero reserved word, FNV-1a64 payload hash, 32-byte host contract hash |
| String table | UTF-8 target IDs, 1–65535 bytes each, without NUL terminators |
| Section entry, 16 bytes | Kind, zero reserved word, payload offset and length |
| Payloads | Identity, plan, NUL-terminated JavaScript, asset pack, cover, or other declared sections, each padded to 16 bytes |
| Footer, 8 bytes | FNV-1a64 over all preceding bytes |

Variants sort by UTF-8 bytes and section kinds increase within each variant.
Strings, section tables and payloads occupy contiguous regions in that order.
Readers reject overlap, duplicate IDs or kinds, invalid UTF-8, nonzero reserved
words, trailing data and out-of-range offsets. Unknown section kinds retain
their payloads. Empty payloads may share an offset. Thinning preserves both
the payload hash and the host contract hash.

**Format 1 packages are rejected by format 2 runtimes.**
**Every current program uses binding generation 12.** Values 1–11 from the
former per-target numbering are rejected.
See the [compatibility matrix](../site/content/docs/native-contract.md#package-and-driver-compatibility). Rebuild the application
to produce a format 2 package. Admission selects the first variant the host's
facts satisfy (binding generation, raster density, animation class, rate,
viewport, presentation, capabilities and auxiliary surface), preferring a
variant whose host contract hash equals the host's, then checks its resources.
ESP-IDF's embed step applies the same rules to the binary host-input record.

The launcher embeds original package bytes or supplies them through a file
source. A JavaScript/asset-pair embedding adapter creates a format 2 package with
its program's host contract; it does not convert an existing package to bypass
admission.

## Generic runtimes and the repack step

A generic runtime is one prebuilt host per device with no app in it. It
reads `app.pocket` at boot, checks the footer hash and takes the first variant
its facts admit; a package with none is refused with the items the closest
variant lacks.
A runtime that finds no file, or a file it refuses, shows one line on screen
that names the fault. The embedded-app build stays: the built-in games and
the dev loops use it.

The repack step turns a runtime and a game's `.pocket` into the device's
installation package in TypeScript, with no native tool and no network:

```
bun tools/runtime.ts psp            # dist/runtime/psp/EBOOT.PBP + runtime.json
bun tools/runtime.ts vita           # dist/runtime/vita/eboot.bin, LiveArea files + runtime.json
bun tools/repack.ts --target psp --runtime dist/runtime/psp --pocket game.pocket \
  --id <id> --title <title> --author <author> --version <version> [--icon icon.png] -o game.zip
```

`runtime.json` records `target`, `hostAbi`, `profileHash`, the PocketJS commit,
the host id and each file's size and SHA-256; the files include the stamped
`pocket.host.json`. `tools/repack/<target>.ts` exports
`repack<Target>({ runtime, pocket, identity })`: the runtime's files as bytes
by path, the `.pocket` bytes and the identity (id, title, author, version, a
square PNG icon). `tools/repack/shared/runtime.ts` refuses a runtime for
another target, with a file that differs from `runtime.json` or without its
host contract, a `.pocket` whose footer does not verify, one with no
variant the runtime's host contract admits, a variant whose plan does not record
its own host contract hash, and an app id other than the identity's.
The package carries the `.pocket` thinned to the target's variant. The other
shared pieces use Web-platform APIs only (a Worker runs them): `zip.ts`
(1980-01-01 dates, entries in the given order, `CompressionStream` deflate),
`png.ts`, `scale.ts`, `palette.ts` (median cut, indexed PNG-8), `sfo.ts`
(PARAM.SFO) and `crc32.ts`.

| Target | Runtime reads | Package |
| --- | --- | --- |
| `3ds-dev` | `romfs:/app.pocket` | `.3dsx` (products/3ds/README.md) |
| `psp` | `app.pocket` in the EBOOT's folder (the module's argv[0] directory) into one kernel block before the arena reserves the rest | `.zip`: `PSP/GAME/Studio<Name>/EBOOT.PBP` (PARAM.SFO with the game's `TITLE` and `MEMSIZE = 1`, ICON0 144×80 from the icon, the runtime's `DATA.PSP` unchanged) and `app.pocket` beside it; a plan that asks for `io.offload` is refused |
| `vita` | `app0:app.pocket` into one 16-byte-aligned block; no compiled app id | `.vpk`: `sce_sys/param.sfo` (byte for byte what `vita-mksfoex` writes for `tools/vita.ts`: the game's title, title id `P` + 8 hex of SHA-256(id)), the runtime's `eboot.bin` unchanged, `app.pocket`, `sce_sys/icon0.png` 128×128 indexed PNG-8 from the icon, the runtime's LiveArea files |
| `ipodtouch4-dev` | `app.pocket` in the app bundle | `.ipa`: the runtime's executable under the game's bundle name, an Info.plist with the game's bundle id (the app id), name and version, 57 and 114 px icons, `app.pocket` ([iPod touch 4](IPODTOUCH4.md)) |
| `redmi-1s-dev`, `moto-g-play-dev` | `assets/app.js` and `assets/app.pak` | `.apk`: the runtime's `template.apk` with the package name, versionCode, label, icons and the variant's bundle and pack rewritten, signed v1 + v2 with the Pocket Studio community key in Web Crypto ([Android](ANDROID.md)) |

**`tools/repack/index.ts` is the entry Pocket Studio's Worker imports.**
`REPACK_TARGETS` has one row per Studio target (`psp`, `vita`, `3ds`,
`ipod-touch`, `android`): `repack(input)`, `runtime` (the
`tools/runtime.ts` name: `psp`, `vita`, `3ds`, `ipod`, `android`),
`variantTargets` (the `.pocket` targets that target's runtimes boot),
`extension` (`.zip`, `.vpk`, `.3dsx`, `.ipa`, `.apk`), `contentType` and
`signed` (Android alone takes `input.signer`). `tools/repack.ts` reads the
files and calls the same rows. **`tests/repack-worker.test.ts` bundles the
entry and each target's module with `Bun.build({ target: "browser" })` and
fails on any Node or Bun built-in module and on any reference to `Bun`,
`process`, `require`, `__dirname` or `import.meta.dir`**; it also runs the
bundled Android module and compares its APK with the source module's.

On the PSP the game file takes the place of the embedded build's rodata
copy: with twenty48 (723 KB file) the arena's free block measured
**10 KB smaller** than the embedded build, on a PSP under PSPLINK and in
PPSSPP. `MEMSIZE = 1` gives a PSP-2000 or 3000 started from the XMB the
52 MB user partition; the PSP-1000 ignores it.

## Dynamic install & runtime admission

- **Loading**: the eval path already treats bundles as data — the PSP host
  reads `.pocket` files from `ms0:/POCKET/apps/` into the arena and evals
  exactly like an embedded entry (svc/video proved runtime file IO). The
  appTable becomes the union of embedded entries and scanned packages;
  covers come from the package. Memory model is unchanged except the
  current app's js+pak live in the heap instead of rodata — the budget
  table gains one line.
- **Admission on device**: build-time admission is
  `validateAndResolveBuildPlan`, a pure function. The device re-runs the
  decision — either a minimal Rust port of the capability-superset +
  viewport check, or (simpler first step) the pack tool embeds the
  resolved plan and the device verifies plan.target/abi/viewport against
  its own host contract. Either way: no capability, no boot — same rule as the
  build.
- **Channels, honestly ordered**: (1) copy to the memory stick — works
  today, zero code; (2) `pocket push` over the existing USB svc relay —
  the Mac downloads, verifies, writes to ms0; (3) wireless on-device
  fetch — LAST, because the PSP has no TLS and an 802.11b radio; the
  trusted downloader stays on the tethered host. Every step e2e-testable
  before the next.

## Bytecode (the eval wall)

QuickJS evals ~100 KB of source in ~0.3–0.5 s at 333 MHz; that is the
whole switch latency. Parsing also keeps every function's source text in
the heap for `Function.prototype.toString`. **A host contract that names
the QuickJS build its program embeds (`bytecode.engine`, an engine ABI of
`contracts/spec/quickjs-bytecode.ts`) gets its bundles compiled to that
build's serialized objects: section 6 for the UI bundle, section 9 for the
worker bundle.** Each section is a 48-byte `QJBC` envelope (format version,
header size, flags, the engine ABI's SHA-256 digest at byte 16) followed by
`JS_WriteObject` output. The compiler is `tools/quickjs-bytecode-compiler.c`
built on the host from the engine source the target links
(`POCKETJS_QUICKJS_SOURCE`, or a checkout of the ABI's pinned revision), and
it reads every object back before writing it; identical bundles give
identical bytes.

The source sections stay beside the bytecode unless the contract says
`"source": "drop"`. A guest whose engine ABI is the envelope's evaluates the
object with `JS_ReadObject` and `JS_EvalFunction`; a guest with another
build, or none, answers UNSUPPORTED before anything ran and the runtime
evaluates the source. A failure after the digest matched is the program's:
no source runs over a realm the object may have changed. QuickJS copies the
object into its heap, so the saving is the parser's peak and the retained
source text, not the bytecode's residency; an object is accepted at the
trust level of native code, after the package footer and variant hashes.
The ESP-IDF guest and worker carry `esp-idf-quickjs-ng-0.14.0`, whose
objects are written with `JS_WRITE_OBJ_STRIP_SOURCE`.

## Memory governance

The PSP-1000's 24 MB is the floor and texture heap is the cliff (the
reflection feature OOM'd it once — the handler parks on vblank, which in
PPSSPPHeadless looks like a silent timeout). Platform rule: `pocket pack`
computes a per-app memory line (js + pak + expected texture heap) and the
launcher displays it; admission warns when a package cannot fit the
device's arena. Budgets become data, not folklore.

## The DX pipeline (what keeps it silky)

The launcher's PSP hardware round found four bugs invisible to the sim
(nearest-sampling shimmer, the affine seam kink, the texture-heap OOM,
4-bit-alpha banding) — PPSSPP's software GE caught three, real hardware the
rest. Vita adds a native-density Vita3K leg with current-guest sidecars and
repeated resource-reuse swaps before its real-device pass. That gradient is
the platform's QA design:

1. **sim** — second-scale iteration, deterministic traces, tree asserts;
2. **console emulator** — PPSSPPHeadless exercises GE semantics (affine
   sampling, texture-cache quirks, RAM ceiling); Vita3K exercises the real Vita
   host lifecycle, 960×544 CPU-oracle renders, LiveArea VPK, and GXM resource
   boundaries under baked input scripts;
3. **hardware** — PSPLINK hot-reload (`reset` → `ldstart`) and `pspsh cp` on
   PSP; install the validated `dist/vita/launcher-main.vpk` for the Vita pass.

Single-command chains (`launcher.ts scan|covers|build`), append-only
contracts, and goldens as gates keep third-party DX at "write TSX → see it
in a second → one command to the handheld."

## Non-goals (so the platform stays honest)

- No suspend/resume state for guests — resume is relaunch, the frozen
  shot is an affordance. A KV-style `app.state` op can come later as its
  own capability; nothing in the switch protocol presumes it.
- No on-device code signing theater — the hash footer is integrity, not
  security; the PSP's threat model is a memory stick.
- No host branches for "special" apps — the launcher itself is an
  ordinary `pocket.app.json` app and must stay one.
