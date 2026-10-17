# CLI

`@pocketjs/cli` installs the `pocket` executable. **`pocket` runs on Bun 1.2 or
later**: it resolves a PocketJS framework — a source checkout or a project's
installed `@pocketjs/framework` — and launches that framework's Bun scripts with
its own Bun executable. Under Node, `pocket` prints the Bun install hint and
exits with status 1.

```sh
bun add -g @pocketjs/cli    # or: npm install -g @pocketjs/cli
bunx @pocketjs/cli show     # one invocation without a global install
```

## Commands

| Command | Runs | Where |
| --- | --- | --- |
| `pocket create <name> [options]` | scaffold, in the CLI | any directory |
| `pocket [+<id>] check`, `compile`, `build` | [target selection](#target-selection), then `tools/pocket.ts` | checkout or project |
| `pocket [+<id>] show [--json]` | the framework, project, selection, and the install state of every target | any directory |
| `pocket target add`, `list`, `remove` | [target toolchains](#target-toolchains), in `tools/pocket.ts` | checkout or project |
| `pocket default`, `pocket override` | the user default and directory overrides | any directory |
| `pocket dev`, `psp`, `vita`, `hw`, `psplink`, `devtools`, `tape`, `play`, `symbian`, `ios` | `tools/<command>.ts` | checkout |
| `pocket --version` | CLI version and resolved framework version | any directory |

`pocket` with no command, `help` or `--help` prints the command list.

## Framework resolution

**A framework is a directory whose `package.json` carries
`"pocketjs": { "protocol": <n> }`.** The package name is not read, so a fork
published under another name is recognized. `check`, `compile`, `build`,
`show`, `target` and `--version` take:

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
project root. The host-development commands use step 2 alone and run with the
checkout root as their working directory.

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
| `pocket show [--json] [--manifest <file>]` | the framework with its source, the project configuration and its targets, the selected target with its source, the host, and every catalog target with its [install state](#install-states); exits 0 |
| `pocket default` | prints the user default |
| `pocket default <id>`, `pocket default --unset` | sets or removes it |
| `pocket override set <id> [--path <dir>]` | selects `<id>` for `<dir>` (default the current directory) and every directory below it |
| `pocket override unset [--path <dir>]`, `pocket override list` | removes one, or lists them with the one active here |

`default` and `override set` accept a catalog id or a host profile id of the
current project. Both live in `<config>/pocket-nexus/settings.json`, where
`<config>` is `XDG_CONFIG_HOME` or `~/.config`; the file is written by rename.

## Target toolchains

**The framework pins each target's native toolchain** in
`tools/targets/<id>.toolchain.json`; the CLI holds no pins. `pocket target add`
installs the pinned components into the cache, and `pocket build` reads every
tool path from the install record of the toolchain the framework pins.

| Command | Effect |
| --- | --- |
| `pocket target add [<id> …]` | installs each target's components; with no id, the targets of the project configuration. A second run downloads nothing |
| `pocket target list [--json]` | every catalog target and every host profile of the project, with its install state |
| `pocket target list --check` | exits 1 unless every target of the project configuration is ready to build |
| `pocket target remove <id> …` | deletes the target's install records and the store entries no other record names, after running builds of the target finish |

In a checkout, `bun run pocket target add psp` runs the same command without
the CLI.

### Install states

| State | Meaning |
| --- | --- |
| `installed` | the record for the toolchain digest the framework pins exists, and every component it names is present |
| `not installed` | no record on this host |
| `outdated` | a record for another toolchain digest, written by another framework version |
| `broken` | the record names a component that is gone: a deleted store entry, or a rustup toolchain, component or target that was uninstalled |
| `unsupported` | the toolchain does not install on this host |
| `nothing to install` | `pocket build` runs the compiler alone: `web-app`, `macos-app`, `linux-app`, `macos-widget` |
| `no manifest` | the framework carries no toolchain manifest for the target; its build script finds its own tools |
| `host profile` | an ESP-IDF host profile of the project; the compiler builds it |

**`pocket build` for a target that is not ready stops before type checking**,
naming the command that installs it:

```text
pocket: target psp is not installed for @pocketjs/framework 0.14.0 (toolchain 3f9a12c0)
        run: pocket target add psp
```

A build holds the target's install record shared until its backend finishes;
`target add` and `target remove` hold it exclusive.

### Components

| Kind | Pin | Install | Verification |
| --- | --- | --- | --- |
| `rustup` | a version or a dated channel, never `stable`; components; targets | `rustup toolchain install --profile minimal`, `component add`, `target add` | the toolchain, its components and its targets in rustup's lists |
| `archive` | URL and SHA-256, one source or one per host; `zip`, `tar.gz` or `tar.xz`; the directory that becomes the tree; marker files | download, then `unzip` or `tar` | SHA-256 before extraction; entries and symbolic links that leave the directory are rejected; the markers after |
| `file` | URL and SHA-256, one source or one per host; the file name | download | SHA-256 |
| `cargo-install` | git repository and full revision, package, binaries, a rustup toolchain of the same manifest | `cargo install --locked --root` | the binaries exist |

**rustup is a requirement, not a component.** `pocket target add` finds rustup
on `PATH` or in `$CARGO_HOME/bin` and never uninstalls a rustup toolchain,
which other projects share. Backends run Rust with `RUSTUP_AUTO_INSTALL=0`, so
a `rust-toolchain.toml` cannot install a toolchain the record does not name.

### PSP

| Component | Pin |
| --- | --- |
| `rust` | `nightly-2026-05-28` with `rust-src` |
| `cargo-psp` | `cargo-psp`, `prxgen`, `prxmin`, `pack-pbp` and `mksfo` from pocket-nexus/rust-psp at the revision `hosts/psp` links |
| `sdk` | the pocket-nexus/pspdev release `sdk-noabicalls-normalized-2026-06-19`: headers and the libraries the EBOOT links |
| `quickjs` | `libquickjs-mipsel-sony-psp.a`, which pocket-nexus/quickjs-rs publishes as `prebuilt-psp-<commit>` for the revision `hosts/psp` links |

**A PSP build runs no C compiler.** QuickJS is the PSP host's one C dependency,
and `libquickjs-sys` links the archive `QUICKJS_PREBUILT_LIB` names. The PSP
toolchain installs on macOS and Linux, arm64 and x64.

### Cache

```text
<cache>/store/<component digest>/receipt.json   a published component
<cache>/store/<component digest>/tree/          its files
<cache>/targets/<id>/<toolchain digest>.json     an install record
<cache>/locks/  <cache>/tmp/
```

`<cache>` is `POCKET_NEXUS_CACHE_DIR`, or `pocket-nexus` under `XDG_CACHE_HOME`
or `~/.cache`. **A component digest is the SHA-256 of the component's pin**, so
two targets or two framework versions with equal pins share one store entry. A
toolchain digest covers a target's components for one host; a pin change gives
a new digest and a new record, and the previous record stays until
`pocket target remove`. Every install stages under `tmp/` and publishes by
rename, so an interrupted install leaves no store entry and no record.

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
| `psp` | `tools/psp.ts` links the EBOOT with the [installed PSP toolchain](#psp): `<framework>/hosts/psp/target/mipsel-sony-psp/<profile>/EBOOT.PBP`, where `<profile>` is `release` with `-- --release` and `debug` otherwise |
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
contract and hosts; `pocket target list` adds the install state.

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
| `POCKETJS_FRAMEWORK_ROOT` | manifest commands, `show`, `target`, `--version` | the framework directory; step 1 of [resolution](#framework-resolution) |
| `POCKET_TARGET` | manifest commands, `show` | the target; step 2 of [selection](#target-selection) |
| `XDG_CONFIG_HOME` | `show`, `default`, `override`, manifest commands | parent of `pocket-nexus/settings.json`; `~/.config` when unset |
| `POCKET_NEXUS_CACHE_DIR` | `target`, `show`, `build` | the [cache](#cache) root |
| `XDG_CACHE_HOME` | `target`, `show`, `build` | parent of `pocket-nexus/` when `POCKET_NEXUS_CACHE_DIR` is unset |
| `CARGO_HOME` | `target`, `show`, `build` | `bin/rustup` there when rustup is not on `PATH`; `~/.cargo` when unset |
| `VITASDK` | Vita builds | the VitaSDK root; `~/vitasdk` when unset |
| `PORT` | `pocket dev`, `pocket devtools` | the dev server port; `8130` when unset |
