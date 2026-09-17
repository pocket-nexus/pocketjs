# Repository structure

The tree mirrors the platform ontology from [RUNTIMES.md](RUNTIMES.md) —
**Cores + Surfaces + Guest** — plus the compiler family, the contracts that
bind the layers, and the products built on top. One axis per top-level
directory; nothing else gets a top-level name.

```
pocketjs/
├─ engine/       Cores: the Rust simulation cores
│  ├─ core/       pocketjs-core — retained UI tree, taffy layout, damage + raster (standalone crate)
│  ├─ backends/    platform render backends (ESP32-P4 PPA is a standalone no_std
│  │              crate; gpui is the standalone native desktop backend with native
│  │              text layout — docs/BACKENDS.md)
│  ├─ wasm/       core compiled to wasm32 for web/sim hosts (standalone crate)
│  ├─ ui-cabi/    no_std UI C ABI: software raster + GLES1/GLES2 backends (standalone crate)
│  ├─ quickjs-c/  portable QuickJS guest driver used by native C hosts
│  ├─ ios/        iOS C ABI and UIKit PocketSurfaceView
│  ├─ pocket3d/   the 3D core family (bsp, cook, gu, vita, GLES2) + desktop examples
│  ├─ crates/     non-3D engine crates: pocket-micro, pocket-mod, pocket-ui-surface, pocket-ui-wgpu, pocket-vrm, pocket-widget
│  └─ Cargo.toml  the desktop workspace root (core/, wasm/, ui-cabi/, and
│                 console-toolchain crates are deliberately excluded and
│                 standalone; see each crate's Cargo.toml for its toolchain)
├─ hosts/        Surfaces: every embedding of the cores
│  ├─ psp/        QuickJS + rust-psp EBOOT host (feature `quickjs`; off, it is the PSP substrate a compiled app links)
│  ├─ psp-micro/  Pocket Micro EBOOT host: a compiled Micro TS app + core + sceGu, no JS engine
│  ├─ vita/       Vita host
│  ├─ esp32p4/    reusable ESP-IDF PPA adapter + component smoke build
│  ├─ pocketbook/ PocketBook e-reader host (inkview, standalone lone-bin crate)
│  ├─ nokia-e7/   Nokia E7 Qt/QuickJS host + visible toolchain probe
│  ├─ ios-legacy/ UIKit host shared by the iPhone 2G and iPhone 4S ports
│  ├─ ios-nativescript/ NativeScript iOS shell over engine/ios + @nativescript/pocketjs
│  ├─ blackberry-classic/ input sampling shared by both BlackBerry Classic hosts
│  ├─ blackberry-classic-qnx/ BlackBerry 10 Core Native embedding
│  ├─ blackberry-classic-android/ BlackBerry 10 Android Runtime embedding
│  ├─ desktop/    gpui window host — macos-app + linux-app (standalone lone-bin crate)
│  ├─ web/        browser dev + Pocket System host (wasm core, isolated iframe Realms)
│  └─ sim/        deterministic headless simulation host (docs/DETERMINISM.md)
├─ framework/    Guest: @pocketjs/framework
│  ├─ src/        the TS runtime (Solid + Vue Vapor renderers, components, input, osk…)
│  └─ compiler/   the interpreted-path build pipeline (jsx-plugin, tailwind, pak)
├─ vapor/        Pocket Vapor: the AOT compiler family (Vue Vapor subset → GBA/GB/NES)
├─ micro/        Pocket Micro: Micro TS (a Solid + PocketJS subset) → Rust over pocketjs-core; compiler, IR, harness, tests
├─ contracts/    single sources of truth binding the layers
│  ├─ spec/       op contract, platform contracts, manifest + package spec, gen-rust + gen-c
│  ├─ generated/  generated C contract headers consumed by native hosts
│  └─ schema/     published JSON schemas (pocket-2.json)
├─ apps/         demo apps (pocket.json manifests; built by tools/build.ts)
├─ tools/        every command: build/dev/device/release bun scripts (flat),
│                plus cli/ (@pocketjs/cli), psplink/, imagegen/, and
│                symbian/ (isolated GCCE/Qt toolchain + CODA USB transport)
├─ tests/        the test suite: *.test.ts flat at the root, plus
│                e2e/ (PPSSPP, Vita3K drivers), goldens/{web,psp,vita}, tapes/, fixtures/
├─ site/         pocketjs.dev (Cloudflare)
├─ docs/         design docs (DESIGN, RUNTIMES, DETERMINISM, PLATFORM, …)
├─ skills/       repo Claude skills
├─ assets/       brand, fonts, shared art
└─ README.md, CLAUDE.md, AGENTS.md — the only markdown that lives at root
```

## Placement rules

New things go where the axis says — never invent a top-level directory:

- **A new Rust simulation core** → `engine/` (workspace member if it builds on
  desktop; excluded standalone crate if it needs a console toolchain).
- **A new platform embedding** (ESP32, 3DS, …) → `hosts/<platform>/`.
- **A new AOT backend** (Vapor gains a console) → `vapor/runtime/<console>/`;
  the vapor compiler grows a target entry, the top level does not change.
- **A new demo** → `apps/<name>/` with a `pocket.json`. Standalone products
  keep the `pocket-<name>` separate-repo convention and do not move in.
- **A new command** → `tools/<name>.ts`. No single-file top-level directories.
- **A new cross-layer contract** → `contracts/spec/`; generated code stays
  generated (`gen-rust.ts` style), never hand-forked per layer.
- **A new design doc** → `docs/`. Root keeps only README/CLAUDE/AGENTS.

## Invariants the layout preserves

- **npm surface is frozen**: `@pocketjs/framework/*` export *keys* never
  change; the `exports`/`files` maps in package.json absorb internal moves.
- **Cargo stays non-workspace where toolchains demand it**: `engine/core`,
  `engine/wasm`, `engine/ui-cabi`, `engine/backends/rgb565`, `hosts/psp`, `hosts/psp-micro`, `micro/harness`,
  `hosts/vita`, `hosts/pocketbook`, and the gu/vita 3D crates each stand alone
  with their own lockfiles. `engine/Cargo.toml` is the one desktop workspace.
- **Moves are `git mv`** — history stays traceable.
