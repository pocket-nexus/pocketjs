# Modern iOS via NativeScript

`engine/ios` composes **one canonical PocketJS Runtime per UIKit view**.
`PocketSurfaceView` registers a CPU display, touch input, package source and
service provider through `pocket-runtime-cabi`. The Runtime owns package
admission, asset loading, input hit snapshots, guest ticks and presentation.
The Apple adapter holds the framebuffer and host queues; it holds no second
`Ui` or operation dispatcher.

The maintained NativeScript plugin is
`programs/ios-simulator/shell/pocketjs`. The shell installs it through a `file:`
dependency and imports the generated UI mount from
`@pocketjs/framework/guest-web`. **Both guest modes use the generated op
schema and the same Runtime lifecycle.**

## Build and run

```sh
bun tools/ios.ts doctor
bun tools/ios.ts setup
bun tools/ios.ts native
bun tools/play.ts ios nsengine
bun tools/play.ts ios nsengine --external-guest
```

Building `PocketApple.xcframework` requires Xcode with the iPhone SDKs, the
Rust `aarch64-apple-ios` and `aarch64-apple-ios-sim` targets, and libclang.
The framework contains the Rust runtime archive, `PocketSurfaceView`, and
its generated C headers. The shell uses the arm64 device/simulator slices
and excludes x86_64. CocoaPods is not required.

`tools/play.ts` compiles the demo against `ios-dev` and passes the resulting
`.pocket` package to `tools/ios.ts`. The iOS tool admits that package, stages
`<output>.pocketjs`, `<output>.pak`, `<output>.plan.json` and `current.json`,
copies the framework into the local plugin, installs shell dependencies and
starts NativeScript. `--rebuild-native` rebuilds the framework before staging.
NativeScript build files, installed dependencies, staged assets and framework
copies are ignored by Git.

Build a simulator application without launching it through the host config:

```sh
bun tools/pocket.ts compile --manifest apps/nsengine/pocket.app.json \
  --project-root . --host-config programs/ios-simulator/pocket.host.config.ts \
  --output dist/ios/application.pocket
bun tools/pocket.ts build --config programs/ios-simulator/pocket.host.config.ts \
  --pocket dist/ios/application.pocket --out dist/ios/native
```

The native recipe writes `PocketShell.app` and `PocketApple.xcframework` under
`dist/ios/native`. To stage an existing package for a simulator run, use
`bun tools/ios.ts play --pocket dist/ios/application.pocket`.

The raw JS/pak entry points remain for existing UIKit consumers. The Apple
adapter wraps those inputs in the current `.pocket` format with
`pocket-package::embedded`, then passes the result through the standard
package reader. The wrapper derives its host contract hash from the configured
host identity, viewport, density, tick rate and service capabilities.

## Guest modes

- `PocketView` owns an `RquickjsGuest` inside the Runtime. Guest code runs in
  the QuickJS realm embedded in the framework.
- `PocketHostView` uses the NativeScript engine. UIKit calls the registered
  guest initialize/evaluate/frame/shutdown callbacks. The generated mount
  sends typed operation records through a generic Foundation transport.
  NativeScript guest code retains access to iOS platform APIs.

External guest byte arguments copy their exact typed-array window into
`NSData`. Returned bytes are copied before another runtime call can
invalidate them. Shutdown invalidates functions retained from `ui` and
removes the guest's global frame callback. The external mode mounts one
active guest in the NativeScript global namespace.

UIKit drives both modes through `pocket_apple_frame`; the separate
`pocket_apple_render` entry point reads the completed framebuffer. Repeated
snapshot reads do not advance guest time. The display reports a stable
buffer identity so the coordinator can retain unchanged pixels and skip
idle transfers. UIKit copies changed output into a `CGImage` for its layer.

Touches use the inverse aspect-fit mapping. Contacts retain their slot
until release, brief taps survive until a tick, and UIKit cancellation
produces the canonical cancellation word. Each frame includes the Runtime's
committed hit and surface arrays. Service effects are delivered after the
runtime tick; a synchronous host reply enters the next frame's service
queue. A disposal request from a guest or effect callback stops the timer
and destroys the instance after the active call returns.

## Host contract and shell

`hosts/ios-dev/pocket.host.json` declares the private `ios-dev` host contract: a 480×272
logical viewport, `input.touch` and `text.glyphs.baked`. The build and view
must agree on **identity, viewport, raster density and tick rate**. Set
`tickRate` before evaluating the bundle; later changes are rejected.
**The maintained `ios-dev` host contract uses raster density 3.** Glyph atlases
bake at that density and the view uses the same raster scale. Staging rejects
a `--density` or `--hz` value that differs from the selected host config.
`programs/ipodtouch6` uses the same UIKit consumer with its own identity and
viewport.

The shell reads the staged plan and mode, selects `PocketView` or
`PocketHostView`, and forwards service events. `--shell-dir` stages into a
compatible shell. `--plugin-path` overrides the maintained plugin checkout;
that checkout must implement the canonical guest bridge.
`--runtime-tgz` overrides the NativeScript QuickJS runtime package.

## Validation

```sh
cargo +stable test --locked --manifest-path Cargo.toml -p pocket-apple
bun test tests/nativescript-bridge.test.ts tests/ios-profile.test.ts tests/ipodtouch-profile.test.ts
```

Desktop tests execute real QuickJS and the external C guest callbacks
against the canonical Runtime. They cover frame output, instance isolation,
boot failure/retry, touch hit/cancel facts, service replies and callback
lifetime. JS tests cover generated dispatch, byte ownership and shutdown.
These checks do not validate UIKit metadata marshalling or device rendering;
those require an iOS framework build and the final platform acceptance run.
