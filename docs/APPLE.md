# Modern iOS via NativeScript

`pocket ios` runs PocketJS guests on the iOS simulator inside a NativeScript
shell app. The native core is `engine/ios` ([PR #255](https://github.com/pocket-nexus/pocketjs/pull/255)):
the `pocket-apple` crate behind a C ABI, and `PocketSurfaceView`, a UIKit view
driving one guest realm and one software-rastered surface per instance. The
NativeScript side is the published
[`@nativescript/pocketjs`](https://github.com/NativeScript/pocketjs) plugin,
whose npm package carries a prebuilt `PocketApple.xcframework` — the default
flow needs **no Rust toolchain**.

## Current status

| Claim | Evidence |
| --- | --- |
| Guest boots, renders, animates at 60 fps | iOS 26.5 simulator, `apps/nsengine` at density 4 |
| Touch reaches the guest with aspect-fit inverse mapping | `Ping host` pressable increments on tap |
| Guest ↔ host service round trip | `ns.ping` → shell reply renders in the guest stat tile, unprompted on mount |
| External-guest mode (the app's JS runtime is the guest engine) | Guest code reads `UIDevice.currentDevice.systemVersion` |
| Platform-contract identity enforced end to end | Plan-built bundles bake `ios-dev`/7 and mount only on hosts publishing the same pair |
| Real-device run | **Not yet exercised** — simulator only |

## One-time setup

```sh
pocket ios doctor    # Xcode, arm64 iOS 16+ simulator runtime, node, ns CLI
pocket ios setup     # adds the two Rust iOS targets (only needed for --rebuild-native)
```

**An Apple Silicon Mac is required.** `PocketApple.xcframework` and the
`@nativescript/ios-quickjs` runtime ship `ios-arm64`/`ios-arm64-simulator`
slices only, so the shell excludes `x86_64` for simulator builds
(`hosts/ios-nativescript/App_Resources/iOS/build.xcconfig`). CocoaPods is not
required: neither the shell nor the plugin carries a Podfile.

## Build and run a demo

```sh
pocket play ios nsengine                     # build, stage, launch on the simulator
pocket ios play nsengine --external-guest    # the NativeScript runtime as the guest engine
pocket ios build nsengine --density=4        # guest artifacts only (dist/ios/nsengine/)
pocket ios devices                           # admissible simulators
```

The flow: resolve the app's manifest against the `ios-dev` profile → run
`tools/build.ts` from the plan → stage `<output>.pocketjs`, `<output>.pak`,
`<output>.plan.json` and `current.json` into the shell's `src/assets/pocket/`
→ `npm install` (first run) → boot an arm64 simulator →
`ns run ios --device <udid> --no-hmr --justlaunch`. The shell runs in place,
so only the first run pays the full cost: **~47 s cold** (npm install + full
Xcode build, Apple Silicon, warm simulator) and **~16 s on repeat runs**
(`--no-build`; ~25 s with a guest rebuild). `--attach` keeps `ns run`
attached for console output.

**Density is load-bearing:** glyph atlases bake at build time, and the shell
sets the surface's raster scale from the staged plan — a guest built at one
density and rastered at another renders soft text. `--density=1..4`, default 3.

## The ios-dev profile

`tools/ios-profile.ts` follows the transitional pattern
(`tools/iphone2g-profile.ts`): a scoped registry that stays out of
`POCKET_TARGETS` until the host has device-level acceptance. Profile:
platform `ios`, form `embedded` (a fixed 480×272 logical viewport letterboxed
by the view), presentations `native` + `integer-fit`, capabilities
`input.touch` + `text.glyphs.baked` only — `PocketSurfaceView` reports no
buttons and a centered analog.

**The identity contract:** bundles built from a resolved plan bake
`__POCKET_TARGET__`/`__POCKET_HOST_ABI__` and refuse to mount unless the host
publishes the same pair (`framework/src/host.ts`). Three places publish
`"ios-dev"` / `7` and must stay in agreement: this profile,
`PocketSurfaceView.m` (`pocket_apple_set_identity` at init), and the plugin's
external-guest `ui` mount. `tests/ios-profile.test.ts` guards the first two.

## The two guest modes

- **Sidecar (default, `PocketView`)** — the guest runs in the QuickJS realm
  embedded in the xcframework. The host app's runtime never sees guest code;
  the surface composes into the app's layout like any UIView.
- **External guest (`--external-guest`, `PocketHostView`)** — the shell's own
  JS runtime evaluates the bundle; `globalThis.ui` delegates each op over the
  NativeScript metadata bindings to the same native core. Guest code reaches
  the whole iOS platform with no per-API glue.

Both modes run the identical bundle; `current.json` selects the view class.

## The shell (`hosts/ios-nativescript`)

Authored and committed: `package.json`, `nativescript.config.ts`,
`webpack.config.js`, `tsconfig.json`, `references.d.ts`, `src/app.ts`,
`App_Resources/iOS/{build.xcconfig,Info.plist,LaunchScreen.storyboard}`.
Generated and gitignored: `node_modules/`, `platforms/`, `hooks/`,
`src/assets/pocket/`, `package-lock.json`. The shell is plan-driven — it reads
the staged plan for viewport and density and the staged mode for the view
class, so nothing is templated at stage time. Its `tsconfig.json` pins
`@nativescript/core` paths so the plugin's typings resolve when the plugin is
a `file:` symlink. `--shell-dir=<path>` stages into another NativeScript app
instead.

## Pre-publish overrides

`--plugin-path=<checkout>` and `--runtime-tgz=<tgz>` point the shell at a
local `@nativescript/pocketjs` checkout and a local
`@nativescript/ios-quickjs` tarball. The committed `package.json` names the
published packages; overrides are applied for the `npm install` and the
template is restored afterwards. With `--plugin-path`, a present
`engine/ios/dist/PocketApple.xcframework` is copied into the local plugin
(`--rebuild-native` rebuilds it first).

## Sources

- `engine/ios/` — pocket-apple crate, `PocketSurfaceView`, `build-xcframework.sh`
- `tools/ios.ts`, `tools/ios-profile.ts` — the CLI flow and the profile
- `hosts/ios-nativescript/` — the committed shell
- `apps/nsengine/` — the reference guest (service channel + platform probe)
- [`@nativescript/pocketjs`](https://github.com/NativeScript/pocketjs) — the plugin repo
