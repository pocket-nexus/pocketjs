# @pocketjs/cli

The [PocketJS](https://pocketjs.dev) toolchain CLI — `doctor`/`setup` for the
Bun + Rust + PSP toolchain (flutter-doctor style), manifest-first app
scaffolding for consoles and ESP-IDF products, build passthrough for PSP and
PS Vita, an isolated Nokia E7 / Symbian development toolchain, and an Apple
iOS flow that stages guests into a NativeScript shell and launches them on the
simulator.

**The CLI runs on Bun.** The framework's compiler and host scripts are Bun
programs; the CLI launches them with its own executable, so a machine without
Bun cannot build a PocketJS application. Install Bun (https://bun.sh) first,
then the CLI through either package manager:

```sh
bun add -g @pocketjs/cli      # or: npm install -g @pocketjs/cli
bunx @pocketjs/cli doctor     # one-off, no global install

pocket doctor            # Bun, pinned Rust + PSP toolchain, resolved framework
pocket setup             # run PocketJS's pinned, idempotent bootstrap (checkout only)
pocket create my-app     # scaffold an app (see below)
pocket check --target psp --manifest my-app/pocket.json
pocket compile --target psp --manifest my-app/pocket.json
pocket build --target psp --manifest my-app/pocket.json -- --release
pocket build --target vita --manifest my-app/pocket.json -- --release
pocket build --host-profile firmware/pocket.host.json \
  --manifest app/pocket.json --project-root app --output dist/app.pocket
pocket play vita hero    # build, install and launch a stock demo in Vita3K
pocket dev my-app-main   # build + serve in the browser
pocket psp my-app        # build the PSP EBOOT
pocket vita my-app       # build the PS Vita VPK
pocket symbian doctor --device
pocket symbian doctor --coda-usb
pocket symbian setup --yes
pocket symbian build probe
pocket symbian deploy dist/symbian/pocketjs-e7-probe.sis
pocket symbian coda usb
pocket symbian coda usb launch <executable.exe>
pocket ios doctor
pocket ios setup
pocket ios play nsengine     # NativeScript shell on the arm64 iOS simulator
pocket play ios nsengine     # the same flow through the play front door
pocket hw my-app         # build + run on a real PSP over PSPLINK
pocket psplink           # interactive multi-app switcher on a real PSP
pocket devtools my-app   # DevTools panel + USB debug bridge, one command
pocket tape replay …     # record / replay / inspect input tapes headlessly
```

## Scaffolding

`pocket create <name> [--target T] [--framework F] [--host-profile FILE]`
writes `app.tsx`, `main.tsx` and a `pocket.json` v2 manifest. `--framework`
selects `solid` (default), `vue-vapor` or `octane`; the mount entry and the
component use that framework's subpaths. `--target` selects `psp` (default),
`vita`, `pocketbook`, `web-app`, `macos-app`, `linux-app` or `esp-idf` and
decides which `pocket` commands the scaffold prints or records.

Outside a PocketJS checkout the result is a standalone project:

```text
my-app/
  package.json     depends on @pocketjs/framework, pins @pocketjs/cli, scripts check/compile/build
  tsconfig.json    editor typecheck; `pocket check` extends it
  pocket.json      the manifest
  main.tsx         mount entry
  app.tsx          the component
  README.md        the build commands (ESP-IDF: the CMake integration snippets)
  .gitignore       node_modules/, dist/, .pocket/
```

`bun install` then `bun run check` / `bun run build` run the recorded
commands; `pocket` resolves the compiler from the project's
`node_modules/@pocketjs/framework`.

Inside a checkout the same command writes `apps/<name>/` with the three app
files and resolves the framework from the checkout; `pocket check --target psp
--manifest apps/<name>/pocket.json` runs from the checkout root.

### ESP-IDF products

A firmware repository that consumes the PocketJS ESP-IDF components owns a
`pocket.host.json`. Scaffold the application against it from the firmware
root:

```sh
pocket create app --host-profile pocket.host.json
```

`pocket.json` takes the profile's first logical viewport, its `native`
presentation when the profile lists one, and declares `input.buttons` under
`requires` when the profile advertises it (the template drops the button
handler otherwise). The `build` script is `pocket build --host-profile
../pocket.host.json --output dist/app.pocket`, and `app/README.md` carries the
`pocketjs_compile_app` and `pocketjs_embed_package` CMake snippets with the
paths filled in. `--target esp-idf` without `--host-profile` writes a starting
`pocket.host.json` (320×240, `native`, buttons and baked glyphs) into the app
directory.

## Resolution

Host-development commands (`setup`, `dev`, `psp`, `vita`, `hw`, `psplink`,
`devtools`, `tape`, `play`, `symbian`, `ios`) run inside a PocketJS checkout;
the CLI finds it by walking up from the current directory:

```sh
git clone https://github.com/pocket-nexus/pocketjs
cd pocketjs && bun install
pocket doctor
```

`check`, `compile`, and `build` delegate to PocketJS's canonical manifest
resolver. `pocket.json` owns the framework, entry, output, viewport and API
requirements; the target backend consumes the resulting build plan. Arguments
after `--` go to the selected PSP or Vita backend. They run from a checkout or
from any project that installs `@pocketjs/framework`: the CLI resolves the
compiler from the nearest project `node_modules`. `POCKETJS_FRAMEWORK_ROOT` is
an explicit development override. `pocket --version` prints the CLI version
and the framework it resolved.

`pocket setup` installs the exact toolchain described by the CLI's bundled
`psp-toolchain.json` into the shared pocket-nexus cache. PSPLINK is diagnosed
as an optional real-hardware hot-reload tool; it is not required to build a PSP
EBOOT. See the [repository](https://github.com/pocket-nexus/pocketjs) and
[pocketjs.dev](https://pocketjs.dev) for the framework docs.
