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
| `pocket [+<id>] check`, `compile`, `build` | [target selection](#target-selection), then `tools/pocket.ts` | checkout or project |
| `pocket [+<id>] show [--json]` | the framework, project, selection and catalog | any directory |
| `pocket default`, `pocket override` | the user default and directory overrides | any directory |
| `pocket dev`, `psp`, `vita`, `hw`, `psplink`, `devtools`, `tape`, `play`, `symbian`, `ios` | `tools/<command>.ts` | checkout |
| `pocket --version` | CLI version and resolved framework version | any directory |

`pocket` with no command, `help` or `--help` prints the command list.

## Framework resolution

**A framework is a directory whose `package.json` carries
`"pocketjs": { "protocol": <n> }`.** The package name is not read, so a fork
published under another name is recognized. `check`, `compile`, `build`,
`show`, `doctor` and `--version` take:

1. `POCKETJS_FRAMEWORK_ROOT`, when set. A directory without the marker fails
   the command.
2. Otherwise the nearest of these above the current directory: an ancestor
   that carries the marker (a checkout), or an ancestor's
   `node_modules/@pocketjs/framework`. When one directory is both, the checkout
   wins and `show` names the install it passed over.

The CLI speaks protocol 1. **A framework on another protocol stops every
command that runs it**, with both versions named. `show` reports the
framework's source: `POCKETJS_FRAMEWORK_ROOT`, `checkout`, `registry`, a git
dependency from the lockfile, a `file:` or `link:` dependency, or
`link → <path>` for a symlinked install.

### Switching to a fork

| Situation | Operation |
| --- | --- |
| develop a fork against an application | `bun link` in the fork, then `bun link @pocketjs/framework` in the application; `package.json` is not edited, and `bun install` restores the registry version |
| a fork with another package name | `"@pocketjs/framework": "link:<fork-name>"` |
| pin a fork commit for a team or CI | `"@pocketjs/framework": "github:<owner>/pocketjs#<ref>"` |
| a fork published under another name | `"@pocketjs/framework": "npm:<name>@<range>"` |
| one command | `POCKETJS_FRAMEWORK_ROOT=<dir> pocket …` |

**Manifest commands run in the current directory.** `--manifest`,
`--host-profile`, `--project-root` and `--compiler-receipt` resolve against it;
`--outdir`, `--plan-dir`, `--output` and `--depfile` resolve against the
project root. `setup` and the host-development commands use step 2 alone and
run with the checkout root as their working directory.

## Target selection

`check`, `compile`, `build` and `show` act on one target, the first of these
that is present:

1. **Explicit**: `pocket +<id> <command>`, `pocket <command> +<id>`,
   `--target <id>`, or `--host-profile <file>`. Two that differ are an error;
   `+<id>` anywhere else before `--` is an error.
2. **`POCKET_TARGET`**.
3. **A directory override** of the current directory or its nearest ancestor
   that has one (`pocket override`).
4. **The project**: the first entry of `targets` in the project configuration.
5. **The user default** (`pocket default`).

None present stops the command with the five ways to name a target. A command
prints the target and its source before it runs:

```text
pocket: target vita · directory override /work/game
```

`pocket build --all` builds every target of the project configuration in
order and stops at the first failure.

### Project configuration

`targets` in `pocket.config.ts` lists the targets a project ships to:

```ts
import { definePocketConfig } from "@pocketjs/framework/config";

export default definePocketConfig({
  targets: [
    "psp",
    "vita",
    { target: "moto-g-play", manifest: "pocket.android.json" },
    { hostProfile: "../firmware/pocket.host.json" },
  ],
});
```

**The project configuration is the nearest `pocket.config.ts` above the
manifest's directory**, the file `tools/build.ts` reads `theme` from; the
lookup stops there, and a file without `targets` names no project default.
`manifest` and `hostProfile` resolve against the file's directory. An entry's
`manifest` replaces the default `pocket.json` when the command names no
`--manifest`. A `hostProfile` entry is a target named by the profile's `id`,
which may not equal a catalog id or a `pocket` command word. An unknown id, a
missing profile and a duplicate entry are errors. The file is bundled with
`@pocketjs/framework` mapped to the resolved framework, so it evaluates in a
project without `node_modules`.

### show, default, override

| Command | Effect |
| --- | --- |
| `pocket show [--json] [--manifest <file>]` | the framework with its source, the project configuration and its targets, the selected target with its source, the host, and the catalog with the targets this host cannot install marked; exits 0 |
| `pocket default` | prints the user default |
| `pocket default <id>`, `pocket default --unset` | sets or removes it |
| `pocket override set <id> [--path <dir>]` | selects `<id>` for `<dir>` (default the current directory) and every directory below it |
| `pocket override unset [--path <dir>]`, `pocket override list` | removes one, or lists them with the one active here |

`default` and `override set` accept a catalog id or a host profile id of the
current project. Both live in `<config>/pocket-nexus/settings.json`, where
`<config>` is `XDG_CONFIG_HOME` or `~/.config`; the file is written by rename.

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
`pocket.config.ts`, `main.tsx` and `app.tsx`, and prints the `check` and
`build` commands with `--manifest apps/<name>/pocket.json`. Anywhere else it writes a standalone
project at `./<name>/`:

| File | Content |
| --- | --- |
| `pocket.json` | manifest v2: id `dev.example.<name>` with dots for hyphens, version `0.1.0`, entry `main.tsx`, output `<name>-main`, the framework, viewport and `requires` |
| `pocket.config.ts` | `targets` with the target, or the host profile for `esp-idf` |
| `main.tsx` | the mount entry for the framework (Octane imports `mount` from `@pocketjs/framework`) |
| `app.tsx` | a counter component; CROSS increments it when the target has buttons |
| `package.json` | `@pocketjs/framework` `^<CLI version>`, the framework's runtime package (`solid-js`, `vue` or `octane`) at the version the framework pins, `@pocketjs/cli` as a dev dependency, and `check`, `compile`, `build` scripts |
| `tsconfig.json` | editor type checking with `jsx: preserve`, including the framework's `jsx.d.ts` (and `vue-sfc.d.ts` for Vue Vapor); `pocket check` extends this file |
| `README.md` | the build commands; for `esp-idf`, the CMake integration |
| `.gitignore` | `node_modules/`, `dist/`, `.pocket/` |
| `pocket.host.json` | `esp-idf` without `--host-profile` |

Outside ESP-IDF the manifest declares a **480×272 `integer-fit` viewport** and
requires `text.glyphs.baked` and `input.buttons`. `pocket.config.ts` names the
target, so the `package.json` scripts carry none: `pocket check`,
`pocket compile`, and `pocket build`, with `-- --release` for `psp` and `vita`
and `--output dist/<name>.pocket` for `esp-idf`. A standalone project builds with
`bun install`, `bun run check` and `bun run build`.

### ESP-IDF scaffold

`--host-profile` reads a firmware's `pocket.host.json` and derives the manifest
from it:

| Manifest field | Source |
| --- | --- |
| `app.viewport.logical` | the first `display.logicalViewports` entry |
| `app.viewport.presentation` | `native` when `display.presentations` lists it; the first entry otherwise |
| `input.buttons` in `requires`, and the CROSS handler | present when `capabilities` lists `input.buttons` |

`pocket.config.ts` records the profile path relative to the application
directory.
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
pocket [+<id>] <check|compile|build> [+<id>] [--target <id> | --host-profile <file>] [options] [-- <backend args>]
```

| Option | Default | Effect |
| --- | --- | --- |
| `--target <id>` | [selection](#target-selection) | a target of the [catalog](#targets) |
| `--host-profile <file>` | [selection](#target-selection) | an ESP-IDF host profile |
| `--all` | — | `build` every target of the project configuration |
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
- **`compile`** runs `check`, writes `<plan-dir>/<contract target>/plan.json`, and
  compiles `<outdir>/<output>.js` and `<outdir>/<output>.pak` from that plan.
- **`build`** runs `compile` and hands the plan to the target's backend:

| Target | `build` result |
| --- | --- |
| `psp` | `tools/psp.ts` links the EBOOT with the pinned PSP toolchain: `<framework>/hosts/psp/target/mipsel-sony-psp/<profile>/EBOOT.PBP`, where `<profile>` is `release` with `-- --release` and `debug` otherwise |
| `vita` | `tools/vita.ts` builds with `cargo vita` and writes `<outdir>/vita/<output>.vpk`, `.self` and `.runtime.json`; requires VitaSDK in `VITASDK` or `~/vitasdk` |
| `pocketbook`, `web-app`, `macos-app`, `linux-app`, `macos-widget` | the `compile` output; `build` prints the bundle path and the host that loads it |
| device targets (`3ds`, `moto-g-play`, `nokia-e7`, …) | `check` and `compile`; `build` stops with the path `compile` wrote, because these targets build through their own scripts |
| `--host-profile` | a `.pocket` package holding the manifest and one variant: the target id, HostOps ABI, canonical plan, JS and pak |

`pocketjs_compile_app` in the ESP-IDF component runs
`pocket build --host-profile` with `--depfile`, so Ninja rebuilds the package
when an imported module, asset or the profile changes.
[Platform contracts](/docs/platform-contracts/) describes the plan and the
backend table; [Build pipeline](/docs/build-pipeline/) describes the compiler
that `compile` runs.

## Targets

`--target` takes a catalog id. Registered targets keep the id of
`contracts/spec/platforms.ts`; a device target is named after the device and
resolves against its profile module, whose contract id the plan and the native
host carry. A contract id given to `--target` stops with the catalog id it
belongs to.

| Catalog id | Contract target | Toolchain hosts |
| --- | --- | --- |
| `psp`, `vita`, `pocketbook`, `web-app` | the same id | macOS, Linux |
| `macos-app`, `macos-widget` | the same id | macOS |
| `linux-app` | the same id | Linux |
| `3ds` | `3ds-dev` | macOS, Linux |
| `moto-g-play`, `redmi-1s` | `moto-g-play-dev`, `redmi-1s-dev` | macOS, Linux x64 |
| `blackberry-classic` | `blackberry-qnx-dev` | macOS, Linux |
| `meizu-m8` | `meizu-m8-dev` | macOS, Linux |
| `nokia-e7` | `symbian-e7-dev` | macOS, Linux |
| `ios-simulator` | `ios-dev` | macOS on Apple silicon |
| `iphone2g`, `iphone4s`, `ipodtouch6`, `ipodtouch4` | `iphone2g-dev`, `iphone4s-dev`, `ipodtouch-dev`, `ipodtouch4-dev` | macOS |

`bun tools/pocket.ts catalog --json` prints the catalog with each target's
contract and hosts.

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
| `POCKETJS_FRAMEWORK_ROOT` | manifest commands, `show`, `doctor`, `--version` | the framework directory; step 1 of [resolution](#framework-resolution) |
| `POCKET_TARGET` | manifest commands, `show` | the target; step 2 of [selection](#target-selection) |
| `XDG_CONFIG_HOME` | `show`, `default`, `override`, manifest commands | parent of `pocket-nexus/settings.json`; `~/.config` when unset |
| `POCKET_NEXUS_CACHE_DIR` | `doctor`, `setup`, PSP builds | the toolchain cache root |
| `XDG_CACHE_HOME` | `doctor`, `setup`, PSP builds | parent of `pocket-nexus/` when `POCKET_NEXUS_CACHE_DIR` is unset |
| `PSP_SDK`, `PSPDEV` | `doctor`, PSP builds | an explicit PSP SDK; `PSP_SDK` takes precedence |
| `POCKETJS_LLVM_BIN` | `doctor`, `setup`, PSP builds | a directory containing `clang` and `llvm-ar` |
| `PPSSPP_HEADLESS` | `doctor` | the PPSSPPHeadless executable |
| `VITASDK` | Vita builds | the VitaSDK root; `~/vitasdk` when unset |
| `PORT` | `pocket dev`, `pocket devtools` | the dev server port; `8130` when unset |
