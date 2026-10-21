# Repository structure

**Native libraries live in `engine/`; host entry points live in `hosts/`.**
The compiler, shared contracts, device libraries, applications, and build
tools have separate directories.

```
pocketjs/
├─ engine/       Cores: the Rust simulation cores
│  ├─ core/       pocketjs-core — retained UI tree, taffy layout, animation, text (standalone crate)
│  ├─ spec/       generated no_std operation constants and formats
│  ├─ drivers/    resource views, driver traits, and generated C ABI records
│  ├─ render/     draw-ops, glyph-pages, tri-batch, and tex-cache utility crates
│  ├─ raster/     software DrawList interpreter and pixel kernels
│  ├─ present/    damage history, presentation transactions, and composition
│  ├─ package/    package admission, pak readers, build facts, and SHA-256
│  ├─ modules/media/ stream readers, transport messages, and codecs
│  ├─ runtime/    instance state, generated UI dispatch, package assets, and frame scheduling
│  ├─ runtime-cabi/ instance C ABI and compatibility implementations for UI/IDF entry points
│  ├─ guest-quickjs/ C QuickJS-NG guest lifecycle and generated operation descriptors
│  ├─ guest-rquickjs/ Rust QuickJS guest implementing the runtime Guest trait
│  ├─ backends/    platform render backends (ESP32-P4 PPA is a standalone no_std
│  │              crate; gpui is the standalone native desktop backend with native
│  │              text layout — docs/BACKENDS.md)
│  ├─ wasm/       core compiled to wasm32 for web/sim hosts (standalone crate)
│  ├─ ui-cabi/    compatibility re-exports and historical allocator hooks (standalone crate)
│  ├─ quickjs-c/  legacy guest entry points under pocket_legacy_runtime_*
│  ├─ ios/        iOS C ABI and UIKit PocketSurfaceView
│  ├─ pocket3d/   the 3D core family (bsp, cook, gu, vita, GLES2) + desktop examples
│  ├─ crates/     non-3D engine crates: pocket-mod, pocket-ui-surface, pocket-ui-wgpu, pocket-vrm, pocket-widget
│  └─ Cargo.toml  the desktop workspace root (core/, wasm/, ui-cabi/, and
│                 console-toolchain crates are deliberately excluded and
│                 standalone; see each crate's Cargo.toml for its toolchain)
├─ hosts/        Surfaces: every embedding of the cores
│  ├─ psp/        QuickJS + rust-psp EBOOT host
│  ├─ vita/       Vita host
│  ├─ esp32p4/    reusable ESP-IDF PPA adapter + component smoke build
│  ├─ pocketbook/ PocketBook e-reader host (inkview, standalone lone-bin crate)
│  ├─ nokia-e7/   Nokia E7 Qt/QuickJS host + visible toolchain probe
│  ├─ ios-legacy/ UIKit host shared by the iPhone 2G and iPhone 4S ports
│  ├─ ios-nativescript/ NativeScript iOS shell over engine/ios + @nativescript/pocketjs
│  ├─ blackberry-classic/ input sampling shared by BlackBerry QNX and Android
│  ├─ blackberry-classic-qnx/ BlackBerry 10 Core Native embedding
│  ├─ desktop/    gpui window host — macos-app + linux-app (standalone lone-bin crate)
│  ├─ web/        browser dev + Pocket System host (wasm core, isolated iframe Realms)
│  └─ sim/        deterministic headless simulation host (docs/DETERMINISM.md)
├─ framework/    Guest: @pocketjs/framework
│  ├─ src/        the TS runtime (Solid + Vue Vapor renderers, components, input, osk…)
│  └─ compiler/   the interpreted-path build pipeline (jsx-plugin, tailwind, pak)
├─ microts/      MicroTS: Solid/Vue views and TypeScript models → View IR / Model IR → Rust
│                (README.md is its entry point)
├─ devices/      Pocket3D device kernels: pocket-vita-gxm, pocket-psp-ge, pocket-3ds-pica,
│                pocket-web-wgpu (the browser: a Rust crate, and web/ for the page's modules)
├─ pocket3d/     Pocket3D entry point: README.md with its design and a map of its code
│                (devices/, engine/pocket3d/, site/pocket3d/); it holds no code
├─ contracts/    single sources of truth binding the layers
│  ├─ spec/       op contract, platform contracts, manifest + package spec, gen-rust + gen-c
│  ├─ generated/  generated C contract headers consumed by native hosts
│  └─ schema/     published JSON schemas (pocket-2.json)
├─ apps/         demo apps (pocket.json manifests; built by tools/build.ts)
├─ tools/        every command: build/dev/device/release bun scripts (flat),
│                plus cli/ (@pocketjs/cli), psplink/, and
│                symbian/ (isolated GCCE/Qt toolchain + CODA USB transport)
├─ tests/        the test suite: *.test.ts flat at the root, plus
│                e2e/ (PPSSPP, Vita3K drivers), goldens/{web,psp,vita}, tapes/, fixtures/
├─ site/         pocketjs.dev (Cloudflare), plus nexus/ (pocket.nexus), pocket3d/ (3d.pocket.nexus)
│                and microts/ (microts.pocket.nexus)
├─ docs/         design docs (DESIGN, RUNTIMES, DETERMINISM, PLATFORM, …)
├─ skills/       repo Claude skills
├─ assets/       brand, fonts, shared art
└─ README.md, CLAUDE.md, AGENTS.md — the only markdown that lives at root
```

## Runtime migration

**`engine/runtime` owns application instances and their `CoreState`.** The
instance owns its package, guest, input encoding, and display/renderer
registrations. `engine/runtime-cabi` exposes instance handles and retains the
old UI and IDF implementations in `src/compat/ui` and `src/compat/idf`.
`engine/ui-cabi` and `hosts/esp-idf/native/ui-core` keep their library names as
compatibility wrappers. Their UI state uses the runtime's `CoreState`.

`contracts/spec/ui-ops.ts` records **61 numbered public calls and six private
host hooks**. `tools/ui-bindings.ts` generates the core dispatcher and C guest
operation descriptors. The Rust guest consumes the same generated descriptors.
The guest adapters perform JavaScript coercion before borrowing byte payloads;
missing service providers leave their methods absent from `ui`.

**The driver/runtime C ABI is a candidate contract.** Its generated layouts
and consumer tests do not freeze it. This migration retains the package format
and existing `hostAbi` meaning. The presentation coordinator redraws each
acquired CPU region in full until display buffers have persistent identities.
Old `quickjs-c` and `pocket-ui-surface` bindings keep their existing entry
paths while hosts adopt the instance API.

## Placement rules

New things go where the axis says — never invent a top-level directory:

- **A new Rust simulation core** → `engine/` (workspace member if it builds on
  desktop; excluded standalone crate if it needs a console toolchain).
- **A new platform embedding** (ESP32, 3DS, …) → `hosts/<platform>/`.
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
  `engine/wasm`, `engine/ui-cabi`, `engine/backends/rgb565`, `hosts/psp`,
  `hosts/vita`, `hosts/pocketbook`, and the gu/vita 3D crates each stand alone
  with their own lockfiles. `engine/Cargo.toml` is the one desktop workspace.
- **Moves are `git mv`** — history stays traceable.

Solid AOT admission, contract mapping and JSX lowering live in `microts/compiler/aot-solid-frontend.ts`. Both front ends share `aot-contract.ts`, `aot-program.ts` and the Rust generator. The reference is `site/content/docs/microts-solid.md`; `apps/solid-aot-lab/` contains the TSX view and compiled TypeScript model example.

**Model AOT admission is separate from View IR.** `microts/compiler/aot-model-frontend.ts` builds Model IR, `aot-model-ledger.ts` records dependencies and schedules reactions, and `aot-model-tasks.ts` lowers task continuations. `aot-model-codegen.ts` emits Rust; `aot-model-js.ts` emits the browser and guest model. `model-interp.ts` executes the reference contract, and `model-fuzz.ts` generates programs for differential tests. The runtime protocol lives in `engine/crates/microts/src/model.rs`; JavaScript scheduling and service delivery live in `framework/src/model-reactive.ts` and `model-tasks.ts`. The reference is `site/content/docs/microts-model.md`.
