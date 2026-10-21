# Repository structure

**Programs compose runtime instances, drivers and platform hooks.** Engine
libraries hold contracts and shared mechanisms. Operating-system and SDK drivers
live in `platforms/`; GPU mechanisms and DrawList drivers live in `devices/`.

```text
pocketjs/
├─ Cargo.toml, Cargo.lock    shared dependency graph and lockfile
├─ rust-toolchain.toml      fixed stable compiler for portable libraries
├─ contracts/
│  ├─ spec/                 formats, operations, driver ABI and profile schema
│  ├─ generated/            generated C headers and package readers
│  └─ schema/               application manifest JSON schema
├─ engine/
│  ├─ spec/                 generated no_std constants and ABI records
│  ├─ drivers/              resource views and device-class contracts
│  ├─ core/                 retained UI tree, layout, text and animation
│  ├─ render/               operation decoding, glyph pages, batches and caches
│  ├─ raster/               software rendering
│  ├─ present/              damage history and presentation transactions
│  ├─ package/              package, asset and font archive readers and hashing
│  ├─ runtime/              instance lifecycle, admission, input and scheduling
│  ├─ runtime-cabi/         instance C ABI and retained compatibility adapters
│  ├─ guest-quickjs/        C guest lifecycle and generated operation bindings
│  ├─ guest-rquickjs/       Rust guest lifecycle and generated operation bindings
│  ├─ guest-web/            generated browser guest bindings
│  ├─ modules/              media transport and shared offload queues
│  ├─ backends/gpui/        desktop renderer and text integration
│  ├─ ios/                 UIKit runtime integration
│  ├─ crates/              module, UI embedding, text and widget libraries
│  └─ pocket3d/            3D libraries and examples
├─ devices/                 GPU mechanisms and DrawList renderers
│  ├─ psp/ vita/ 3ds/       fixed-console GPU libraries
│  ├─ gles/                 GLES traversal and GLES1/GLES2 pipelines
│  └─ web/                  wgpu mechanism library and renderer
├─ platforms/               OS, SDK and fixed-console drivers
│  ├─ psp/ vita/ 3ds/       input, display, audio, I/O and system services
│  ├─ gba/ rockbox/         display and input adapters
│  ├─ web/ sim/             browser and deterministic service providers
│  ├─ android/               JNI helpers, input queue, logging and clock
│  ├─ linux/ posix/         DRM, fbdev, evdev, ALSA and transport
│  └─ esp-idf/ zephyr/      SDK drivers, hooks and build descriptions
├─ profiles/                software contracts identified by content hashes
├─ programs/
│  ├─ psp/ vita/ 3ds/       console entries and runtime configurations
│  ├─ gba/ ipodnano/        fixed-console programs
│  ├─ web/ sim/ desktop/    reference programs and their composition
│  ├─ linux-kms/            Linux program with its own profile
│  ├─ esp-idf/archive/      one Rust archive for the IDF composition
│  └─ native/               compatibility C-shell composition and QuickJS glue
├─ framework/               guest APIs and application compiler
├─ microts/                 TypeScript model and view compilation
├─ tools/
│  ├─ build/                executor, program recipes, bakers and toolchains
│  ├─ packaging/            IDF, Zephyr, Buildroot and CMake adapters
│  ├─ release/              archive generation, verification and retrieval
│  ├─ repack/               application replacement in runtime bundles
│  ├─ dev/                  development servers
│  └─ cli/                  installed command entry points
├─ zephyr/module.yml        west module entry
├─ tests/                   contracts, fixtures, integration and E2E tests
│  └─ esp-idf/              IDF sample programs and test harnesses
├─ apps/                    applications with pocket.json manifests
├─ assets/                  maintained fonts, artwork and branding
├─ docs/ site/              reference documentation and website
└─ .pocket-build/           ignored build and validation output
```

**Device ports live in the separate Pocket Museum repository.** Their profiles,
runtime configurations, build tools, tests and runbooks move with the programs.
See [Museum migration](MUSEUM.md). The 3DS product remains under
`programs/3ds/product` until its separate product extraction. These moves have
separate commits from the directory split.

## Ownership and dependency rules

**`engine/runtime` owns application instances.** Each instance owns its package,
guest, input encoding and display/renderer registrations. `engine/runtime-cabi`
exposes instance handles. Compatibility entry points delegate to this state;
`programs/native/cabi` supplies the historical archive name and program
composition. `programs/web/wasm` compiles the browser composition against the
same runtime and C ABI.

**Platform drivers do not depend on programs or the UI core.** Drivers receive
resource views, input builders and transport buffers through their interfaces.
The font archive reader in `pocket-package` lets an I/O worker load glyphs
without linking the UI tree. A program selects implementations in code and
provides its memory budgets and private services.

**DrawList renderers consume `FrameInput` and `RenderResources`.** GPU mechanism
libraries retain their device interfaces. `pocket-present` owns damage history
and orders render completion, display transfer and resource retirement.
`pocket-ui-wgpu` adapts existing desktop embedding APIs to `pocket-web-render`.

**`contracts/spec/ui-ops.ts` defines 61 public operations and six private guest
hooks.** `tools/ui-bindings.ts` generates the runtime dispatcher and guest
operation descriptors. Missing service providers leave their guest methods
absent. Package format 2 records profile hashes; binding generation 12 identifies
the generated script interface. Driver and runtime C tables use `struct_size`
prefix compatibility.

## Build and distribution

**One root Cargo workspace shares one lockfile.** Library, platform and program
crates inherit versioned dependencies. Default members build on the desktop;
console recipes select a package, target and compiler. Test and fuzz harnesses
with isolated dependency graphs retain their own lockfiles. Stable is fixed in
`rust-toolchain.toml`; `tools/build/toolchains/rust.ts` supplies one build-std
nightly, and `esp.ts` pins the Xtensa compiler.

**Application compilation and native builds have separate inputs.** `pocket.json`
describes an application. A program's `pocket.runtime-config.ts` imports its
profile and declares native build steps. The executor verifies application
inputs, compiler identity and source hashes before writing a build receipt.
IDF, Zephyr and Buildroot retain ownership of their firmware configuration.

**SDK exports contain one no_std Rust archive.** `pocket sdk export` retrieves a
verified release; `pocket sdk build` creates a local candidate. Canonical headers,
C guest sources and a hash manifest accompany the archive. CMake consumers use
`Pocket::runtime` and `Pocket::guest_quickjs`; see [SDK.md](SDK.md).

The npm package contains the framework, compiler, profiles, command tools,
generated contracts and browser assets. **Native source is distributed through
Cargo and source releases.** Web assets preserve `programs/web` and
`platforms/web` paths so module imports and worker URLs resolve in deployed
artifacts. `tools/build/web-assets.ts` stages these files for programs, the site
and Pocket3D consumers.

## Adding code

- Add a shared mechanism under `engine/` and expose the types it needs.
- Add an OS or SDK driver under `platforms/`; add GPU code under `devices/`.
- Put composition and entry points under `programs/`, with a runtime config.
- Keep product-specific profiles with the product; tree-owned profiles live in
  `profiles/`.
- Put compilation, packaging and release orchestration under `tools/`.
- Put application demos under `apps/`, with a `pocket.json` manifest.
- Define contracts in `contracts/spec/` and generate language bindings.
- Keep run logs, screenshots and receipts under ignored
  `.pocket-build/validation/<task>/<run>/`. Maintained fixtures belong in `tests/`.

Directory moves preserve public framework import keys through the package export
map. Device profiles and tools that leave for Museum are tracked as a separate
migration with their owning programs.

Solid AOT admission, contract mapping and JSX lowering live in `microts/compiler/aot-solid-frontend.ts`. Both front ends share `aot-contract.ts`, `aot-program.ts` and the Rust generator. The reference is `site/content/docs/microts-solid.md`; `apps/solid-aot-lab/` contains the TSX view and compiled TypeScript model example.

**Model AOT admission is separate from View IR.** `microts/compiler/aot-model-frontend.ts` builds Model IR, `aot-model-ledger.ts` records dependencies and schedules reactions, and `aot-model-tasks.ts` lowers task continuations. `aot-model-codegen.ts` emits Rust; `aot-model-js.ts` emits the browser and guest model. `model-interp.ts` executes the reference contract, and `model-fuzz.ts` generates programs for differential tests. The runtime protocol lives in `engine/crates/microts/src/model.rs`; JavaScript scheduling and service delivery live in `framework/src/model-reactive.ts` and `model-tasks.ts`. The reference is `site/content/docs/microts-model.md`.
