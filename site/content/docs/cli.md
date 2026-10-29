# CLI

`@pocketjs/cli` installs the `pocket` executable. **The CLI requires Bun 1.2
or later.** It resolves a PocketJS framework and launches that framework's
compiler and build scripts with its own Bun executable. Running it under Node
prints the Bun installation hint and exits with status 1.

```sh
bun add -g @pocketjs/cli
# npm install -g @pocketjs/cli also installs the executable; Bun is required to run it.
bunx @pocketjs/cli show
```

## Commands

| Command | Result |
| --- | --- |
| `pocket create <name> [options]` | an application scaffold, or an ESP-IDF product with a profile and application |
| `pocket check [options]` | manifest, profile, viewport and TypeScript validation |
| `pocket compile [options]` | a version 2 `.pocket` application package |
| `pocket compile --aot --out <directory> [options]` | MicroTS Rust sources, fonts, images and dependency metadata |
| `pocket build [--config <file>] [--target <id>]` | the program's runtime build recipe |
| `pocket profile export --out <directory> [options]` | the selected profile's C header, Rust module and stamped `pocket-profile.json` |
| `pocket profile fetch --target <id> --out <file>` | the profile document a PocketJS release publishes for a runtime |
| `pocket show [--json]` | framework resolution, runtime configuration, profile selection and toolchain states |
| `pocket target add`, `list`, `remove` | native toolchain installation and status |
| `pocket sdk export`, `build`, `verify` | download, build or verify a C runtime SDK |
| `pocket dev`, `psp`, `vita`, `hw`, `psplink`, `devtools`, `tape`, `play`, `symbian`, `ios` | host-development scripts from a checkout |
| `pocket --version` | CLI version and the resolved framework version |

`pocket`, `pocket help` and `pocket --help` print the command list.

## Framework resolution

**A framework directory has a `package.json` containing
`"pocketjs": { "protocol": <number> }`.** The marker identifies a framework;
the package name can belong to a fork. Resolution uses:

1. `POCKETJS_FRAMEWORK_ROOT`, when set. A directory without the marker is an error.
2. The nearest ancestor containing the marker, or the nearest ancestor's
   `node_modules/@pocketjs/framework`. If both occur at one directory, the
   checkout takes precedence.

The CLI uses protocol 1 and rejects a framework with a different protocol.
`show` reports the framework path and source, including registry, Git, `file:`,
`link:` and symlinked dependencies.

| Use | Selection |
| --- | --- |
| work against a local framework checkout | `POCKETJS_FRAMEWORK_ROOT=/path/to/pocketjs pocket …` |
| link a framework into an application | `bun link` in the framework, then `bun link @pocketjs/framework` in the application |
| pin a fork commit | `"@pocketjs/framework": "github:<owner>/pocketjs#<commit>"` in the application's dependencies |
| install a fork published under another name | `"@pocketjs/framework": "npm:<name>@<version>"` |

Application and runtime commands retain the caller's working directory.
Host-development commands require a checkout or a framework selected by
`POCKETJS_FRAMEWORK_ROOT`, and run from that framework's root.

## Profile selection

**`--target` selects a profile.** For application compilation and profile
export it accepts a built-in profile ID or the path of a `pocket-profile.json`
document, including the one a firmware release publishes:

```sh
pocket check --manifest pocket.json --target psp
pocket compile --manifest pocket.json --target ./profiles/my-board.json
pocket compile --manifest pocket.json --target ./vendor/pocket-profile.json
```

A path ends in `.json`. A document that carries a `hostAbi` stamp other than
the current binding generation is rejected.

Selection follows this order:

1. An explicit `--target`, or the `+<id>` shorthand for `check`, `compile` and
   `build`. For example, `pocket +psp compile` and `pocket compile +psp`.
2. `POCKET_TARGET`.
3. The single profile in the nearest `pocket.runtime-config.ts`.

Different explicit selections are an error. A configuration containing
multiple profiles requires a profile ID. Pass `--runtime-config <file>` to
`check` or `compile`, or `--config <file>` to `build` or `profile export`, to
select a configuration by path. When a configuration is selected, the target
must be one of its profile IDs. **`build` requires a runtime
configuration and selects a profile implemented by that configuration.**

The configuration lookup starts at the manifest's directory for `check` and
`compile`, and at the current directory for `build` and `profile export`.
An explicit target or `POCKET_TARGET` bypasses the implicit
configuration lookup for application compilation and profile export.

Profile document paths resolve against the current directory. A runtime
configuration names its documents by paths relative to the configuration
file.

### Runtime configuration

The program declares its profile and optional native build recipe:

```ts
// pocket.runtime-config.ts
import { defineRuntimeConfig } from "@pocketjs/framework/runtime-config";

export default defineRuntimeConfig({ profile: "./profiles/my-board.json" });
```

Use `profiles: ["./a.json", "./b.json"]` when one program implements several
profiles. `profile` and `profiles` are alternatives. The application manifest
owns `app.entry`, `app.framework`, `app.viewport`, `app.tickHz`, `app.theme` (a
module or JSON path) and requirements; the profile supplies display geometry,
cadences and capabilities.

`pocket show --json` reports the selected framework, runtime configuration,
profile selection, host and toolchain states. `--manifest <file>` changes the
configuration lookup directory; `--runtime-config <file>` names the
configuration. `pocket +psp show` displays an explicit selection.

### Profile IDs and toolchain IDs

**Profile IDs and toolchain installation IDs are separate.** For example,
application compilation uses `--target 3ds-dev`, while the toolchain catalog
uses `3ds`. That catalog entry has no installable toolchain manifest. Other
examples include `moto-g-play-dev` versus
`moto-g-play`, and `symbian-e7-dev` versus `nokia-e7`.

In a framework checkout, `bun tools/pocket.ts catalog --json` lists the
built-in profiles. `pocket target list` lists toolchain IDs and install states.
Product-owned profile documents do not require a catalog entry.

## check and compile

```sh
pocket check --manifest pocket.json --target psp
pocket compile --manifest pocket.json --target psp --output dist/app.pocket
pocket compile --manifest pocket.json --target ./profiles/my-board.json \
  --output dist/app.pocket --depfile dist/app.d
```

| Option | Default | Meaning |
| --- | --- | --- |
| `--target <id-or-file>` | profile selection above | the profile to compile against |
| `--runtime-config <file>` | nearest configuration when no target is supplied | a configuration containing the selected profile |
| `--manifest <file>` | `pocket.json` | the application manifest |
| `--project-root <directory>` | the manifest's directory | base directory for the entry, TypeScript configuration and output paths |
| `--outdir <directory>` | `dist` | compiler intermediates and the default package directory |
| `--plan-dir <directory>` | `.pocket` | resolved build plans |
| `--output <file>` | `<outdir>/<app.output>.pocket` | guest package output |
| `--depfile <file>` | none | a Make/Ninja depfile for the generated package or AOT include file |
| `--compiler-receipt <file>` | none | an existing product-owned toolchain receipt to include as a dependency |
| `--aot --out <directory>` | off; output directory defaults to `dist` | generate native application sources |

`--manifest`, `--project-root`, `--runtime-config` and `--compiler-receipt`
resolve against the current directory. Output, plan and depfile paths resolve
against the project root. Unknown options are errors.

**`check` writes no output.** It validates the manifest against the published
schema, profile capabilities,
viewport and entry module's TypeScript import graph. It uses the project's
`tsconfig.json` when present and prints the resolved plan hash.

**`compile` produces a version 2 `.pocket` package.** It performs the same
validation, writes `<plan-dir>/<profile-id>/plan.json`, and compiles JavaScript
and pak intermediates. The package contains the manifest and a variant with
the profile ID, profile hash, binding generation, plan, JavaScript and assets.
A manifest `icon` becomes the variant's cover section. Profile IDs unsuitable
for directory names use a hash-derived plan directory. The optional depfile
includes application imports, assets, compiler inputs, the icon, and the
profile documents and configuration modules.

### AOT source generation

```sh
pocket compile --manifest apps/gba-hero/pocket.json --project-root . \
  --target gba --aot --out dist/gba-sources
pocket compile --manifest apps/ipodnano-hero/pocket.json --project-root . \
  --target ipodnano --aot --out dist/ipod-sources
```

An AOT manifest sets `app.aot` to `true`. **`--aot` generates sources and assets without
running Cargo or producing JavaScript or a `.pocket` package.** The output
includes Rust modules, `include.rs`, styles, font and image assets, layer
metadata, and `dependencies.json` with a depfile. Relative includes let the
program's build consume the directory after relocation. GBA and iPod nano
program builds use this source-generation path before their native build.

The compiler requires its prebuilt Wasm layout oracle; a missing oracle is an
error. `--aot` is a `compile` option and cannot be combined with `--output`.
The manifest's `app.tickHz` and `app.theme` apply to the generated animation
data.

## build

**`pocket build` executes the program's runtime configuration.** It does not
accept an application manifest. Compile application packages or AOT sources
with `pocket compile`. `--pocket <file>` supplies a compiled package;
`--aot-dir <directory>` supplies generated sources. A recipe declares its
required input with `input: "package"` or `input: "aot"`.

```ts
// pocket.runtime-config.ts in a native program repository
import { cargo, defineRuntimeConfig } from "@pocketjs/framework/runtime-config";

export default defineRuntimeConfig({
  profile: "./profiles/my-board.json",
  build: {
    hosts: ["darwin-arm64", "linux-x64"],
    steps: cargo({ manifest: "native/Cargo.toml", package: "my-runtime" }),
  },
});
```

```sh
pocket build --config pocket.runtime-config.ts --out dist/profile
```

`--target <id>` selects among the configuration's profiles. `--out` names the
output directory, relative to the current directory. Its default is
`dist/runtime` beside the configuration, or `dist/profile` for a configuration
without a build recipe. `--runtime-config` and `--outdir` are aliases for
`--config` and `--out` on this command.

The recipe declares supported `hosts` and one or more `steps`:

| Helper | Action |
| --- | --- |
| `cargo({ manifest, package, target, features, buildStd, release, … })` | `cargo build --locked`, with release mode unless `release: false` |
| `cmake({ source, buildDirectory, target, definitions, … })` | CMake configure followed by build |
| `make({ target, variables, … })` | Make with the declared target and variables |
| `compilerOnly()` | no native command; profile export still runs |

Steps accept `cwd`, `env` and `args`. A recipe can declare a pinned
`toolchain`, an expected `artifact`, and a `run(context)` callback after the
steps. Step working directories and artifact paths are relative to the
configuration directory. `context.run` supplies the selected profile's
canonical JSON, hash, ID, binding generation and export directory to native
build commands. `context.toolchainPaths` exposes installed component
paths when the recipe declares a toolchain. Cargo steps use the recorded
`rustup` executable and pinned compiler. Installed toolchain `bin` directories
precede the command's `PATH`.

**The executor checks that the package was compiled for the selected profile
and binding generation before native compilation**, because the native build
reads its inputs from the plan. AOT inputs also verify every generated file's checksum.
Admitted bytes are copied into the output directory. `context.application`
contains the extracted plan, JavaScript and resource pack;
`context.aot` contains the source directory and include file. Paths in steps
can use `{outdir}`, `{output}`, `{config}`, `{application}` and `{aot}`.

`sourceInputs` declares native files or directories that the recipe reads
outside its imported modules. Their contents are included in the receipt.
A build writes `build-receipt.json` with source and configuration dependency
hashes, selected profile, toolchain digest, compiled input identity, commands
and artifact hashes. A failed native command writes a failed receipt.
`--deploy` invokes a declared deployment hook after artifact validation.

Without a project configuration, a built-in target locates its program's
`pocket.runtime-config.ts` in the source checkout. `--generic` selects its
reusable runtime recipe. PSP and 3DS use `psp-runtime` and `3ds-runtime`
profiles for these recipes; their reduced service sets have distinct hashes.

**A configuration without `build` exports the profile and runs no native
compiler.** This supports programs whose CMake, Make or ESP-IDF build owns
native compilation.

## pack

**`pocket pack` combines a verified generic runtime with a compiled package.**
The selected configuration supplies the repack function and output extension.
The runtime ships its `pocket-profile.json`; **pack admits the package by that
document's facts** ([admission](/docs/platform-contracts/#admission)), so a
package compiled for another profile with the same facts packs.

```sh
pocket compile --manifest apps/hero/pocket.json --project-root . --target psp-runtime \
  --output dist/hero.pocket
pocket build --target psp --generic --out dist/psp-runtime
pocket pack --target psp --runtime dist/psp-runtime \
  --pocket dist/hero.pocket --out dist/hero-psp.zip
```

`--runtime` accepts a runtime directory containing `runtime.json`, or a build
output directory with a successful matching receipt. Without it, `pack` downloads
the runtime for the installed framework release. `--release-version` selects
an exact release version; `--manifest-url` selects a release index mirror. Native compilation and application
compilation are separate commands. `--id`, `--title`, `--version`, `--author`
and `--icon` supply package identity. Omitted fields come from the compiled
plan and the manifest's `author` and `icon`; with neither, the author is
recorded as `Unspecified`.

## Profile export

```sh
pocket profile export --config pocket.runtime-config.ts \
  --out dist/profile --depfile dist/profile.d
pocket profile export --target psp --out dist/psp-profile
pocket profile fetch --target psp-runtime --out vendor/pocket-profile.json
```

`--out` is required. `--config`, `--out` and `--depfile` resolve against the
current directory. Selection follows the profile rules above.

| Output | Contents |
| --- | --- |
| `pocket_profile.h` | The `pocket_profile_facts` record the runtime admits packages against, and a `pocket_profile` value holding the 32-byte hash, binding generation, cadences, animation class, and presentation and capability names |
| `pocket_profile.rs` | The same facts and hash for Rust programs |
| `pocket-profile.json` | The profile document with its `hostAbi` stamp |
| optional depfile | dependencies for the outputs, including the profile documents, configuration modules and the exporter |

**The header carries the hash and the facts, not the document.** The runtime
reads no JSON; it admits a package against the facts record. Exported files are
rewritten when their contents change.

C programs read primary physical dimensions and logical viewport choices,
auxiliary display geometry, dynamic viewport bounds, cadences and names from
typed fields. The header also defines `POCKET_PROFILE_WIDTH` and
`POCKET_PROFILE_HEIGHT`, and `POCKET_PROFILE_HEAP_BYTES` and
`POCKET_PROFILE_PACKAGE_BYTES` when the document states limits.

**`profile fetch` downloads the document a PocketJS release publishes for a
runtime target** and checks it against the release's file hash, profile hash
and binding generation. `--release-version` and `--manifest-url` select the
release as for `pack`.

## Target toolchains

The resolved framework carries built-in toolchain manifests under
`tools/targets/`. A program can declare its own manifest in
`pocket.runtime-config.ts` under `build.toolchain`. The CLI carries no pins.

| Command | Effect |
| --- | --- |
| `pocket target add <id> …` | install the named built-in or program-declared toolchains |
| `pocket target add` | install `build.toolchain` from the nearest runtime configuration; a profile-only configuration reports external build ownership and installs nothing |
| `pocket target list [--json]` | list built-in toolchains and the program-declared toolchain with their install states |
| `pocket target list --check` | require a runtime configuration and exit 1 if its declared toolchain is not ready; no declared toolchain needs no installation |
| `pocket target remove <id> …` | remove install records and store entries no remaining record references |

With no IDs and no declared toolchain, `target add` requires an explicit ID or
a `build.toolchain` declaration. A toolchain with no components needs no
installation. A catalog entry without a manifest cannot be installed through
`target add`.

### Install states

| State | Meaning |
| --- | --- |
| `installed` | the pinned install record and all its components are present |
| `not installed` | this host has no install record |
| `outdated` | the installed record has another toolchain digest |
| `broken` | a recorded component or rustup component is missing |
| `unsupported` | the toolchain does not support this host |
| `nothing to install` | the manifest contains no components |
| `no manifest` | the catalog has no installable toolchain manifest |

A runtime build with a declared toolchain rejects missing, outdated or broken
installs before executing its recipe. It holds the target's install lock
shared through the build; installation and removal hold it exclusive.

### Components and cache

| Component | Pin and verification |
| --- | --- |
| `rustup` | a fixed version or dated channel, components and targets; verified against rustup's installed lists |
| `archive` | URL, SHA-256, archive format, root and marker files; hash checked before extraction, with paths escaping the tree rejected |
| `file` | URL, SHA-256 and destination file name |
| `cargo-install` | Git repository, full revision, package, binaries and a pinned rustup toolchain |

Rustup must be installed on `PATH` or under `$CARGO_HOME/bin`. Removing a
PocketJS install record does not uninstall rustup toolchains shared by other
projects. A PSP native build uses a pinned QuickJS engine archive and compiles
its C guest adapter and host bridge; installing the engine archive does not
remove the native C compilation step.

```text
<cache>/store/<component-digest>/receipt.json
<cache>/store/<component-digest>/tree/
<cache>/targets/<toolchain-id>/<toolchain-digest>.json
<cache>/locks/
<cache>/tmp/
```

The cache root is `POCKET_NEXUS_CACHE_DIR`, then
`$XDG_CACHE_HOME/pocket-nexus`, then `~/.cache/pocket-nexus`. Component digests
cover their pins, allowing targets and framework versions to share matching
components. Toolchain digests cover the components selected for one host.
Installation stages files under `tmp/` and publishes by rename.

## create

```sh
pocket create my-app --target psp --framework solid
pocket create my-product --target esp-idf --framework vue-vapor
```

| Argument | Accepted values | Default |
| --- | --- | --- |
| name | lowercase kebab-case, such as `my-app` | required |
| `--target` | `psp`, `vita`, `pocketbook`, `web-app`, `macos-app`, `linux-app`, `esp-idf` | `psp` |
| `--framework` | `solid`, `vue-vapor`, `octane` | `solid` |

An existing destination is an error. In a checkout, output goes to
`apps/<name>/`; elsewhere it goes to `./<name>/`.

For an application target, the scaffold contains `pocket.json`, `main.tsx`
and `app.tsx`. The manifest declares a 480×272 `integer-fit` viewport and
requires buttons and baked glyphs. A standalone project also receives
`package.json`, `tsconfig.json`, a README and `.gitignore`. Its `check` and
`compile` scripts select the requested profile. **The scaffold's `build`
package script is an alias for `pocket compile`** and produces
`dist/<name>.pocket`.

### ESP-IDF products

`--target esp-idf` creates this product layout:

```text
my-product/
  profiles/my-product.json
  pocket.runtime-config.ts
  app/pocket.json
  app/main.tsx
  app/app.tsx
```

The profile ID is `product-my-product`; its document declares `takeover` form,
cadences 60 and 30, a 320×240 panel and logical viewport, `native`
presentation, density 1, the `repaint` animation class, buttons and baked
glyphs. The runtime configuration selects that profile
without a build recipe. The application entry is relative to the product
root.

A standalone product also receives package scripts and a README with firmware
integration commands:

```sh
cd my-product
bun install
bun run check
bun run compile
bun run profile
```

The application script passes `--manifest app/pocket.json --project-root .`.
`bun run profile` exports `dist/profile/pocket_profile.h` and
`dist/profile/pocket-profile.json`. Native firmware compilation belongs to
ESP-IDF. The generated README shows `pocketjs_compile_app` with
`RUNTIME_CONFIG`, or `pocketjs_embed_package` with a prebuilt `.pocket` and
`PROFILE_EXPORT_DIR` for firmware builds without Bun. See
[ESP-IDF](/docs/esp-idf/) for the CMake integration.

## C runtime SDK

```sh
pocket sdk export --triple aarch64-apple-darwin --out dist/sdk
pocket sdk verify --dir dist/sdk
```

**`sdk export` downloads and verifies a release SDK for the requested Rust target.**
The release defaults to the installed framework version; `--version` selects
another version. `sdk verify` checks its file list and hashes. `sdk build`
compiles a candidate SDK from a source checkout with the selected Rust toolchain.
`sdk export --cargo --out native-program` creates a program crate template with
versioned dependencies. Profile export supplies the product's software contract.

## Host-development commands

These commands pass their arguments to the corresponding script and run from
the resolved checkout or `POCKETJS_FRAMEWORK_ROOT`:

| Command | Script | Purpose |
| --- | --- | --- |
| `pocket dev [<app>-main …]` | `tools/dev.ts` | build and serve browser demos |
| `pocket psp <app>` | `tools/psp.ts` | build a PSP demo's EBOOT |
| `pocket vita <app>` | `tools/vita.ts` | build a Vita demo's VPK |
| `pocket hw [<app>]` | `tools/hw.ts` | build and run a PSP demo through PSPLINK |
| `pocket psplink` | `tools/psplink.ts` | switch applications on a PSP through PSPLINK |
| `pocket devtools [<app>]` | `tools/devtools.ts` | launch the DevTools panel and USB bridge |
| `pocket tape record\|replay\|tree …` | `tools/tape.ts` | record, replay and inspect input tapes |
| `pocket play vita <demo>` | `tools/play.ts` | build, install and launch a demo in Vita3K |
| `pocket play ios <demo>` | `tools/play.ts` | stage a demo in the NativeScript shell and launch the iOS simulator |
| `pocket symbian doctor\|setup\|build\|deploy\|coda …` | `tools/symbian.ts` | inspect the Nokia E7 toolchain, build SIS packages and use CODA USB |
| `pocket ios doctor\|setup\|devices\|native\|build\|stage\|play …` | `tools/ios.ts` | inspect the Apple toolchain and build or launch the simulator shell |

## Environment variables

| Variable | Effect |
| --- | --- |
| `POCKETJS_FRAMEWORK_ROOT` | select the framework directory |
| `POCKET_TARGET` | select a profile when no explicit target is supplied |
| `POCKET_NEXUS_CACHE_DIR` | set the toolchain cache root |
| `XDG_CACHE_HOME` | parent of `pocket-nexus/` when no cache root is supplied |
| `CARGO_HOME` | location of `bin/rustup` when rustup is absent from `PATH` |
| `VITASDK` | VitaSDK location for Vita host-development scripts |
| `PORT` | browser development or DevTools server port |

Runtime build recipes receive `POCKETJS_TARGET`, `POCKETJS_HOST_ABI`,
`POCKETJS_TICK_HZ`, `POCKETJS_PROFILE_JSON`, `POCKETJS_PROFILE_HASH` and
`POCKETJS_PROFILE_EXPORT_DIR` from the resolved configuration. These values
identify the program that is being built.
