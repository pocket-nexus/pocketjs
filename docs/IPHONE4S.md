# iPhone 4S

The private iPhone 4S target runs PocketJS on an exact `iPhone4,1` device with
iOS 6.1.3 build `10B329`. **The application owns a 320×480-point surface backed
by the phone's 640×960 Retina display.** The target remains outside the public
`POCKET_TARGETS` registry until support is expanded beyond this validated
hardware and firmware tuple.

## Device state

The device must be restored and jailbroken before the PocketJS tool connects.
The validated recovery path uses Legacy iOS Kit's iOS 6.1.3 restore with a
signed 9.3.6 baseband and the Aquila filesystem jailbreak. Restoring creates a
new partition map and erases the data partition.

The completed bootstrap provides:

- Cydia and a read/write root filesystem;
- OpenSSH on device port 22;
- a dedicated RSA client key and pinned device host key;
- `PasswordAuthentication no` after public-key login succeeds;
- `ldid`, `uicache`, and `uiopen` for application deployment.

The default local files are:

```text
~/.cache/pocket-nexus/iphone4s/ssh/id_rsa
~/.cache/pocket-nexus/iphone4s/ssh/known_hosts
```

`POCKETJS_IPHONE4S_KEY`, `POCKETJS_IPHONE4S_KNOWN_HOSTS`, and
`POCKETJS_IPHONE4S_UDID` override those paths and the selected USB device.

## Build inputs

Modern Xcode no longer contains ARMv7 iOS libraries. `prepare-sysroot` reads
the validated iOS 6.1.3 dyld shared cache from the operator's local CustomAJ
restore IPSW, builds Apple's pinned `dyld-210.2.3` extractor, thins the recovered
images to ARMv7, and generates local TAPI linker stubs from their exported
symbols.

**Apple system binaries remain under `~/.cache/pocket-nexus/iphone4s` and are
never copied into the repository or npm package.** The checked-in manifest pins
the firmware, dyld source, Csu source, QuickJS source, shared cache, and every
system image used by the linker.

```sh
export POCKETJS_IPHONE4S_IPSW=/path/to/iPhone4,1_6.1.3_10B329_CustomAJ-ECID.ipsw
bun iphone4s setup-sources
bun iphone4s prepare-sysroot
bun iphone4s doctor
```

When the CustomAJ IPSW is under the default Legacy iOS Kit cache and exactly one
matching file exists, the environment variable is not required.

## Build and deploy

```sh
bun iphone4s build
bun iphone4s deploy
bun iphone4s launch
bun iphone4s status
```

`build` resolves `apps/iphone4s-demo/pocket.json`, builds the Solid guest, builds
the no-std retained UI core for ARMv7, embeds the JS and PAK into the executable,
links against the derived iOS 6 stubs, and signs the bundle with `ldid`.
**The build ID hashes the guest and artwork plus every object, archive, and
linker stub used by the native link.** The host runtime is first compiled with
a fixed 32-byte identity placeholder so all transitive headers and compiled
code affect that ID before the final ID-bearing object is produced. `launch`
and `status` also require the complete installed file-hash receipt to match the
local receipt.

The iPhone 4S host requires OpenGL ES 1.1, initializes the retained UI core at
the resolved density 2, and sets the UIKit view's content scale to 2 before
allocating its renderbuffer. **A valid runtime receipt must report the `gles1`
renderer, density 2, and a 640×960 drawable for the 320×480 logical viewport.**
It fails instead of silently presenting the software rasterizer through a
`CAEAGLLayer` when that contract cannot be established.

SpringBoard artwork is rasterized from `hosts/iphone4s/Icon.svg`. **The
versioned `PocketClassic-v6.png` and `PocketClassic-v6@2x.png` are pre-masked
57×57 and 114×114 images with transparent corners.** Both use 4× supersampling with alpha-weighted area
averaging to prevent dark fringes. The selected D artwork uses a plum surface, muted yellow/pink/cyan
mark, and continuous radial light. `UIPrerenderedIcon` prevents an additional
system gloss layer; on the iOS 6 device it does not remove opaque pixels
outside the baked rounded shape. The versioned basename invalidates the old icon cache.
The same vector produces the launch-screen mark. `bun tools/device-icons.ts`
also regenerates the separately masked iPhone 2G icon and the independent
48×48 / 24×24 3DS icons; `--check` verifies their committed PNG bytes.

`deploy` verifies the exact device identity before opening a fresh UDID-scoped
USB tunnel. It acquires and renews a device-side lease, uses
transaction-specific paths, checks every staged file with device-side SHA-256,
keeps the previous bundle through ownership, signature, and application-cache
validation, and rolls back on failure. **A later deployment atomically takes
over an expired or incomplete lease and reconciles only the previous
transaction's validated archive, stage, unpack, and backup paths.**

## Hardware acceptance

The host writes `/private/var/tmp/pocketjs-iphone4s.status` from the device frame
loop. `status` requires a live PID, an advancing heartbeat and guest frame
counter, a byte-exact installed build receipt, a matching build ID, and an
empty runtime error. The record reports the actual renderer, drawable size,
raster density, and clock instead of inferring them from the build.

```sh
bun iphone4s status --require-action
bun iphone4s capture
```

`--require-action` additionally requires a completed touch sequence and a
`hero_tap` action that changed guest state. **Touch down resolves the committed
frame's bounds hit once and carries that hit fact through the contact.**

`capture` accepts only the 640×960 GLES1 Retina drawable, requests the next
device-rendered frame, downloads its bottom-up RGBA pixels, and writes the
physical-resolution `dist/iphone4s/device-frame.png`. The one-shot marker is
created as `mobile` and removed in cleanup; leaving a root-owned marker in the
sticky temporary directory would force a full GPU readback on every frame.
