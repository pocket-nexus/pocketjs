# iPod touch 6 connected-device host

PocketJS runs on the sixth-generation iPod touch as a native UIKit
application. **The tested device is `iPod7,1` on iOS 12.5.8 (`16H88`) with an
A8 processor and a 640×1136 Retina display.** The host exposes a 320×568
logical viewport at raster density 2.

## Execution path

The application statically links `engine/ios`:

- `pocket-mod` owns the QuickJS guest realm.
- `pocket-ui-surface` installs the synchronous `ui.*` operations and feeds the
  baked asset package.
- `pocketjs-core` lays out and software-rasterizes the draw list.
- `PocketSurfaceView` advances the guest from a 60 Hz main-run-loop timer,
  presents the framebuffer through Core Graphics, and maps UIKit touches back
  to logical coordinates. The iPod host selects this explicit clock because
  its jailbroken iOS 12 runtime does not deliver `CADisplayLink` callbacks;
  the default Apple host keeps the display-link path.

The iPod host publishes `ipodtouch-dev` / ABI 7. The NativeScript simulator
shell continues to publish `ios-dev` / ABI 7. **A plan-built guest refuses to
mount when the target identifier differs, even though both hosts share the
same operation ABI.**

## Build and deploy

The host requires Xcode, Rust's `aarch64-apple-ios` target, Bun dependencies,
`ldid`, libimobiledevice, and a Checkra1n-jailbroken device. Checkra1n exposes
Dropbear only through usbmux device port 44 in this workflow. The local tunnel
defaults to `127.0.0.1:2223`; it does not open a Wi-Fi listener.

```sh
rustup target add aarch64-apple-ios
bun install --frozen-lockfile
bun ipodtouch doctor
bun ipodtouch build
bun ipodtouch deploy
bun ipodtouch launch
```

`build` resolves `apps/ipodtouch-demo/pocket.json`, builds its Solid guest and
pak, compiles `pocket-apple` for arm64 iOS 12, links a UIKit executable, and
pseudo-signs it with `ldid`. Generated output is
`dist/ipodtouch/PocketJSiPod.app`. **The build ID hashes the compiled
`libpocket_apple.a` in addition to the guest and host inputs, so any transitive
native-code change produces a different device receipt.**

`deploy` performs these checks before replacing the installed bundle:

1. Re-identify the USB device as the exact tested model, system version, build,
   and activated state.
2. Start a new `iproxy` tunnel bound to that UDID and verify the jailbreak's
   SSH host key with the dedicated key in `~/.cache/pocket-nexus/ipodtouch/keys`.
   **Deploy, launch, status, and capture never reuse an existing local tunnel.**
3. Acquire a device-side deployment lock and extract through transaction-unique
   archive, unpack, stage, and backup paths.
4. Verify the staged executable's pseudo-signature and compare every recorded
   file with its local SHA-256 hash.
5. Rename the old bundle to its transaction backup, commit the stage, set
   ownership, verify the executable, and register the exact bundle with
   `uicache`. **The prior bundle is deleted only after every post-install check
   succeeds; any earlier failure restores and re-registers it.**

The installed path is `/Applications/PocketJSiPod.app`. The command does not
modify activation, firmware, root filesystem mounts, jailbreak packages, or
other applications.

While the dedicated demo is active, the host disables the application idle
timer. If iOS reports a near-zero display brightness when the app becomes
active, the host restores it to 60 percent. **The host re-enables normal idle
behavior when it enters the background.** The runtime receipt records both the
observed brightness and idle-timer state.

## App icon

`hosts/ipodtouch6/Icon.svg` is the only authored icon source. It uses the Pocket
homepage's `#171226`, `#1a1430`, and `#231b3b` plum surfaces with restrained
`#ffd23f` and `#ff5f9e` iOS 7-style ambient highlights. There is no baked outer
frame; SpringBoard applies the installed rounded mask. The centered mark
preserves the exact compact Pocket geometry from `site/assets/favicon.svg`.
`tools/ipodtouch-icon.ts` rasterizes that SVG into the
57, 114, 120, and 180-pixel iOS PNG names and produces the opaque 4-inch launch
images. For each output, the rasterizer asks the SVG renderer for an eight-times
target-sized vector raster and reduces each 8 x 8 sample block with an exact
area average. The small mark uses gradients without SVG filters, clipping, or
fractional inner strokes, so curved internal edges are sampled once and remain
antialiased at 57 pixels. **No generated PNG is committed.** The bundle receipt
hashes every baked file that deployment reads back from the device.

## Hardware acceptance

After launch, the app writes
`/private/var/tmp/pocketjs-ipodtouch.status.json`. The receipt contains the
build identity, PID, guest frame counter, screen geometry, completed touch
sequences, the most recent application action, and any runtime error.

```sh
bun ipodtouch status
# Tap and release the blue Hero action on the iPod.
bun ipodtouch status --require-action
bun ipodtouch capture
```

The action-level check accepts only `hero_tap` with a positive value after a
completed touch sequence. `capture` copies the device-rendered UIKit frame to
`dist/ipodtouch/device-frame.png` for visual inspection. **A successful build,
bundle copy, icon registration, or launch request is not a rendered-frame and
input receipt.**

The 320 x 568 logical surface exceeds the legacy touch wire's 9-bit Y range.
**The Apple host emits the framework's wide 10-bit touch form for this surface,**
so the bottom action remains hittable instead of being clamped to Y=511. **At
the down edge, the Apple core resolves the committed-frame bounds hit once and
carries that hit fact beside the contact as `frame()` argument 4 until release.**

The jailbreak is semi-tethered: after a full reboot, run Checkra1n again before
using deploy or launch. The installed app and dedicated SSH public key remain
on the data volume, but the USB Dropbear endpoint is unavailable until the
jailbreak is active again.
