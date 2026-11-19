# Bundles and the app platform

**A PocketJS program runs one application: the bundle it embeds, or the
`app.pkb` a generic runtime reads.** This document covers what a program
admits and how it gets there: host contracts, the bundle format, generic
runtimes and the repack step, bytecode, memory governance and the DX
pipeline.

The one-line thesis: **Pocket is already most of a mini-app runtime, and
its unfair advantage is determinism.** Same bundle + same inputs = same
bytes on screen, on every host. That means third-party packages can be
admission-checked, golden-verified and byte-audited by CI — platform
review as a pure function, not a queue of humans.

## Layers (what exists, what's missing)

| layer | contents | status |
|---|---|---|
| L0 contract | spec.ts ISA, append-only ops, capability registry, build-plan resolution and package admission | SHIPPED |
| L1 hosts | psp / vita / sim / web against one HostOps contract; guest lifecycle (boot/teardown) | SHIPPED |
| L2 distribution | bundle (`.pkb`) | bundle format 1 (below); on-device install belongs to a product such as pocket-shell |
| L3 experience | DevTools time travel | SHIPPED; Home, switching and a launcher belong to a product such as pocket-shell |

Rule 5 of RUNTIMES.md stays the platform's first law: every capability a
guest can observe is a surface op behind a capability id — never a host
branch. Distribution must follow it too.

This document covers the **guest execution class**: one portable bundle
with runtime admission against the host's facts. `app.aot` admits the entry to
AOT compilation; guest hosts reject bundles without a guest artifact.

## Host contracts and the bundle format

A host contract is a `pocket-host/2` JSON document: `id`, `platform`, `form`,
`cadences`, `display`, `panel`, `capabilities` and optional `worker`, `limits`
and `input`. Built-in host contracts live in
`hosts/<id>/pocket.host.json` and are exported from `@pocketjs/framework/hosts`.
`validatePocketProfile` in `@pocketjs/framework/profile` checks the schema,
reserved names, dynamic viewports, auxiliary screens, worker kinds and contact
coordinate limits.

**The host contract hash (`profileHash`) is SHA-256 over seven fields.** `contracts/spec/profile.ts`
defines their canonical JSON encoding. Object keys sort by UTF-16 code units;
capabilities, cadences and role capabilities sort as sets. The panel, worker
table, limits, input parameters, `hostExtension` and the `hostAbi` stamp are
excluded. **The hash is provenance: a device admits a bundle by its facts**
(see [admission](../site/content/docs/platform-contracts.md#admission)), so a
renamed host contract or an added capability keeps compiled bundles running.

The resolved build plan carries the compiled host contract with the application rate
(`profile.tickHz`) and `profileHash`.
`hostBuildEnvironment()` exports `POCKETJS_PROFILE_JSON` and
`POCKETJS_PROFILE_HASH` for the program build. **The program's expected hash
comes from its build input.** A bundle cannot supply its own expected value.
Programs pass these inputs into shared libraries as configuration values.
Runtime admits declared logical orientations and dynamic viewport bounds before
initializing the guest. CPU outputs and auxiliary screens use one integer
presentation scale; a primary GPU renderer maps the admitted logical viewport
to its registered target.

`contracts/spec/bundle.ts` defines the bundle: **one compiled application for one
host contract, in one `.pkb` file.** `pocket compile` writes it. TypeScript, Rust
and Python readers share the maintained valid and malformed fixtures of
`tests/fixtures/bundles/`.

| Region | Contents |
| --- | --- |
| Header, 64 bytes | `PKBD`, version 1, binding generation, section count, FNV-1a64 hash of the section payloads, 32-byte host contract hash, two zero reserved words |
| Section table, 16 bytes per entry | Kind, zero reserved word, payload offset and length; the table starts at byte 64 |
| Payloads | One per section, in table order, each padded to 16 bytes |
| Footer, 8 bytes | FNV-1a64 over all preceding bytes |

| Kind | Section |
| --- | --- |
| 1 | identity: output, id and title as u16-length-prefixed UTF-8 |
| 2 | plan: the ResolvedBuildPlan JSON |
| 3 | js: the UI bundle, NUL-terminated |
| 4 | pak: the asset pack |
| 5 | icon: the square PNG `app.icon` names, opaque to the engine |
| 6 | bytecode: the UI bundle as a QJBC envelope |
| 7 | hostInputs: the fixed-width ESP-IDF admission record |
| 8 | workerJs: the worker bundle, NUL-terminated |
| 9 | workerBytecode: the worker bundle as a QJBC envelope |

Section kinds increase through the table and are append-only. Payloads occupy
one contiguous region in table order. Readers reject truncation, overlapping or
out-of-range offsets, duplicate or decreasing kinds, nonzero reserved words,
trailing data and hash mismatches. Unknown section kinds retain their payloads.
Empty payloads may share an offset.

**A `.pocket` file is rejected: its magic is not `PKBD`.** A multi-device
package with a manifest is pocket-shell's `.pocket`. A host that keeps such
files parses its own container and states where the sections of the one program
it boots lie through `PackageSource::sections` (the `sections` callback of
`pocket_package_source_v1`); the inspection entry points
`pocket_native_package_open_source` and `pocket_idf_package_open_source` admit
that program before boot through the same path.

**Every current program uses binding generation 12.** Values 1–11 from the
former per-target numbering are rejected.
See the [compatibility matrix](../site/content/docs/native-contract.md#bundle-and-driver-compatibility).
Admission checks the bundle's plan against the host's facts (binding generation,
raster density, animation class, rate, viewport, presentation, capabilities and
auxiliary surface), then its code sections. The host contract hash is not
compared. ESP-IDF's embed step applies the same rules to the binary host-input
record.

A program embeds original bundle bytes or supplies them through a file source.
A JavaScript/asset-pair embedding adapter creates a bundle with its program's
host contract; it does not convert an existing bundle to bypass admission.

## Generic runtimes and the repack step

A generic runtime is one prebuilt host per device with no app in it. It
reads `app.pkb` at boot, checks the footer and payload hashes and admits the
plan; a bundle its facts refuse is refused with every item it fails.
A runtime that finds no file, or a file it refuses, shows one line on screen
that names the fault. The embedded-app build stays: the built-in games and
the dev loops use it.

The repack step turns a runtime and a game's bundle into the device's
installation package in TypeScript, with no native tool and no network:

```
bun tools/runtime.ts psp            # dist/runtime/psp/EBOOT.PBP + runtime.json
bun tools/runtime.ts vita           # dist/runtime/vita/eboot.bin, LiveArea files + runtime.json
bun tools/repack.ts --target psp --runtime dist/runtime/psp --bundle game.pkb \
  --id <id> --title <title> --author <author> --version <version> [--icon icon.png] -o game.zip
```

`runtime.json` records `target`, `hostAbi`, `profileHash`, the PocketJS commit,
the host id and each file's size and SHA-256; the files include the stamped
`pocket.host.json`. `tools/repack/<target>.ts` exports
`repack<Target>({ runtime, bundle, identity })`: the runtime's files as bytes
by path, the bundle bytes and the identity (id, title, author, version, a
square PNG icon). `tools/repack/shared/runtime.ts` refuses a runtime for
another target, with a file that differs from `runtime.json` or without its
host contract, a bundle whose hashes do not verify, a plan the runtime's host
contract does not admit, a plan that does not record its own host contract
hash, and an app id other than the identity's. The device package carries the
bundle byte for byte. The other shared pieces use Web-platform APIs only (a
Worker runs them): `zip.ts` (1980-01-01 dates, entries in the given order,
`CompressionStream` deflate), `png.ts`, `scale.ts`, `palette.ts` (median
cut, indexed PNG-8), `sfo.ts` (PARAM.SFO) and `crc32.ts`.

| Target | Runtime reads | Package |
| --- | --- | --- |
| `3ds-runtime` | `romfs:/app.pkb` | `.3dsx` (programs/3ds/README.md) |
| `psp` | `app.pkb` in the EBOOT's folder (the module's argv[0] directory) into one kernel block before the arena reserves the rest | `.zip`: `PSP/GAME/Studio<Name>/EBOOT.PBP` (PARAM.SFO with the game's `TITLE` and `MEMSIZE = 1`, ICON0 144×80 from the icon, the runtime's `DATA.PSP` unchanged) and `app.pkb` beside it; a plan that asks for `io.offload` is refused |
| `vita` | `app0:app.pkb` into one 16-byte-aligned block; no compiled app id | `.vpk`: `sce_sys/param.sfo` (byte for byte what `vita-mksfoex` writes for `tools/vita.ts`: the game's title, title id `P` + 8 hex of SHA-256(id)), the runtime's `eboot.bin` unchanged, `app.pkb`, `sce_sys/icon0.png` 128×128 indexed PNG-8 from the icon, the runtime's LiveArea files |
| `ipodtouch4-dev` | `app.pkb` in the app bundle | `.ipa`: the runtime's executable under the game's bundle name, an Info.plist with the game's bundle id (the app id), name and version, 57 and 114 px icons, `app.pkb` ([iPod touch 4](IPODTOUCH4.md)) |

**`tools/repack/index.ts` is the entry Pocket Studio's Worker imports.**
`REPACK_TARGETS` has one row per Studio target (`psp`, `vita`, `3ds`,
`ipod-touch`): `repack(input)`, `runtime` (the
`tools/runtime.ts` name: `psp`, `vita`, `3ds`, `ipod`),
`runtimeTargets` (the host contracts that target's runtimes are built for),
`extension` (`.zip`, `.vpk`, `.3dsx`, `.ipa`), `contentType`. `tools/repack.ts` reads the
files and calls the same rows. **`tests/repack-worker.test.ts` bundles the
entry and each target's module with `Bun.build({ target: "browser" })` and
fails on any Node or Bun built-in module and on any reference to `Bun`,
`process`, `require`, `__dirname` or `import.meta.dir`**.

On the PSP the game file takes the place of the embedded build's rodata
copy: with twenty48 (723 KB file) the arena's free block measured
**10 KB smaller** than the embedded build, on a PSP under PSPLINK and in
PPSSPP. `MEMSIZE = 1` gives a PSP-2000 or 3000 started from the XMB the
52 MB user partition; the PSP-1000 ignores it.

## Installing applications on a device

**A PocketJS program runs one application.** Installing applications on a
device, listing them, switching between them and keeping several of them with
a manifest in one file belong to a product such as pocket-shell, whose
`.pocket` container and launcher do that. Such a product reads its container
and gives the runtime the program it boots through a package source. On the
PSP it builds its own program crate over the `pocketjs-psp` library, which
boots and drops a guest any number of times in one process
([programs/psp](../programs/psp/README.md)).

## Bytecode (the eval wall)

QuickJS evals ~100 KB of source in ~0.3–0.5 s at 333 MHz; that is most of
a guest's boot time. Parsing also keeps every function's source text in
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
trust level of native code, after the bundle's footer and payload hashes.
The ESP-IDF guest and worker carry `esp-idf-quickjs-ng-0.14.0`, whose
objects are written with `JS_WRITE_OBJ_STRIP_SOURCE`.

## Memory governance

The PSP-1000's 24 MB is the floor and texture heap is the cliff (the
reflection feature OOM'd it once — the handler parks on vblank, which in
PPSSPPHeadless looks like a silent timeout). Platform rule: `pocket pack`
computes a per-app memory line (js + pak + expected texture heap);
admission warns when a package cannot fit the
device's arena. Budgets become data, not folklore. **A program may also
bound the decoded textures of a package it reads in place:
`pocket_runtime_set_texture_budget` keeps that many bytes of package
textures past a frame, releases the least recently drawn ones beyond it
when a frame is drawn (never one the previous frame drew or one pinned by
a deferred submission) and decodes a released texture from the package
again when a frame draws it. A frame decodes the textures it records on
the thread that records it, so a renderer on another thread only reads
them; a released texture the arena cannot hold again draws nothing in
that frame and is decoded by the next frame that draws it.** Font atlases
of such a package are read in place throughout.

## The DX pipeline (what keeps it silky)

A PSP hardware round found four bugs invisible to the sim
(nearest-sampling shimmer, the affine seam kink, the texture-heap OOM,
4-bit-alpha banding) — PPSSPP's software GE caught three, real hardware the
rest. Vita adds a native-density Vita3K leg before its real-device pass. That
gradient is the platform's QA design:

1. **sim** — second-scale iteration, deterministic traces, tree asserts;
2. **console emulator** — PPSSPPHeadless exercises GE semantics (affine
   sampling, texture-cache quirks, RAM ceiling); Vita3K exercises the real Vita
   host lifecycle, 960×544 CPU-oracle renders, LiveArea VPK, and GXM resource
   boundaries under baked input scripts;
3. **hardware** — PSPLINK hot-reload (`reset` → `ldstart`) and `pspsh cp` on
   PSP; install the VPK that passed Vita3K for the Vita pass.

Append-only contracts and goldens as gates keep third-party DX at "write
TSX → see it in a second → one command to the handheld."

## Non-goals (so the platform stays honest)

- No suspend/resume state for guests — a guest booted again starts fresh.
- No on-device code signing theater — the hash footer is integrity, not
  security; the PSP's threat model is a memory stick.
- No host branches for "special" apps — the host has no branch on an
  application's name.
