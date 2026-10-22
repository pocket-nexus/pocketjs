# iPod touch 6 / iOS 12 host

This host runs one PocketJS guest directly in a UIKit application on the
sixth-generation iPod touch (`iPod7,1`). **The device surface is 320×568
logical points rasterized to its 640×1136 Retina display at density 2.** It
provides `input.touch` and baked glyphs; it does not publish buttons, analog
input, networking, or device SDK objects to application code.

The executable statically links `engine/ios` and uses the shared
`PocketSurfaceView`. Its target identity is `ipodtouch-dev` with host ABI 7.
The NativeScript simulator shell retains the default `ios-dev` identity; the
new identity-aware initializer prevents the two build profiles from being
interchangeable. This host selects the view's explicit 60 Hz run-loop timer
because the tested jailbroken iOS 12 runtime does not deliver
`CADisplayLink` callbacks; other Apple hosts keep the display-link clock.

Run the connected-device workflow with:

```sh
bun ipodtouch doctor
bun ipodtouch build
bun ipodtouch deploy
bun ipodtouch launch
bun ipodtouch status
```

Deployment uses Checkra1n's USB-only Dropbear endpoint on device port 44 and a
dedicated local key under `~/.cache/pocket-nexus/ipodtouch/keys`. The app is
installed transactionally at `/Applications/PocketJSiPod.app`, pseudo-signed
with `ldid`, registered with `uicache`, and launched through its URL scheme.

The app writes a fresh status record and a screen capture to
`/private/var/tmp`. **Runtime acceptance requires a live PID, advancing guest
frames, an error-free receipt, a completed touch sequence, and a changed
`hero_tap` action.** Build, copy, `uicache`, or launch success alone does not
establish that the guest rendered or handled input.

`Icon.svg` is the source of truth for app artwork. The build bakes opaque iOS
PNG sizes and the 4-inch launch image from that SVG; generated PNG files stay
under `dist/ipodtouch/`.
