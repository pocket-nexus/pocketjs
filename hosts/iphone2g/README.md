# iPhone 2G / iPhone OS 3.1.3 host

This is the deliberately private PocketJS host for the original iPhone
(`iPhone1,1`). The connected-device target is iPhone OS 3.1.3 (`7E18`). Xcode
26 still emits ARMv6 and `ld-classic` links against the byte-verified stock
1.1.4 (`4A102`) sysroot, so 1.1.4 is the executable's linker ABI floor rather
than the installed-system target.

The host is C on purpose. Modern `ld-classic` can link ARMv6 code and stock
ObjC libraries, but crashes while translating ObjC1 class-reference
relocations emitted for an `@implementation`. `hosts/ios-legacy/runtime.c`
therefore registers
its view and delegate through the Objective-C runtime API. It uses the 3.x
application lifecycle and UIKit touch selectors on the current phone, while
retaining the older 1.x event path as an ABI fallback. Device input is exposed
to PocketJS as the hardware-neutral `input.touch` capability.

Run the local checks, install the key-only USB deployment helper, build, and
deploy the complete demo bundle:

```sh
bun iphone2g doctor
bun iphone2g prepare-bootstrap
bun iphone2g install-bootstrap
bun iphone2g build
bun iphone2g deploy
bun iphone2g launch
```

`install-bootstrap` preserves the working CustomHJ `sshd`, device host key,
and launchd plist. It installs only the signed `pocketjs-device` helper, merges
the dedicated client key, pins the existing device host key, and disables
password SSH only after key authentication and helper verification succeed.
The USB tunnel is managed automatically for install, deploy, launch, and
status; use `bun iphone2g tunnel` only when a persistent foreground forward is
useful.

After `deploy` refreshes the application cache and restarts SpringBoard,
`launch` verifies the installed build receipt and asks SpringBoard to open
**PocketJS** through its private URL scheme. Tap the Hero action, then run:

```sh
bun iphone2g device-status
```

That command accepts only a fresh schema-2 status record for the current build.
**The recorded process must still be alive, its heartbeat must be recent, a
touch release must have completed, and the application must have reported a
changed `hero_tap` count.** A bounds hit, successful build, or byte-exact
installation alone is not live runtime acceptance.

The earlier schema-1 receipt for build
`ba1c0b15af4fdb72c6a98334332a8954` reported 118 running guest frames and 11
touch sequences. It is retained as historical evidence but is no longer
accepted because it lacks process liveness, heartbeat, release completion, and
application-action fields. The app bundle carries a dedicated 59-by-60
transparent-corner icon with black enamel, a chrome bevel, and a pre-baked
glass highlight for the classic SpringBoard.
The phone retained the complete previous app bundle, key-only SSH, and the
helper across a Home + Power restart after device-side `/sbin/reboot` stalled
on its shutdown spinner. That is a forced-restart recovery result, not proof
that unattended `/sbin/reboot` completes on this installation.

The host has two render paths. **The software rasterizer is the default** and
holds a locked 60 fps at ~7.6 ms per frame, because both the rasterize and the
composite are limited to the damaged rectangle. The OpenGL ES 1.1 backend for
the device's PowerVR MBX Lite is opt-in (`touch
/private/var/tmp/pocketjs-iphone2g.gles1`), correct, and pixel-verified, but
costs 17-20 ms because it re-submits the whole DrawList every frame.

Both paths are verified against the reference core by capturing the device's own
output; `docs/IPHONE2G.md` documents the marker files, the byte-order and
orientation difference between the two captures, and the ES 1.1 state that has
no ES 2 equivalent.

Artifacts are written to `dist/iphone2g/PocketJSDemo.app`. The app contains
the generated Solid/PocketJS guest, pinned QuickJS, PocketJS raster core, and
UIKit host. Firmware, the decrypted sysroot, Apple Csu and QuickJS sources,
pairing records, SSH keys, ramdisks, historical bootstrap packages, and Cargo
target cache live only under the shared `pocket-nexus` toolchain cache. They are never
copied into the repository.

See `docs/IPHONE2G.md` for the exact workflow and the archived 1.1.4 recovery
incident. The current deployment does not enter DFU, restore firmware, alter
activation or baseband state, enable AFC2, replace CustomHJ SSH components, or
change `fstab`; the restored 3.1.3 root and data volumes remain read/write by
design.
