# @pocketjs/cli

The [PocketJS](https://pocketjs.dev) toolchain CLI — `doctor`/`setup` for the
bun + Rust + PSP toolchain (flutter-doctor style), manifest-first app
scaffolding, build/run passthrough for PSP and PS Vita, an isolated
Nokia E7 / Symbian development toolchain, and an Apple iOS flow that stages
guests into a NativeScript shell and launches them on the simulator.

```sh
npm install -g @pocketjs/cli

pocket doctor            # diagnose Bun / pinned Rust + PSP toolchain
pocket setup             # run PocketJS's pinned, idempotent bootstrap
pocket create my-app     # scaffold apps/my-app with pocket.json v2
pocket check --target psp --manifest apps/my-app/pocket.json
pocket compile --target psp --manifest apps/my-app/pocket.json
pocket build --target psp --manifest apps/my-app/pocket.json -- --release
pocket build --target vita --manifest apps/my-app/pocket.json -- --release
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

Host-development commands run inside a PocketJS checkout (the CLI finds it by
walking up from the current directory):

```sh
git clone https://github.com/pocket-nexus/pocketjs
cd pocketjs && bun install
pocket doctor
```

`check`, `compile`, and `build` delegate to PocketJS's canonical manifest
resolver. `pocket.json` owns the framework, entry, output, viewport and API
requirements; the target backend consumes the resulting build plan. Arguments
after `--` go to the selected PSP or Vita backend. The low-level `dev`, `psp`,
`vita`, `hw`, `psplink`, `devtools`, and `tape` commands remain available for
framework demos and host development.

Manifest commands also run from an external application project that installs
`@pocketjs/framework`. The CLI resolves the compiler from the nearest project
`node_modules`. `POCKETJS_FRAMEWORK_ROOT` is an explicit development override.

Only Node ≥ 18 is required for the CLI itself; everything it diagnoses or
installs is for building PocketJS apps. See the
[repository](https://github.com/pocket-nexus/pocketjs) and
[pocketjs.dev](https://pocketjs.dev) for the framework docs.

`pocket setup` installs the exact toolchain described by the CLI's bundled
`psp-toolchain.json` into the shared pocket-nexus cache. PSPLINK is diagnosed
as an optional real-hardware hot-reload tool; it is not required to build a PSP
EBOOT.
