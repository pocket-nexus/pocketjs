# CLI

`@pocketjs/cli` installs the `pocket` executable. **`pocket` runs on Bun 1.2 or
later**: it resolves a PocketJS framework — a source checkout or a project's
installed `@pocketjs/framework` — and launches that framework's Bun scripts with
its own Bun executable. Under Node, `pocket` prints the Bun install hint and
exits with status 1.

```sh
bun add -g @pocketjs/cli    # or: npm install -g @pocketjs/cli
bunx @pocketjs/cli doctor   # one invocation without a global install
```

## Commands

| Command | Runs | Where |
| --- | --- | --- |
| `pocket doctor` | toolchain report, in the CLI | any directory |
| `pocket setup [--yes]` | `tools/bootstrap.ts` | checkout |
| `pocket create <name> [options]` | scaffold, in the CLI | any directory |
| `pocket check`, `compile`, `build` | `tools/pocket.ts` | checkout or project |
| `pocket dev`, `psp`, `vita`, `hw`, `psplink`, `devtools`, `tape`, `play`, `symbian`, `ios` | `tools/<command>.ts` | checkout |
| `pocket --version` | CLI version and resolved framework version | any directory |

`pocket` with no command, `help` or `--help` prints the command list.

## Framework resolution

`check`, `compile`, `build`, `doctor` and `--version` take the first match:

1. `POCKETJS_FRAMEWORK_ROOT`, when set. The directory must contain
   `tools/pocket.ts`; a directory without it fails the command.
2. A PocketJS checkout: the nearest ancestor of the current directory whose
   `package.json` names `@pocketjs/framework`.
3. The nearest `node_modules/@pocketjs/framework` containing `tools/pocket.ts`,
   searched from the current directory upward.

**Manifest commands run in the current directory.** `--manifest`,
`--host-profile`, `--project-root` and `--compiler-receipt` resolve against it;
`--outdir`, `--plan-dir`, `--output` and `--depfile` resolve against the
project root. `setup` and the host-development commands use step 2 alone and
run with the checkout root as their working directory.

## doctor

`doctor` prints three groups and **exits with status 1 when a Core or PSP item
fails**. Optional items print a warning.

| Group | Item | Passes when |
| --- | --- | --- |
| Core | Bun | always; prints the running version and executable |
| Core | `rustup` | on `PATH` |
| Core | Rust stable + `wasm32-unknown-unknown` | the stable toolchain has the target (browser host) |
| Core | `@pocketjs/framework` | [resolution](#framework-resolution) finds a framework; prints its version, source and directory |
| PSP | Rust `nightly-2026-05-28` + `rust-src` | toolchain and component installed |
| PSP | cargo-psp tools | the tools of the pinned rust-psp revision exist in the cache with an install receipt for the host triple |
| PSP | LLVM | `clang` and `llvm-ar` exist in `POCKETJS_LLVM_BIN`, in Homebrew's `llvm/bin`, or in one `PATH` directory |
| PSP | PSP SDK | the SDK marker exists; a cached SDK needs a receipt matching the pinned tag, asset, URL and SHA-256 |
| Optional | PSPLINK host tools | `usbhostfs_pc` and `pspsh` on `PATH`; used by `pocket hw` and `pocket psplink` |
| Optional | PPSSPPHeadless | `~/ppsspp-src/build/PPSSPPHeadless` exists or `PPSSPP_HEADLESS` is set |
| Optional | ImageMagick | `magick` on `PATH` |

**The LLVM check does not read the LLVM version.** `doctor` does not check
VitaSDK, cargo-vita or ESP-IDF; `pocket symbian doctor` and `pocket ios doctor`
check the Symbian and iOS toolchains.

## setup

`setup` runs inside a checkout. After a confirmation prompt, which `--yes` or
`-y` skips, it runs `tools/bootstrap.ts` from the checkout root and prints the
`doctor` report. The bootstrap is idempotent and records each step as ok,
skip or fail:

| Step | Action |
| --- | --- |
| dependencies | `bun install --frozen-lockfile` |
| LLVM | resolves `clang` and `llvm-ar`; on macOS with Homebrew and no LLVM, `brew install llvm` |
| Rust | installs the stable toolchain with `wasm32-unknown-unknown`, and `nightly-2026-05-28` with `rust-src` |
| cargo-psp tools | installs the rust-psp revision pinned in `tools/cli/psp-toolchain.json` |
| PSP SDK | downloads the pinned SDK release and verifies its SHA-256; an SDK in `PSP_SDK` or `PSPDEV` skips the step |

**The toolchain lives in `${XDG_CACHE_HOME:-~/.cache}/pocket-nexus`**;
`POCKET_NEXUS_CACHE_DIR` replaces that root. The bootstrap writes
`<cache>/psp/env.sh`, which exports `PSP_SDK`, `PSPDEV` and a `PATH` with the
cargo-psp and LLVM directories. For a custom SDK, set `PSP_SDK` or `PSPDEV`;
`PSP_SDK` takes precedence. A PSP build validates an explicit SDK path and
exports both names to it, so a wrong path fails instead of selecting a cached
SDK. The bootstrap reads no sibling source checkout.

## create

```sh
pocket create <name> [--target <target>] [--framework <framework>] [--host-profile <file>]
```

| Option | Values | Default |
| --- | --- | --- |
| `<name>` | lowercase kebab-case, `^[a-z][a-z0-9-]*$` | required |
| `--target` | `psp`, `vita`, `pocketbook`, `web-app`, `macos-app`, `linux-app`, `esp-idf` | `psp`; `esp-idf` with `--host-profile` |
| `--framework` | `solid`, `vue-vapor`, `octane` | `solid` |
| `--host-profile` | path to an ESP-IDF `pocket.host.json` | none |

`--host-profile` with a target other than `esp-idf` is an error. `macos-widget`
is not a `create` target: **widget-form targets host dynamic viewports, and the
scaffold declares a fixed viewport.** An existing destination directory is an
error.

### Output

Inside a checkout, `create` writes `apps/<name>/` with `pocket.json`,
`main.tsx` and `app.tsx`, and prints the `check` and `build` commands with
`--manifest apps/<name>/pocket.json`. Anywhere else it writes a standalone
project at `./<name>/`:

| File | Content |
| --- | --- |
| `pocket.json` | manifest v2: id `dev.example.<name>` with dots for hyphens, version `0.1.0`, entry `main.tsx`, output `<name>-main`, the framework, viewport and `requires` |
| `main.tsx` | the mount entry for the framework (Octane imports `mount` from `@pocketjs/framework`) |
| `app.tsx` | a counter component; CROSS increments it when the target has buttons |
| `package.json` | `@pocketjs/framework` `^<CLI version>`, the framework's runtime package (`solid-js`, `vue` or `octane`) at the version the framework pins, `@pocketjs/cli` as a dev dependency, and `check`, `compile`, `build` scripts |
| `tsconfig.json` | editor type checking with `jsx: preserve`, including the framework's `jsx.d.ts` (and `vue-sfc.d.ts` for Vue Vapor); `pocket check` extends this file |
| `README.md` | the build commands; for `esp-idf`, the CMake integration |
| `.gitignore` | `node_modules/`, `dist/`, `.pocket/` |
| `pocket.host.json` | `esp-idf` without `--host-profile` |

Outside ESP-IDF the manifest declares a **480×272 `integer-fit` viewport** and
requires `text.glyphs.baked` and `input.buttons`. The `package.json` scripts
depend on the target:

| Target | `check` | `build` |
| --- | --- | --- |
| `psp`, `vita` | `pocket check --target <target>` | `pocket build --target <target> -- --release` |
| `pocketbook`, `web-app`, `macos-app`, `linux-app` | `pocket check --target <target>` | `pocket build --target <target>` |
| `esp-idf` | `pocket check --host-profile <profile>` | `pocket build --host-profile <profile> --output dist/<name>.pocket` |

`compile` has the arguments of `check`. A standalone project builds with
`bun install`, `bun run check` and `bun run build`.

### ESP-IDF scaffold

`--host-profile` reads a firmware's `pocket.host.json` and derives the manifest
from it:

| Manifest field | Source |
| --- | --- |
| `app.viewport.logical` | the first `display.logicalViewports` entry |
| `app.viewport.presentation` | `native` when `display.presentations` lists it; the first entry otherwise |
| `input.buttons` in `requires`, and the CROSS handler | present when `capabilities` lists `input.buttons` |

The scripts record the profile path relative to the application directory.
`create` reads the three fields above; **`pocket check` validates the full
profile schema.** `--target esp-idf` without `--host-profile` writes a starting
`pocket.host.json` for the firmware repository to own: id `<name>` cut to 15
bytes, `takeover` form, 60 Hz, a 320×240 physical and logical viewport,
`native` presentation, density 1, `input.buttons` and `text.glyphs.baked`.

The README carries `pocketjs_compile_app` and `pocketjs_embed_package` calls
for an application directory at `<firmware root>/<name>/`. See
[ESP-IDF](/docs/esp-idf/#build-an-application-package) for both integrations.

## check, compile, build

```sh
pocket <check|compile|build> (--target <id> | --host-profile <file>) [options] [-- <backend args>]
```

| Option | Default | Effect |
| --- | --- | --- |
| `--target <id>` | — | a target registered in `contracts/spec/platforms.ts` |
| `--host-profile <file>` | — | an ESP-IDF host profile; the command takes exactly one of `--target` and `--host-profile` |
| `--manifest <file>` | `pocket.json` | the application manifest |
| `--project-root <dir>` | the manifest's directory | base for the entry, `tsconfig.json`, `--outdir`, `--plan-dir`, `--output` and `--depfile` |
| `--outdir <dir>` | `dist` | compiled output |
| `--plan-dir <dir>` | `.pocket` | resolved plans, one directory per target |
| `--output <file>` | `<outdir>/<output>.pocket` | package path; `build --host-profile` |
| `--depfile <file>` | — | Ninja depfile of every compiler input; `build --host-profile` |
| `--compiler-receipt <file>` | — | an extra depfile input for a product-owned toolchain receipt |
| `-- <args>` | — | arguments for the PSP or Vita backend, such as `--release` |

An unrecognized option before `--` is an error.

- **`check` writes nothing.** It validates the `pocket.json` v2 schema, the
  target's capabilities against `requires`, the viewport, and the TypeScript of
  the entry and its reachable imports, using the project's `tsconfig.json` when
  one exists. It prints the plan hash.
- **`compile`** runs `check`, writes `<plan-dir>/<target>/plan.json`, and
  compiles `<outdir>/<output>.js` and `<outdir>/<output>.pak` from that plan.
- **`build`** runs `compile` and hands the plan to the target's backend:

| Target | `build` result |
| --- | --- |
| `psp` | `tools/psp.ts` links the EBOOT with the pinned PSP toolchain: `<framework>/hosts/psp/target/mipsel-sony-psp/<profile>/EBOOT.PBP`, where `<profile>` is `release` with `-- --release` and `debug` otherwise |
| `vita` | `tools/vita.ts` builds with `cargo vita` and writes `<outdir>/vita/<output>.vpk`, `.self` and `.runtime.json`; requires VitaSDK in `VITASDK` or `~/vitasdk` |
| `pocketbook`, `web-app`, `macos-app`, `linux-app`, `macos-widget` | the `compile` output; `build` prints the bundle path and the host that loads it |
| `--host-profile` | a `.pocket` package holding the manifest and one variant: the target id, HostOps ABI, canonical plan, JS and pak |

`pocketjs_compile_app` in the ESP-IDF component runs
`pocket build --host-profile` with `--depfile`, so Ninja rebuilds the package
when an imported module, asset or the profile changes.
[Platform contracts](/docs/platform-contracts/) describes the plan and the
backend table; [Build pipeline](/docs/build-pipeline/) describes the compiler
that `compile` runs.

## Host-development commands

These commands run inside a checkout with the checkout root as working
directory, and pass their arguments to the script unchanged.

| Command | Script | Purpose |
| --- | --- | --- |
| `pocket dev [<app>-main …]` | `tools/dev.ts` | build the wasm core and the named demos (`hero-main` when none is named), then serve the browser host on `127.0.0.1:8130` |
| `pocket psp <app>` | `tools/psp.ts` | build a demo's EBOOT |
| `pocket vita <app>` | `tools/vita.ts` | build a demo's VPK |
| `pocket hw [<app>]` | `tools/hw.ts` | build a demo and run it on a PSP over PSPLINK |
| `pocket psplink` | `tools/psplink.ts` | an interactive multi-app switcher for a PSP over PSPLINK |
| `pocket devtools [<app>]` | `tools/devtools.ts` | the [DevTools](/docs/devtools/) panel and the USB debug bridge |
| `pocket tape record\|replay\|tree …` | `tools/tape.ts` | record, replay and inspect input tapes against a demo bundle without a screen |
| `pocket play vita <demo>` | `tools/play.ts` | build a demo's VPK, install it under a per-demo Title ID and launch it in Vita3K |
| `pocket play ios <demo>` | `tools/play.ts` | stage a demo into the NativeScript shell and launch it on the iOS simulator |
| `pocket symbian doctor\|setup\|build\|deploy\|coda …` | `tools/symbian.ts` | the Nokia E7 toolchain, SIS packaging and CODA USB transport |
| `pocket ios doctor\|setup\|devices\|native\|build\|stage\|play …` | `tools/ios.ts` | the Apple iOS toolchain and simulator flow |

## Environment variables

| Variable | Read by | Effect |
| --- | --- | --- |
| `POCKETJS_FRAMEWORK_ROOT` | manifest commands, `doctor`, `--version` | the framework directory; step 1 of [resolution](#framework-resolution) |
| `POCKET_NEXUS_CACHE_DIR` | `doctor`, `setup`, PSP builds | the toolchain cache root |
| `XDG_CACHE_HOME` | `doctor`, `setup`, PSP builds | parent of `pocket-nexus/` when `POCKET_NEXUS_CACHE_DIR` is unset |
| `PSP_SDK`, `PSPDEV` | `doctor`, PSP builds | an explicit PSP SDK; `PSP_SDK` takes precedence |
| `POCKETJS_LLVM_BIN` | `doctor`, `setup`, PSP builds | a directory containing `clang` and `llvm-ar` |
| `PPSSPP_HEADLESS` | `doctor` | the PPSSPPHeadless executable |
| `VITASDK` | Vita builds | the VitaSDK root; `~/vitasdk` when unset |
| `PORT` | `pocket dev`, `pocket devtools` | the dev server port; `8130` when unset |
