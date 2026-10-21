# @pocketjs/cli

The PocketJS CLI resolves a framework, compiles applications for software
profiles, runs program-owned native build recipes and installs pinned
toolchains. It also scaffolds applications and ESP-IDF products.

**The CLI requires Bun 1.2 or later.** It launches the framework's scripts
with its own Bun executable. Installing the package through npm still
requires Bun to run `pocket`.

```sh
bun add -g @pocketjs/cli
# npm install -g @pocketjs/cli
bunx @pocketjs/cli show
```

## Compile an application

```sh
pocket create my-app --target psp --framework solid
cd my-app
bun install
bun run check
bun run compile
```

Outside a framework checkout this creates a standalone project with
`pocket.json`, `main.tsx`, `app.tsx`, `package.json`, `tsconfig.json`, a README
and `.gitignore`. Inside a checkout it creates the application files under
`apps/<name>/`. `--framework` accepts `solid`, `vue-vapor` and `octane`.
Application scaffold targets are `psp`, `vita`, `pocketbook`, `web-app`,
`macos-app` and `linux-app`.

**`compile` produces a version 2 `.pocket` application package.** It validates
the manifest and TypeScript, resolves capabilities and viewport against the
selected profile, and records that profile's hash in the package. The
scaffold's `build` package script is an alias for `pocket compile`.

```sh
pocket check --manifest pocket.json --target psp
pocket compile --manifest pocket.json --target psp --output dist/app.pocket
pocket compile --manifest pocket.json --target ./profiles/my-board.ts \
  --output dist/app.pocket --depfile dist/app.d
```

For an application with `app.aot: true`, `pocket compile --aot --out dist/aot`
generates MicroTS Rust modules, fonts, images, an include file and dependency
metadata. It runs no Cargo build and emits neither JavaScript nor a `.pocket`
package. A declared `execution.classes` list must include `aot`.

## Profiles and program builds

**`--target` means a profile ID or profile module.** A module can be a file or
an installed package and must default-export a profile. Selection uses an
explicit target, then `POCKET_TARGET`, then the single profile in the nearest
`pocket.runtime-config.ts`. A configuration with multiple profiles requires a
profile ID.

```ts
// pocket.runtime-config.ts
import { defineRuntimeConfig, cargo } from "@pocketjs/framework/runtime-config";
import profile from "./profiles/my-board.ts";

export default defineRuntimeConfig({
  profile,
  build: {
    hosts: ["darwin-arm64", "linux-x64"],
    steps: cargo({ manifest: "native/Cargo.toml", package: "my-runtime" }),
  },
});
```

```sh
pocket build --config pocket.runtime-config.ts --out dist/profile
pocket profile export --config pocket.runtime-config.ts --out dist/profile
```

**`build` executes the program's native recipe and accepts no application
manifest.** It requires a runtime configuration; `--target` selects an ID
implemented by that configuration. Recipes use `cargo`, `cmake`, `make` or
`compilerOnly` helpers. A configuration containing only `{ profile }` exports
the profile and leaves native compilation to the external build system.

`profile export` writes `pocket_profile.h` and `pocket-profile.json`, containing
the canonical profile and its hash for the program's package admission check.
The C header exposes typed display geometry, logical viewport choices,
auxiliary and dynamic viewport data, presentation masks and capability masks.
`--depfile` records imported configuration, profile and exporter inputs.

Application settings, including `app.framework` and `app.theme`, belong in
`pocket.json`. The profile declares display geometry, capabilities and tick
rate. Runtime configuration declares the program's profiles and build recipe.

## ESP-IDF products

```sh
pocket create my-product --target esp-idf
cd my-product
bun install
bun run check
bun run compile
bun run profile
```

The generated product contains:

```text
profiles/my-product.ts     profile ID product-my-product
pocket.runtime-config.ts  selects the profile; native build belongs to ESP-IDF
app/pocket.json            application manifest
app/main.tsx              mount entry
app/app.tsx               component
```

The starting profile declares a 320×240 native viewport, 60 Hz, buttons and
baked glyphs. Standalone scripts compile `dist/my-product.pocket` and export
the profile to `dist/profile/`. The README contains `pocketjs_compile_app`
with `RUNTIME_CONFIG`, and `pocketjs_embed_package` with
`PROFILE_EXPORT_DIR` for builds that consume a prebuilt package without Bun.

## Framework and toolchain resolution

`POCKETJS_FRAMEWORK_ROOT` selects a framework directory. Otherwise the CLI
walks up from the current directory and uses the nearest framework checkout
or `node_modules/@pocketjs/framework`. A framework is identified by its
`package.json` field `pocketjs.protocol`, so fork packages can use another
name. The CLI requires a matching protocol. `pocket show --json` reports
resolution and toolchain state; `pocket --version` prints both versions.

```sh
pocket show
pocket target list
pocket target add psp
pocket target remove psp
```

The framework owns built-in toolchain pins; a runtime configuration can own
another manifest under `build.toolchain`. `target add` without IDs installs
that declared toolchain. A profile-only configuration needs no toolchain
installation through the CLI. `target list --check` checks the configuration's
declared toolchain and requires a runtime configuration.

**Toolchain IDs are separate from profile IDs.** For example,
the toolchain catalog uses `3ds`, while `pocket compile --target 3ds-dev`
selects the software profile. The `3ds` catalog entry has no installable
toolchain manifest. The cache root is `POCKET_NEXUS_CACHE_DIR`,
`$XDG_CACHE_HOME/pocket-nexus` or `~/.cache/pocket-nexus`, in that order.

For an external C consumer, `pocket sdk export --triple <rust-target> --out
dist/sdk` exports the runtime archive, generated headers and CMake metadata.
`pocket sdk verify --dir dist/sdk` verifies the export. Profile export supplies
the program-specific identity alongside this SDK.

## Host-development scripts

These commands require a source checkout or `POCKETJS_FRAMEWORK_ROOT` and run
from the resolved framework root:

```sh
pocket dev hero-main
pocket psp hero
pocket vita hero
pocket hw hero
pocket psplink
pocket devtools hero
pocket tape replay …
pocket play vita hero
pocket symbian doctor --device
pocket symbian build probe
pocket ios doctor
pocket ios play nsengine
```

Arguments go to the corresponding `tools/<command>.ts` script. See the
[CLI reference](https://pocketjs.pocket.nexus/docs/cli/) for command options,
configuration examples and installation states, and the
[repository](https://github.com/pocket-nexus/pocketjs) for host scripts.
