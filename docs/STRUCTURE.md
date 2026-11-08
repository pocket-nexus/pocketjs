# Repository structure

**Programs compose runtime instances, drivers and platform hooks.** Engine
libraries hold contracts and shared mechanisms. Operating-system and SDK drivers
live in `platforms/`; GPU mechanisms and DrawList drivers live in `devices/`.

```text
pocketjs/
├─ Cargo.toml, Cargo.lock    shared dependency graph and lockfile
├─ rust-toolchain.toml      fixed stable compiler for portable libraries
├─ contracts/
│  ├─ spec/                 formats, operations, driver ABI and host contract schema
│  ├─ generated/            generated C headers and package readers
│  └─ schema/               app contract, host contract and system JSON schemas
├─ engine/
│  ├─ spec/                 generated no_std constants and ABI records
│  ├─ drivers/              resource views, device-class contracts, C ABI adapters and e-ink refresh
│  ├─ driver-kit/           Rust and C driver conformance checks
│  ├─ core/                 retained UI tree, layout, text and animation
│  ├─ physics/              2D bodies, contacts, zones and emitters for ui.physics
│  ├─ render/               operation decoding, vertex batches, texture and glyph caches, damage;
│  │                        draw-ops/, glyph-pages/, tex-cache/ forward former paths, one release
│  ├─ raster/               software rendering, incremental drawing and surface composition
│  ├─ present/              forwarding crate for the former pocket-present paths, one release
│  ├─ profile-build/        build-script support that embeds the exported host contract
│  ├─ package/              package, asset and font archive readers and hashing
│  ├─ runtime/              instance lifecycle, admission, input, presentation and C ABI bodies
│  ├─ guest-quickjs/        C guest lifecycle and generated operation bindings
│  ├─ guest-rquickjs/       Rust guest lifecycle and generated operation bindings
│  ├─ guest-web/            generated browser guest bindings
│  ├─ modules/              media transport and shared offload queues
│  ├─ host-services/        C link, launcher, fs and photo services for native programs
│  ├─ mod/                  guest hosting for the runtime family
│  ├─ ui-surface/ ui-wgpu/  UI embedding: guest surface and wgpu output
│  ├─ text/                 worker-owned text layout
│  ├─ sim/                  fixed-step prediction and reconciliation
│  ├─ vrm/ widget/          VRM characters and desktop widgets
│  ├─ microts-runtime/      `microts` crate that compiled MicroTS models and views link
│  └─ pocket3d/             Pocket3D entry point, 3D libraries, browser kernel and examples
├─ devices/                 GPU mechanisms and DrawList renderers
│  ├─ psp/ vita/ 3ds/       fixed-console GPU libraries
│  ├─ gles/                 GLES traversal and GLES1/GLES2 pipelines
│  ├─ wgpu/                 wgpu DrawList renderer
│  ├─ esp-idf/              ESP32-P4 PPA renderer
│  └─ sifli/                SF32LB5x EPIC renderer
├─ platforms/               OS, SDK and fixed-console drivers
│  ├─ psp/ vita/ 3ds/       input, display, audio, I/O and system services
│  ├─ apple/                UIKit runtime integration
│  ├─ gba/ rockbox/         display and input adapters
│  ├─ web/ sim/             browser and deterministic service providers
│  ├─ linux/ posix/         DRM, fbdev, evdev, ALSA and transport
│  ├─ esp-idf/ zephyr/      SDK drivers, hooks and build descriptions
│  └─ sifli/                RT-Thread drivers and EPIC executor
├─ hosts/                   built-in host contracts identified by content hashes
├─ programs/
│  ├─ psp/ vita/ 3ds/       console entries and host configs
│  ├─ gba/ ipodnano/        fixed-console programs
│  ├─ web/ sim/             reference programs and their composition
│  ├─ ipodtouch4/ ipodtouch6/ music-player programs
│  ├─ ios-simulator/        NativeScript shell and UIKit integration
│  ├─ nokia-e7/             Symbian program
│  ├─ pocketbook/           reader program and InkView integration
│  ├─ linux-kms/            Linux program with its own host contract
│  ├─ esp-idf/archive/      one Rust archive for the IDF composition
│  ├─ sifli/archive/        one Rust archive for the SiFli composition
│  ├─ sdk/archive/          C SDK archive: runtime symbols, allocator and host hooks
│  └─ native/               instance native programs and QuickJS composition
├─ products/
│  └─ 3ds/                  Link, launcher, camera and development product
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
├─ apps/                    applications with pocket.app.json app contracts
├─ assets/                  maintained fonts, artwork and branding
├─ docs/ site/              reference documentation and website
└─ .pocket-build/           ignored build and validation output
```

**Phone, music-player, reader and console programs live in this repository.**
Shared mechanisms belong in `engine/`, OS and SDK adapters in `platforms/`,
and GPU mechanisms in `devices/`. Programs own their entries and driver
composition; host contracts state the capabilities, display and cadences a
program provides. Device age and product category do not determine directory
or repository ownership. See
[Device native builds](DEVICE_BUILDS.md).

**The M5Stack Tab5 program lives in pocket-nexus/pocket-m5.** It pins this
repository as a submodule and composes the `platforms/esp-idf` components,
`engine/host-services` and the IDF archive; its host contract (`tab5-home`,
`programs/m5stack-tab5/pocket.host.json`) lives with the program.

**The 3DS product lives in `products/3ds`.**
Its private package inspection, Link, camera, launcher and development services
are separate from the file-backed reference program in `programs/3ds`. Both
compose the native program, the QuickJS facade, the generated guest and the
PICA driver.

## Ownership and dependency rules

**`engine/runtime` owns application instances.** Each instance owns its package,
guest, input encoding and display/renderer registrations. `pocket_runtime::abi`
holds the instance handle, package admission and the bodies of the
`pocket_runtime_*` functions; `pocket_drivers::abi` holds the C records, the
pointer checks and the adapters between C vtables and the driver traits.
`programs/sdk/archive` defines each exported `pocket_runtime.h` symbol once,
with the allocator, panic handler and host hooks of a link unit; the IDF, SiFli
and 3DS archives re-export it. `programs/native/runtime` supplies the native
program composition; its `host-backend` and `host-hooks` features leave outputs
and hooks to the host, and the 3DS archive links it that way for the QuickJS
facade in `programs/native/quickjs`. `programs/web/wasm` compiles the browser composition
against the same runtime and decodes operation arguments with
`pocket_runtime::abi`.

**Platform drivers do not depend on programs or the UI core.** Drivers receive
resource views, input builders and transport buffers through their interfaces.
The font archive reader in `pocket-package` lets an I/O worker load glyphs
without linking the UI tree. A program selects implementations in code and
provides its memory budgets and private services.

**DrawList renderers consume `FrameInput` and `RenderResources`.** GPU mechanism
libraries retain their device interfaces. `pocket-render` owns DrawList
decoding, vertex batching, texture and glyph page retention and damage
history; `pocket-raster` draws on the CPU. The coordinator in
`pocket_runtime::coordinator` orders render completion, display transfer and
resource retirement. `pocketjs-core` depends on neither `pocket-raster` nor the
coordinator.
`pocket-ui-wgpu` adapts existing desktop embedding APIs to `pocket-wgpu-render`.

**`pocket-physics` implements the `Physics` trait of `pocketjs-core`.** The core
steps an installed engine once per tick and applies the `physics_values` layer
it writes; it has no engine of its own. A program installs the engine with
`Runtime::set_physics` before boot. A package or AOT artifact that requests
`ui.physics` is rejected at boot without one, and ops 52..56 stay unsupported.
`pocket-native-program`, the wasm program and `pocket-ui-surface` (for every
`UiProgram`) install it; `programs/sdk/archive` installs it in
`pocket_runtime_create` under its `physics` feature, which the SDK export
enables and the IDF and SiFli archives leave off.

**`contracts/spec/ui-ops.ts` defines 61 public operations and six private guest
hooks.** `tools/ui-bindings.ts` generates the runtime dispatcher and guest
operation descriptors. Missing service providers leave their guest methods
absent. Package format 2 records host contract hashes; binding generation 12 identifies
the generated script interface. Driver and runtime C tables use `struct_size`
prefix compatibility.

## Build and distribution

**One root Cargo workspace shares one lockfile.** Library, platform and program
crates inherit versioned dependencies. Default members build on the desktop;
console recipes select a package, target and compiler. Test and fuzz harnesses
with isolated dependency graphs retain their own lockfiles. Stable is fixed in
`rust-toolchain.toml`; `tools/build/toolchains/rust.ts` supplies one build-std
nightly, and `esp.ts` pins the Xtensa compiler.

**Application compilation and native builds have separate inputs.** `pocket.app.json`
describes an application. A program's `pocket.host.config.ts` selects its
host contract and declares native build steps. The executor verifies application
inputs, compiler identity and source hashes before writing a build receipt.
IDF, Zephyr, the SiFli SDK and Buildroot retain ownership of their firmware
configuration.

**SDK exports contain one no_std Rust archive.** `pocket sdk export` retrieves a
verified release; `pocket sdk build` creates a local candidate. Canonical headers,
C guest sources and a hash manifest accompany the archive. CMake consumers use
`Pocket::runtime` and `Pocket::guest_quickjs`; see [SDK.md](SDK.md).

The npm package contains the framework, compiler, built-in host contracts, command tools,
generated contracts and browser assets. **Native source is distributed through
Cargo and source releases.** Web assets preserve `programs/web` and
`platforms/web` paths so module imports and worker URLs resolve in deployed
artifacts. `tools/build/web-assets.ts` stages these files for programs, the site
and Pocket3D consumers.

## Adding code

- Add a shared mechanism under `engine/` and expose the types it needs.
- Add an OS or SDK driver under `platforms/`; add GPU code under `devices/`.
- Put composition and entry points under `programs/`, with a host config.
- Keep product-specific host contracts with the product; built-in host contracts
  live in `hosts/<id>/pocket.host.json`.
- Put compilation, packaging and release orchestration under `tools/`.
- Put application demos under `apps/`, with a `pocket.app.json` app contract.
- Define contracts in `contracts/spec/` and generate language bindings.
- Keep run logs, screenshots and receipts under ignored
  `.pocket-build/validation/<task>/<run>/`. Maintained fixtures belong in `tests/`.

Directory moves preserve public framework import keys through the package export
map. Device programs use the shared workspace and lockfile. A separate consumer
can still use the exported SDK or versioned Rust crates without moving the
maintained device programs out of this repository.

Solid AOT admission, contract mapping and JSX lowering live in `microts/compiler/aot-solid-frontend.ts`. Both front ends share `aot-contract.ts`, `aot-program.ts` and the Rust generator. The reference is `site/content/docs/microts-solid.md`; `apps/solid-aot-lab/` contains the TSX view and compiled TypeScript model example.

**Model AOT admission is separate from View IR.** `microts/compiler/aot-model-frontend.ts` builds Model IR, `aot-model-ledger.ts` records dependencies and schedules reactions, and `aot-model-tasks.ts` lowers task continuations. `aot-model-codegen.ts` emits Rust; `aot-model-js.ts` emits the browser and guest model. `model-interp.ts` executes the reference contract, and `model-fuzz.ts` generates programs for differential tests. The runtime protocol lives in `engine/microts-runtime/src/model.rs`; JavaScript scheduling and service delivery live in `framework/src/model-reactive.ts` and `model-tasks.ts`. The reference is `site/content/docs/microts-model.md`.
