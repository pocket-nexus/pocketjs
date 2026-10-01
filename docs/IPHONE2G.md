# iPhone 2G / iPhone OS 3.1.3 development

This document tracks the experimental PocketJS target for an original iPhone
(`iPhone1,1`). The current device target is iPhone OS **3.1.3** (`7E18`). The
native artifact is still compiled with a byte-pinned iPhone OS **1.1.4**
(`4A102`) sysroot and `LC_VERSION_MIN_IPHONEOS` of 1.1.4; that is its linker ABI
floor, not a claim that the connected phone still runs 1.1.4. The bundle's
`MinimumOSVersion` and supported installed-system target are 3.1.3.

`PocketJSDemo.app` is an ARMv6 UIKit host containing the generated PocketJS
JavaScript and asset pack, pinned QuickJS, and the PocketJS raster core.
Building the bundle proves the compiler, linker, and packaging seam. It does
not by itself prove that the 1.1.4-ABI binary runs correctly on 3.1.3.
Deployment, drawing, and touch are therefore recorded as separate
live-hardware acceptance gates below.

## Current status

| Layer                        | Target                                                        | Status                   |
| ---------------------------- | ------------------------------------------------------------- | ------------------------ |
| Device hardware              | `iPhone1,1`, ARMv6, normal USB `05ac:1290`                    | **Pass**                 |
| Installed system             | iPhone OS 3.1.3 (`7E18`), FactoryActivated                    | **Pass**                 |
| Recovery                     | Legacy-iOS-Kit CustomHJ erase restore                         | **Pass**                 |
| Device access                | SpringBoard, Cydia, `sshd`, and USB SSH                       | **Pass**                 |
| Build ABI                    | 1.1.4 (`4A102`) sysroot and linker ABI floor                  | **Pass, local only**     |
| 3.1.3 package/deployment     | Signed bundle plus transactional install/readback             | **Pass**                 |
| PocketJS runtime/input       | Current-build guest frames and successful physical touch hits | **Pass, live device**    |
| Installed-bundle persistence | Previous build remained complete across Home + Power restart  | **Pass, forced restart** |
| Clean unattended reboot      | `/sbin/reboot` stalled and required Home + Power              | **Not established**      |

The target remains private and experimental even though the exact
build/deploy/runtime/input path now has a live-device receipt. Passing that
receipt does not broaden support beyond `iPhone1,1` on 3.1.3 (`7E18`). In
particular, a successful install and the presence of SpringBoard, Cydia, or SSH
alone are not PocketJS runtime acceptance.

## Verified 3.1.3 recovery receipt

On 2026-08-05, the working recovery route was an **erase restore** to the pinned
Legacy-iOS-Kit CustomHJ image:

```text
iPhone1,1_3.1.3_7E18_CustomHJ.ipsw
SHA-1 8140ed162c6712a6e8d1608d3a36257998253d82
```

The restore completed with `Status: Restore Finished`. After normal boot, the
following independent checks passed:

- USB re-enumerated in normal mode as Apple product `0x1290`;
- `ideviceinfo` reported `ProductVersion: 3.1.3`, `BuildVersion: 7E18`, and
  `ActivationState: FactoryActivated`;
- SpringBoard and Cydia launched;
- `sshd` was running and a command completed over USB SSH.

This receipt proves the erase restore, normal boot, activation state, and a
working USB shell transport. It does not prove that `PocketJSDemo.app` has
been installed or executed. Do not replace this receipt with “entered WTF”,
“image hash matched”, or “restore process started”; those were earlier gates,
not completion.

The restore erased and reformatted the installed system. The pre-change raw
filesystem backup remains preservation evidence, but it does not contain the
baseband NOR or seczone and must not be described as a complete radio/unlock
backup. Its repo-external receipt is
`backups/pre-jailbreak-20260804-1340/raw/rdisk0.img` under the iPhone 2G cache;
the expected whole-filesystem-disk size is 8,120,172,544 bytes.

## Safety and scope

The supported device/installed-OS tuple for continued development is exact.
The end-to-end build, deployment, runtime, and touch-input path is verified for
this tuple, with the reboot caveat recorded in acceptance layer 4:

- device: `iPhone1,1` (original iPhone / iPhone 2G);
- installed OS: iPhone OS 3.1.3, build `7E18`;
- activation observed after restore: `FactoryActivated`;
- CPU and executable format: ARMv6 Mach-O;
- build sysroot/linker ABI floor: iPhone OS 1.1.4, build `4A102`;
- bundle and installed-system target: iPhone OS 3.1.3, build `7E18`;
- normal-mode USB identity: Apple `05ac:1290`;
- application location to validate: `/Applications/PocketJSDemo.app`.

Do not run the archived 1.1.4 bootstrap procedure on the restored 3.1.3
installation. In particular, do not install its eight historical SSH files,
replace the working `sshd`, restore 1.1.4 filesystem blocks, alter activation,
or mix 1.1.4 kernel payloads with the 3.1.3/7E18 boot chain. The current
`prepare-bootstrap` and `install-bootstrap` commands are a separate 3.1.3
workflow: they preserve the working CustomHJ `sshd`, host key, and launchd
plist. Baseband, bootloader, NOR, seczone, AFC services, activation records,
and radio state remain outside the PocketJS deployment scope.

There is intentionally no repository command that enters DFU, restores an
IPSW, reformats NAND, or changes boot/radio state. Those destructive operations
require an operator-reviewed recovery plan, a byte-verified image, an explicit
erase authorization, and a separately verified exit route.

## Repository commands and cache

`package.json` exposes `bun iphone2g`, which dispatches to
`tools/iphone2g.ts`:

| Command                          | Current meaning                                                                                                                                                                                                                                                                                                                                                  | Device access                    |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `bun iphone2g doctor`            | Checks the local 1.1.4 ABI inputs, `ldid`, and pinned source/recovery artifacts. It does not certify the device.                                                                                                                                                                                                                                                 | None                             |
| `bun iphone2g setup-sources`     | Clones and verifies Apple `Csu-76`, QuickJS, and Legacy-iOS-Kit checkouts if absent.                                                                                                                                                                                                                                                                             | None                             |
| `bun iphone2g prepare-bootstrap` | Builds and signs the ARMv6 `pocketjs-device` helper, creates or verifies the dedicated RSA client key, and stages the 3.1.3 key-only SSH policy plus receipt. It does not contact the phone.                                                                                                                                                                     | None                             |
| `bun iphone2g install-bootstrap` | Rebuilds/verifies the stage, checks the exact `iPhone1,1`/3.1.3/`7E18` tuple and read/write mounts, pins the existing CustomHJ RSA host key, merges the client key, installs the signed helper, and disables password SSH only after key/helper checks pass. The transaction preserves the device `sshd`, host key, and launchd plist and rolls back on failure. | USB SSH; managed tunnel          |
| `bun iphone2g tunnel`            | Runs a foreground `127.0.0.1:2222` to device port 22 usbmux forward for repeated manual access. Install, deploy, and status start a temporary tunnel themselves when one is not already listening.                                                                                                                                                               | USB                              |
| `bun iphone2g build`             | Builds and `ldid`-signs the 3.1.3-targeted `dist/iphone2g/PocketJSDemo.app` against the 1.1.4 ABI sysroot.                                                                                                                                                                                                                                                       | None                             |
| `bun iphone2g deploy`            | Rebuilds a signed bundle, verifies the installed helper, performs a transactional install with byte-exact readback and rollback, checks that root and data remain read/write, commits, refreshes the application cache as `mobile`, and restarts SpringBoard.                                                                                                    | Key-only USB SSH; managed tunnel |
| `bun iphone2g launch`            | Verifies that the installed build receipt matches the current local bundle, then asks SpringBoard to open the demo through its private `pocketjs-iphone2g-demo` URL scheme.                                                                                                                                                                                      | Key-only USB SSH; managed tunnel |
| `bun iphone2g device-status`     | Verifies a fresh schema-2 record for the current build: the recorded PID is alive, the heartbeat advances, the guest is producing frames, a touch release completed, the Hero action changed application state, and no runtime error is present.                                                                                                                 | Key-only USB SSH; managed tunnel |

`setup-csu`, `build-demo`, and `build-runtime` remain lower-level entry points.
`build-probe` is a compatibility alias for the full guest-plus-runtime build;
despite its historical name, its output is `PocketJSDemo.app`.

### Current 3.1.3 workflow

With the restored phone normally booted and attached over USB, the supported
sequence is:

```sh
bun iphone2g doctor
bun iphone2g prepare-bootstrap
bun iphone2g install-bootstrap
bun iphone2g build
bun iphone2g deploy
bun iphone2g launch
# On the phone: tap the Hero action.
bun iphone2g device-status
```

`install-bootstrap`, `deploy`, `launch`, and `device-status` use an already
listening local port 2222 tunnel or manage a temporary one around the command.
For a persistent foreground tunnel, run `bun iphone2g tunnel` in another
terminal; it fails rather than taking over if local port 2222 is already in
use.

The bootstrap stage contains exactly three managed files: the signed helper,
the proposed key-only `sshd_config`, and the dedicated public key. Installation
merges that key into the phone's existing `authorized_keys`. It first proves
that either the dedicated key or the temporary CustomHJ `root`/`alpine` path
can reach the normally booted phone; after the dedicated key and helper work,
it validates and activates the key-only configuration, verifies that password
authentication is rejected, and only then commits. Re-running it is
idempotent when the verified helper and policy already match.

`deploy` does not launch the app. Its success proves signing, transactional
installation, byte-for-byte device readback, mount-policy preservation, and a
SpringBoard restart. `launch` checks that the installed receipt matches the
current local build before asking SpringBoard to open it. The operator must
still tap and release the Hero action. Only a subsequent successful
`device-status` is the machine-readable runtime/input gate. **A bounds hit
alone is not accepted:** the record must contain a completed touch sequence
and the application-reported `hero_tap` count.

By default, proprietary and device-specific material lives outside the
repository at:

```text
~/.cache/pocket-nexus/iphone2g
```

The supported overrides are:

```sh
export POCKETJS_IPHONE2G_ROOT=/absolute/cache/root
export POCKETJS_IPHONE2G_SYSROOT=/absolute/path/to/read-only-derived-sysroot
export POCKETJS_IPHONE2G_CSU=/absolute/path/to/Csu-76
export POCKETJS_IPHONE2G_QUICKJS=/absolute/path/to/pinned-quickjs-rs
export POCKETJS_IPHONE2G_IDENTITY=/absolute/path/to/dedicated-client-key
```

Do not commit firmware, decrypted system files, ramdisks, pairing or activation
records, SSH keys, or historical binary packages. The canonical versions,
URLs, revisions, and hashes are in
[`tools/cli/iphone2g-toolchain.json`](../tools/cli/iphone2g-toolchain.json).

### 1.1.4 build and archival artifact preparation

`doctor` verifies bytes that already exist; it does not download firmware,
decrypt the root image, or extract a sysroot. Supply these cache artifacts by a
separately audited local process:

```text
downloads/iPhone1,1_1.1.4_4A102_Restore.ipsw
sysroot-1.1.4/iPhoneOS-1.1.4-rootfs.raw
sysroot-1.1.4/rootfs/usr/lib/libSystem.B.dylib
sysroot-1.1.4/rootfs/usr/lib/libgcc_s.1.dylib
sysroot-1.1.4/rootfs/usr/lib/libobjc.A.dylib
sysroot-1.1.4/rootfs/System/Library/Frameworks/UIKit.framework/UIKit
sysroot-1.1.4/rootfs/System/Library/Frameworks/Foundation.framework/Foundation
sysroot-1.1.4/rootfs/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics
downloads/bootstrap/openssh_4.7p1-1_iphoneos-arm.deb
downloads/bootstrap/openssl_0.9.8g-1_iphoneos-arm.deb
sources/Legacy-iOS-Kit-1e982b7f2a27ff0f77fe138b9bd48bd7cf431ca6/
  saved/iPhone1,1/ramdisk_7E18/saved/{iBSS,Ramdisk.dmg,DeviceTree.dec,Kernelcache.dec}
```

The pinned 1.1.4 IPSW SHA-256 is:

```text
25fa72bc07e1879646a690e49090ff376904128cfa333b606a19337d4d02b586
```

The decrypted raw root image SHA-256 expected by `doctor` is:

```text
14fbd2206049e6d48a17791a92c1ddda0ff82a71638f0b9bfdb4107dcc576b90
```

The sysroot check hashes every framework and library that the host or device
helper links. Its provenance remains the pinned raw image rather than files
copied from a modified phone; the build receipt records both that raw-image hash
and the exact linked-file hashes.

Install the pinned Rust toolchain used to build the freestanding PocketJS raster
core, then fetch the public Apple Csu and pinned QuickJS sources:

```sh
rustup toolchain install nightly-2026-07-02 --profile minimal --component rust-src
bun iphone2g setup-sources
```

The source setup verifies Csu tag `Csu-76`, revision
`a02bd5830f6fbe841d5b0bd54b90ee5f35b99a4e`, and the exact `start.s` and
`dyld_glue.s` bytes. It checks out QuickJS-rs revision
`ba5bdd0dc013518768e76cd9e05cd30ed53dd35b` and requires embedded QuickJS
version `2026-06-04`. `doctor` also checks that the pinned Rust compiler is
available; the actual build is the stronger check that its `rust-src`
component is present.

Place the two historical bootstrap packages in
`$POCKETJS_IPHONE2G_ROOT/downloads/bootstrap` (or the default cache equivalent)
and verify them before staging:

```text
openssh_4.7p1-1_iphoneos-arm.deb
SHA256 77f4f02594a0bdcaa54a7e3d9719e4cdab510582f0565c5129d64a87f1e18bda

openssl_0.9.8g-1_iphoneos-arm.deb
SHA256 13819c6d8ba21d85296f85994f21b92f9d22dfb51bdfbba02d08d0c1edc1ec12
```

Then run the read-only local checks:

```sh
bun iphone2g doctor
```

Every required line must report `[ok]`. `ldid` is required to sign the current
3.1.3-targeted executable and device helper.

## Build the 3.1.3 bundle with the 1.1.4 ABI sysroot

Build the generated guest and native runtime as one workflow:

```sh
bun iphone2g build
```

For diagnosis, the two lower-level stages are:

```sh
bun iphone2g build-demo
bun iphone2g build-runtime
```

Outputs:

```text
dist/iphone2g/guest/
dist/iphone2g/PocketJSDemo.app/
```

The native build uses current Xcode Clang for ARMv6 object generation and invokes
`ld-classic` directly against the byte-pinned 1.1.4 sysroot and Apple `Csu-76`.
It compiles pinned QuickJS, builds the PocketJS raster core with the pinned Rust
nightly, and embeds the generated JavaScript and `.pak` as Mach-O sections. The
Rust target directory is retained under the external iPhone 2G cache, so the
first standard-library build can take several minutes while later demo builds
reuse it. Removing `~/.cache/pocket-nexus/iphone2g/build/rust-target` forces a
clean Rust rebuild. The
host stays in C and registers its small UIKit view/delegate classes through the
Objective-C runtime because the current classic linker cannot safely translate
old ObjC1 class-reference relocations emitted by an `@implementation`.

The runtime build checks that the result is an ARMv6 Mach-O executable and that
its load commands include UIKit, Foundation, CoreGraphics, libobjc, libSystem,
and `libgcc_s.1`. The 1.x `GSEvent` fallback is resolved with `dlsym` so the
3.1.3 executable does not retain the obsolete public-Frameworks
GraphicsServices install name. It writes `build-receipt.json` with the
toolchain, sysroot, Csu, QuickJS, Rust, guest JavaScript, guest pack, core
library, and executable identities plus `signed: true` and `signer: "ldid -S"`.
It also assigns the per-build identifier later used to bind deployment,
rollback, and runtime-status evidence to these exact bundle bytes.

Useful independent inspection is:

```sh
file dist/iphone2g/PocketJSDemo.app/PocketJSDemo
xcrun otool-classic -L dist/iphone2g/PocketJSDemo.app/PocketJSDemo
plutil -lint dist/iphone2g/PocketJSDemo.app/Info.plist
shasum -a 256 dist/iphone2g/PocketJSDemo.app/PocketJSDemo
```

A successful build proves only the host compiler/linker/package layer. It says
nothing about USB deployment, SpringBoard discovery, process launch, drawing,
or touch on the phone.

## Render paths

The host has two. **The software rasterizer is the default** because it is
measurably faster here; the GL backend is opt-in.

| Path | Mechanism | Measured on `iPhone1,1` / 3.1.3 |
| --- | --- | --- |
| Software raster (default) | The core rasterizes only the damaged spans; `drawRect:` composites only the damaged rectangle. | **59.99 fps**, 1.44 ms guest + 5.93 ms raster + 0.26 ms composite |
| OpenGL ES 1.1 | The core walks its whole DrawList into the fixed-function pipeline every frame. | **48.6–50.7 fps**, 1.8–2.3 ms guest + 12.8–16.2 ms submit |

The software path holds a **locked 60** at ~7.6 ms of a 16.67 ms budget. The GL
path is correct and pixel-verified but costs 17–20 ms, because it re-submits and
re-fills everything every frame; giving it the same damage treatment — scissor
to the plan's bounds — is the open work.

### What made the difference

Scoping the composite, not the rasterizer. The rasterizer was always
damage-limited; the composite was not. `setNeedsDisplay` invalidated the whole
view and `pocket_draw_rect` discarded the rect UIKit passed, so every frame
rebuilt a `CGImage` and blitted all 320×480. That cost **22–27 ms**. Now:

- an **empty** damage plan invalidates nothing, so the frame costs no composite
  at all — 626 of 961 frames in one sample;
- a non-empty plan goes to `setNeedsDisplayInRect:`, and `drawRect:` clips to
  whatever UIKit passes back.

The composite fell from 22–27 ms to **0.26 ms**. No preservation guarantee is
relied on: when UIKit discards the backing store it passes the full bounds and
the code draws the full frame.

### Selecting a path

```sh
# opt into OpenGL ES 1.1 for the next launch
ssh … 'touch /private/var/tmp/pocketjs-iphone2g.gles1'
# back to the default software rasterizer
ssh … 'rm -f /private/var/tmp/pocketjs-iphone2g.gles1'
```

The marker is read in two places and **both must agree**: `setup_gl` consults
it, and so does the view's `+layerClass`. A `CAEAGLLayer` never receives
`drawRect:`, so a view backed by one cannot composite a software frame at all.
Returning `CAEAGLLayer` unconditionally once left the software path computing
frames that could not reach the screen.

The app must be restarted for a change to take effect, and iPhone OS 3 has no
third-party multitasking, so kill it rather than expecting a relaunch to replace
it:

```sh
ssh … 'kill -9 $(sed -n "s/^pid=//p" /private/var/tmp/pocketjs-iphone2g.status)'
bun iphone2g launch
```

`ps ax` prints nothing on this installation. Use `kill -0 <pid>` for liveness;
`ps ax | grep` reports a running process as absent.

### Sampling, and how much to trust one window

Take several windows. One is not enough, and the two paths differ in how stable
they are.

The software path is tight and reproducible. Five long-window samples over one
run: **59.98, 59.97, 59.97, 47.97, 59.68 fps**, with `js+core` 1.42–1.44 ms,
raster 5.96–5.98 ms and composite 0.25–0.26 ms. The single dip came with raster
at 7.96 ms and is transient.

The OpenGL ES 1.1 path fluctuates by roughly a factor of two in submit cost, and
this is unexplained. The same five-sample run gave **46.95, 53.19, 47.60, 50.76,
59.98 fps** with submit 15.40, 12.72, 15.79, 14.62 and **7.68 ms**. It is not
warm-up — the cost goes up as well as down. The 7.68 ms sample arrived after the
device had been untouched for about a minute, so display dimming changing what
the window server composites is a candidate, but nothing here establishes it.

**Do not quote a single GL window as the frame rate.** The steady-state range is
47–53 fps; the outlier is recorded because leaving it out would be dishonest and
folding it in would be worse.

### Reading the record

`renderer=` and `clock=` name the path and the clock that actually ran. Neither
is inferred: a GL failure falls back to the rasterizer by design, so without
those fields a hardware receipt and a software receipt are byte-identical.

`window_frames` and `window_us` are counted on the device between record writes,
so the frame rate is exact. Differencing two fetched records is worth about
±4 fps — the record is written once per heartbeat and its timestamp has
one-second resolution.

`damage_attempts`, `damage_failures`, `damage_full_redraws` and `damage_pixels`
come from the plan the incremental rasterizer returns, which used to be
discarded. **`damage_failures` is the one to watch:** planning that returns an
error silently draws a complete frame, and without a counter that is
indistinguishable from the machine being slow. `composites` counts `drawRect:`
calls — compare it against `guest_frames`, because a scoped invalidation that
never fires looks exactly like a very fast one.

### Pixel parity against the reference core

Both paths can be verified by capturing the device's own output rather than by
looking at the screen:

```sh
ssh … 'touch /private/var/tmp/pocketjs-iphone2g.capture'
# the next frame is written to pocketjs-iphone2g.frame.rgba and the request is
# cleared; 614,400 bytes for 320x480
ssh … 'cat /private/var/tmp/pocketjs-iphone2g.frame.rgba' > device-frame.rgba
```

**The two paths differ in byte order and orientation, and getting this wrong
produces a convincing false failure:**

| Path | Bytes | Rows |
| --- | --- | --- |
| GL (`glReadPixels`, `GL_RGBA`) | R,G,B,A | bottom-up |
| Software (the core's ARGB32 words) | B,G,R,A | top-down |

The wasm reference core emits R,G,B,A top-down. Comparing the software capture
without swapping red and blue reports a mean difference of 9.3/255 and a picture
in which every blue is orange.

Against the same guest rendered by the reference core, 200 frames in with
animations settled:

```text
GL path                     mean 0.04 / 255, worst channel 7
software, after 2581 frames mean 0.039 / 255, worst channel 186
```

Both residues are the animating spinner at a different phase — for the software
capture the differing pixels sit inside x 37..56, y 253..281, within the
spinner's own 40×40 box, with `damage_failures=0`. That is the test that matters
for a damage-limited rasterizer: the framebuffer persists across frames and only
damaged spans are rewritten, so under-reported damage accumulates as staleness
a from-scratch reference render will catch.

### ES 1.1 state the ES 2 pipeline does not need

`engine/ui-cabi/src/gl/es1.rs` must state four things that have no ES 2
equivalent, because sampling there is written into the fragment shader:

- **`glEnable(GL_TEXTURE_2D)`** — texturing is a per-unit enable in ES 1.1.
  Without it every fragment takes only its vertex colour, so flat fills look
  correct while all text, images and atlas content vanish. This shipped once.
- `glTexEnvi(GL_TEXTURE_ENV, GL_TEXTURE_ENV_MODE, GL_MODULATE)` — the documented
  default, stated because the drawable is shared with UIKit's compositor.
- `glShadeModel(GL_SMOOTH)` — gradients interpolate per-vertex colour.
- An identity texture matrix, because the DrawList's UVs are already normalized.

A test in `tests/iphone2g-profile.test.ts` pins all four.

## Historical 1.1.4 incident and preservation record

> **Archive, not a current runbook.** The sections below preserve the exact
> 1.1.4-era design and the evidence that invalidated it. Do not execute their
> ramdisk, bootstrap-install, filesystem-write, deployment, or rollback commands
> on the restored 3.1.3 phone. They remain here so the failed mixed-version path
> is reviewable and is not accidentally rediscovered.

### Incident trigger: the temporary SSH ramdisk

#### NAND epoch hazard observed on this device

After the `ramdisk_7E18` SSH ramdisk was booted on this phone while it ran
1.1.4, the installed 1.1.4 system stopped booting. This is a hardware
observation from this incident, not a general claim that every possible 1.x
recovery route is impossible.

The Legacy-iOS-Kit SSH ramdisk for `iPhone1,1` is built from iPhone OS **3.1.3**
(`7E18`). During this incident, opening the flash translation layer with its
WMR/FTL driver changed the NAND format signature — the "epoch" — from the
`C003` expected by 1.1.4 to `C005`, before the installed volumes were mounted.
The native 1.1.4 bootloader then reported:

```text
no signature or no production format
root filesystem mount failed
```

and the phone returned to Recovery on every native 1.1.4 boot attempt.

Three consequences are easy to get wrong, so state them plainly:

- **Restoring the file data did not recover this incident.** On this
  device the full 8,120,172,544-byte disk image was written back and re-read;
  the MBR, every allocated `disk0s1` block and every allocated `disk0s2` block
  matched the backup by SHA-256, and the era-matched `fsck_hfs -q` reported both
  volumes `FILESYSTEM CLEAN`. 1.1.4 iBoot still refused to boot, because the
  rejection happens _below_ the partition table.
- **The step is not read-only, despite touching neither OS nor baseband.** The
  paragraph below is accurate that the ramdisk does not flash the installed OS
  or the baseband. It changes NAND metadata anyway, and that is enough to make
  the installed OS unbootable.
- **No in-place reversal was validated.** An attempted 1.1.4-era kernel/helper
  path intended to drive the NAND FTL epoch selector wedged the device. Do not
  reuse those unvalidated payloads.

The recovery route that was actually validated was a **full 3.1.3 erase
restore**, which reformatted the NAND as part of the restore. The table is
scoped to the pinned Kit revision and this lab; it is not a universal statement
about all hand-built restore research:

| Target               | Status in this lab                                                                                  |
| -------------------- | --------------------------------------------------------------------------------------------------- |
| 3.1.3 (`7E18`)       | **Verified** — the CustomHJ erase restore completed and normal boot/USB/SSH passed.                 |
| 2.0 – 3.1.2          | Not tested here; the pinned Kit exposes an `Other (Custom IPSW)` path.                              |
| 1.x, including 1.1.4 | **No validated route in this repository.** The pinned `restore.sh` says its 1.x path will not work. |

The project therefore retargeted this development phone to 3.1.3. The original
1.1.4 bytes remain useful as a build sysroot and preservation record; they are
not the current installed-system target.

#### White-screen custom-kernel failure observed during the incident

The failed custom boot showed a **plain white screen** with no USB enumeration.
That establishes the symptom for this attempt; it does not establish that every
white screen has the same cause.

Repeated Home + top-button attempts did not recover this particular hang. Stop
blind button cycles when neither the display nor USB state changes; first
classify the USB mode with a detector that recognizes Recovery, WTF (`0x1222`),
and DFU (`0x1227`) by product ID rather than product name.

The exit used for this incident was complete power depletion. All power was
disconnected; the backlight eventually went dark, the phone was left unpowered
for a further interval, and only then was it reconnected for USB mode
classification.

After the SoC lost power, the phone again reached a bootrom/iBoot USB mode and
the audited restore could continue. Power depletion is hard on an 18-year-old
cell and is an incident outcome, not the first-line recovery instruction.

#### Archived prerequisites

These were prerequisites for reconstructing the 1.1.4 incident, not for the
current 3.1.3 device. The checkout and four boot artifacts are preserved here
for auditability:

```text
sources/Legacy-iOS-Kit-1e982b7f2a27ff0f77fe138b9bd48bd7cf431ca6/
saved/iPhone1,1/ramdisk_7E18/saved/iBSS
saved/iPhone1,1/ramdisk_7E18/saved/Ramdisk.dmg
saved/iPhone1,1/ramdisk_7E18/saved/DeviceTree.dec
saved/iPhone1,1/ramdisk_7E18/saved/Kernelcache.dec
```

The historical preparation created the detached checkout and verified the
saved ramdisk artifacts with:

```sh
bun iphone2g setup-sources
bun iphone2g doctor
```

At the time, the hard precondition was that `doctor` reported both `pinned
Legacy-iOS-Kit` and `verified SSH ramdisk` as `[ok]`, proving the checkout was
at clean revision `1e982b7f2a27ff0f77fe138b9bd48bd7cf431ca6` and every boot
artifact matched the manifest. The recorded ramdisk invocation was:

```sh
IPHONE2G_KIT=/absolute/cache/path/to/Legacy-iOS-Kit-1e982b7f2a27ff0f77fe138b9bd48bd7cf431ca6
cd "$IPHONE2G_KIT"
./restore.sh --sshrd --no-finder
```

The incident scope excluded the Kit actions named `Get iOS Version`, `Dump
Baseband/Activation`, and `Install OpenSSH`, as well as its `mount.sh`. Those
paths had broader filesystem behavior than the preservation design. The design
did not read or change the baseband or replace activation records, AFC services,
or `fstab`.

The historical S5L8900 prompt sequence was:

1. Starting from Recovery, hold the top and Home buttons together for 8
   seconds.
2. Release the top button and continue holding Home for 13 seconds.
3. The device first presents WTF mode (`0x1222`); the Kit sends patched Apple WTF
   and transitions it to true DFU (`0x1227`).
4. On a detection failure, stop without choosing Restore.

A direct, simple USB cable/dongle is preferable to an unreliable hub. The
ramdisk sets `auto-boot=1` in NVRAM and starts temporary services, so even this
step is not literally zero-write. It does not flash the installed OS or
baseband — but it does raise the NAND epoch, which is the one-way cost described
at the top of this section. Do not read "does not flash the OS" as "the OS still
boots afterwards"; on this device it did not.

Keep the Kit menu open while using a second terminal. The Kit maintains an SSH
forward on `127.0.0.1:6414`; the ramdisk account is the historical
`root`/`alpine` pair:

```sh
IPHONE2G_KIT=/absolute/cache/path/to/Legacy-iOS-Kit-1e982b7f2a27ff0f77fe138b9bd48bd7cf431ca6

sshrd() {
  [ "$#" -eq 1 ] || return 64
  "$IPHONE2G_KIT/bin/macos/arm64/sshpass" -palpine \
    /usr/bin/ssh -F "$IPHONE2G_KIT/resources/ssh_config" \
    -o PubkeyAcceptedAlgorithms=+ssh-rsa \
    -p 6414 root@127.0.0.1 "$1"
}

sshrd_script() {
  "$IPHONE2G_KIT/bin/macos/arm64/sshpass" -palpine \
    /usr/bin/ssh -F "$IPHONE2G_KIT/resources/ssh_config" \
    -o PubkeyAcceptedAlgorithms=+ssh-rsa \
    -p 6414 root@127.0.0.1 /bin/bash -s
}
```

The `alpine` password applies only to the temporary ramdisk. The persistent
bootstrap below is key-only and does not alter the phone's root password.
Every multi-step remote block below starts with `set -e`; an error must stop the
write path. Never paste a semicolon-separated write sequence without this
fail-closed behavior.

### Archived backup procedure before the first 1.1.4 write

#### Whole filesystem disk image

The commands below record the pre-change backup procedure. Do not rerun them on
the restored 3.1.3 installation. The procedure first proved that only the
temporary memory disk was mounted and inspected the whole-disk partition table
without repairing or changing it:

```sh
sshrd_script <<'RAMDISK'
set -e
/sbin/mount
/bin/ls -l /dev/disk* /dev/rdisk*
/usr/sbin/fdisk -d /dev/rdisk0
RAMDISK
```

Stop if `/dev/disk0s1` or `/dev/disk0s2` is mounted at all at this point. Do not
run `fsck`, `fsck_hfs`, a restore, or any other convenience repair. The known
device geometry is 1,982,464 blocks of 4,096 bytes: exactly
**8,120,172,544 bytes**. The `fdisk -d` record must show the two HFS partitions
at start/size `63/76800` and `76923/1905498`; stop if it does not.

The backup belongs in the external iPhone 2G cache, never in the repository.
Use a new absolute path with restrictive permissions and make the geometry
checks part of the recorded evidence:

```sh
set -euo pipefail
umask 077

IPHONE2G_CACHE=/absolute/cache/path/printed/by/doctor
BACKUP_DIR="$IPHONE2G_CACHE/backups/pre-jailbreak-$(date +%Y%m%d-%H%M%S)"
EXPECTED_DISK_BYTES=8120172544

case "$BACKUP_DIR" in
  "$PWD"|"$PWD"/*)
    printf '%s\n' 'refusing to place the device backup in the repository' >&2
    false
    ;;
esac

mkdir -p "$BACKUP_DIR/metadata" "$BACKUP_DIR/raw" "$BACKUP_DIR/config"
chmod 0700 "$BACKUP_DIR" "$BACKUP_DIR/metadata" "$BACKUP_DIR/raw" "$BACKUP_DIR/config"

sshrd '/usr/sbin/fdisk -d /dev/rdisk0' >"$BACKUP_DIR/metadata/fdisk-dump.txt"
LAST_BLOCK_BYTES=$(sshrd '/bin/dd if=/dev/rdisk0 bs=4096 skip=1982463 count=1 2>/dev/null' | wc -c | tr -d ' ')
PAST_END_BYTES=$(sshrd '/bin/dd if=/dev/rdisk0 bs=4096 skip=1982464 count=1 2>/dev/null' | wc -c | tr -d ' ')
[ "$LAST_BLOCK_BYTES" -eq 4096 ]
[ "$PAST_END_BYTES" -eq 0 ]
printf 'block_size=4096\nblock_count=1982464\nbyte_size=%s\n' \
  "$EXPECTED_DISK_BYTES" >"$BACKUP_DIR/metadata/disk-geometry.txt"

sshrd '/bin/dd if=/dev/rdisk0 bs=1048576' \
  2>"$BACKUP_DIR/metadata/rdisk0.dd.stderr" |
  /usr/bin/tee "$BACKUP_DIR/raw/rdisk0.img" |
  /usr/bin/shasum -a 256 >"$BACKUP_DIR/metadata/rdisk0.stream.sha256"

/usr/bin/shasum -a 256 "$BACKUP_DIR/raw/rdisk0.img" \
  >"$BACKUP_DIR/metadata/rdisk0.file.sha256"
/usr/bin/stat -f '%z' "$BACKUP_DIR/raw/rdisk0.img" \
  >"$BACKUP_DIR/metadata/rdisk0.size"

[ "$(/usr/bin/stat -f '%z' "$BACKUP_DIR/raw/rdisk0.img")" -eq "$EXPECTED_DISK_BYTES" ]
STREAM_SHA=$(awk '{print $1}' "$BACKUP_DIR/metadata/rdisk0.stream.sha256")
FILE_SHA=$(awk '{print $1}' "$BACKUP_DIR/metadata/rdisk0.file.sha256")
[ "$STREAM_SHA" = "$FILE_SHA" ]
chmod 0600 "$BACKUP_DIR/raw/rdisk0.img" "$BACKUP_DIR/metadata/"*
```

`set -o pipefail` is essential: a failed remote `dd` must not be hidden by a
successful `tee` or `shasum`. Require the command block to exit zero, the exact
size above, equal stream/file SHA-256 values, `7744+0` complete MiB records in
the saved `dd` stderr, `0700` directories, and `0600` files. A second complete
read with the same size and hash is stronger evidence when preservation risk
justifies the time.

`/dev/rdisk0` is the complete installed filesystem disk, but it does **not**
capture baseband NOR/seczone. Do not describe it as a baseband/unlock backup and
do not perform radio changes on the strength of this image.

#### Read-only configuration and activation backup

Only after the whole-disk backup passes every check, mount both installed
volumes explicitly read-only:

```sh
sshrd_script <<'RAMDISK'
set -e
/bin/mkdir -p /mnt1 /mnt2
/sbin/mount_hfs -o rdonly /dev/disk0s1 /mnt1
/sbin/mount_hfs -o rdonly /dev/disk0s2 /mnt2
/sbin/mount
RAMDISK
```

Read the printed mount table and stop unless both mounts are visibly read-only.
Then archive the stock policy, Lockdown service map, and activation material:

```sh
sshrd '/bin/tar -cpf - -C /mnt1 private/etc/fstab System/Library/Lockdown/Services.plist' \
  >"$BACKUP_DIR/config/prebootstrap-root-config.tar"

sshrd '/bin/tar -cpf - -C /mnt2 root/Library/Lockdown' \
  >"$BACKUP_DIR/config/activation-lockdown.tar"

/usr/bin/tar -tf "$BACKUP_DIR/config/prebootstrap-root-config.tar"
/usr/bin/tar -tf "$BACKUP_DIR/config/activation-lockdown.tar"
chmod 0600 "$BACKUP_DIR/config/"*.tar
```

These are read-only preservation copies; do not edit or restore activation,
Lockdown services, AFC configuration, or `fstab` during this workflow. This
ramdisk has no `umount` binary. Leave `/mnt1` and `/mnt2` mounted read-only;
installation updates those existing mounts temporarily and must return them to
read-only before reboot.

Before installation, enumerate every bootstrap target below while the mounts
are still read-only. If any target exists, stop and make a path-specific
read-only archive of it. Never silently overlay an earlier SSH installation.

### Archived 1.1.4 key-only SSH bootstrap preparation

Run locally, with no device required:

```sh
bun iphone2g prepare-bootstrap
```

This command verifies the two package hashes, extracts only three historical
files, builds `/usr/libexec/pocketjs-device` against the verified 1.1.4
sysroot, generates/reuses matching 2048-bit RSA host/client keypairs, writes a
key-only policy, and emits a receipt. The default outputs are:

```text
~/.cache/pocket-nexus/iphone2g/bootstrap/stage/
~/.cache/pocket-nexus/iphone2g/bootstrap/ssh_config
~/.cache/pocket-nexus/iphone2g/bootstrap/known_hosts
~/.cache/pocket-nexus/iphone2g/bootstrap/keys/ssh_host_rsa_key
~/.ssh/iphone2g_pocketjs
```

The stage contains exactly eight device files, not eight historical package
files:

| Volume | Device path                                       | Source                                    | Mode   | Verification                                                       |
| ------ | ------------------------------------------------- | ----------------------------------------- | ------ | ------------------------------------------------------------------ |
| root   | `/usr/sbin/sshd`                                  | OpenSSH package                           | `0755` | `eeed899b324e3b41bf1d3e344c0d04cd66b80c28d083eeb0a8cb4b46dfc9ee65` |
| root   | `/usr/libexec/pocketjs-device`                    | Built from `hosts/iphone2g/device_tool.c` | `0755` | Recorded in receipt                                                |
| root   | `/usr/lib/libcrypto.0.9.8.dylib`                  | OpenSSL package                           | `0555` | `931efb9afc2d24f635a76ae82878e3c09eb5aa03860370fc380c3de2b8fdf2ee` |
| root   | `/private/etc/ssh/moduli`                         | OpenSSH package                           | `0644` | `51faf2d997593725ff18ac57c2ca6ce91400673106f71fce5d995d29b633b180` |
| root   | `/private/etc/ssh/sshd_config`                    | Generated policy                          | `0644` | Recorded in receipt                                                |
| root   | `/private/etc/ssh/ssh_host_rsa_key`               | Generated host key                        | `0600` | Recorded in receipt                                                |
| root   | `/Library/LaunchDaemons/com.openssh.sshd.plist`   | Generated launch policy                   | `0644` | Recorded in receipt                                                |
| data   | `/private/var/root/.ssh/authorized_keys_pocketjs` | Dedicated client public key               | `0600` | Recorded in receipt                                                |

`/private/var/root/.ssh` itself is a directory, mode `0700`, and is not counted
as a ninth file. All installed files and this directory must be owned by
`root:wheel` (`0:0`). The generated `bootstrap-receipt.json` is host-side audit
metadata and is not installed.

The policy has `PasswordAuthentication no`, `ChallengeResponseAuthentication
no`, `PermitEmptyPasswords no`, and a dedicated
`AuthorizedKeysFile .ssh/authorized_keys_pocketjs`. It deliberately leaves the
historical root password untouched. It records `afc2: false`,
`fstabMutation: false`, and `basebandMutation: false` in the receipt. The
generated client config uses a dedicated `known_hosts` file with strict host-key
checking; it does not modify the global SSH configuration.

The LaunchDaemon executes `/usr/sbin/sshd -i` directly and binds its listener to
the phone's `127.0.0.1` only. Normal access therefore requires the local usbmux
forward; port 22 is not exposed on Wi-Fi. The historical package's
`sshd-keygen-wrapper` and `ssh-keygen` are omitted because the RSA host key is
pre-generated. The historical file-transfer subsystem is also deliberately
omitted because its binary imports an API absent from the 1.1.4 runtime.
Deployment uses the small, path-scoped `pocketjs-device` protocol instead of a
general shell utility set, SCP, or AFC2.

### Archived 1.1.4 SSH bootstrap installation design

No `bun iphone2g install` command exists. The following operator-reviewed
ramdisk procedure is retained only to document the abandoned 1.1.4 design. Do
not perform it on the restored 3.1.3 installation. In the historical design,
the raw and read-only backups above had to exist and pass verification first.

Keep the existing `/mnt1` and `/mnt2` read-only mounts. First fail closed if any
of the eight target files or either newly owned directory already exists;
archive an existing target before proceeding rather than replacing it. Before
the first read/write update, explicitly update both mounts to read-only again
and machine-check their mount-table lines:

```sh
sshrd_script <<'RAMDISK'
set -e

mount_is_read_only() {
  target="$1"
  while IFS= read -r line; do
    case "$line" in
      *" on $target "*"read-only"*) return 0 ;;
    esac
  done < <(/sbin/mount)
  return 1
}

found=0
for path in \
  /mnt1/private/etc/ssh \
  /mnt1/usr/sbin/sshd \
  /mnt1/usr/libexec/pocketjs-device \
  /mnt1/usr/lib/libcrypto.0.9.8.dylib \
  /mnt1/private/etc/ssh/moduli \
  /mnt1/private/etc/ssh/sshd_config \
  /mnt1/private/etc/ssh/ssh_host_rsa_key \
  /mnt1/Library/LaunchDaemons/com.openssh.sshd.plist \
  /mnt2/root/.ssh \
  /mnt2/root/.ssh/authorized_keys_pocketjs
do
  if [ -e "$path" ]; then
    /bin/ls -ldn "$path"
    found=1
  fi
done
[ "$found" -eq 0 ]
/sbin/mount -ur /mnt1
/sbin/mount -ur /mnt2
mount_is_read_only /mnt1
mount_is_read_only /mnt2
/sbin/mount
RAMDISK
```

Stop unless both printed mount entries remain read-only and the root volume has
at least 8 MiB free. Never invoke `mount_hfs` a second time on an already mounted
volume and never invoke `fsck_hfs`.

Create both local archives before sending either one. Disable macOS copyfile and
extended-attribute records, force the `ustar` format, require exactly seven root
entries plus one data entry, and compare every archived byte with the verified
stage:

```sh
# Use the exact cache path printed by `bun iphone2g doctor`; this also respects
# POCKET_NEXUS_CACHE_DIR and all supported overrides.
IPHONE2G_CACHE=/absolute/path/printed/by/doctor
BOOTSTRAP_STAGE="$IPHONE2G_CACHE/bootstrap/stage"
set -euo pipefail
umask 077

ROOT_ARCHIVE="$BACKUP_DIR/bootstrap-root.ustar"
DATA_ARCHIVE="$BACKUP_DIR/bootstrap-data.ustar"
ROOT_EXPECTED="$BACKUP_DIR/bootstrap-root.expected"
DATA_EXPECTED="$BACKUP_DIR/bootstrap-data.expected"
ROOT_ACTUAL="$BACKUP_DIR/bootstrap-root.actual"
DATA_ACTUAL="$BACKUP_DIR/bootstrap-data.actual"

for path in \
  "$ROOT_ARCHIVE" "$DATA_ARCHIVE" \
  "$ROOT_EXPECTED" "$DATA_EXPECTED" \
  "$ROOT_ACTUAL" "$DATA_ACTUAL"
do
  if [ -e "$path" ]; then
    printf 'refusing to overwrite %s\n' "$path" >&2
    exit 1
  fi
done

COPYFILE_DISABLE=1 /usr/bin/tar \
  --format ustar --no-xattrs --uid 0 --gid 0 \
  -C "$BOOTSTRAP_STAGE/root" -cpf "$ROOT_ARCHIVE" \
  usr/sbin/sshd \
  usr/libexec/pocketjs-device \
  usr/lib/libcrypto.0.9.8.dylib \
  private/etc/ssh/moduli \
  private/etc/ssh/sshd_config \
  private/etc/ssh/ssh_host_rsa_key \
  Library/LaunchDaemons/com.openssh.sshd.plist

COPYFILE_DISABLE=1 /usr/bin/tar \
  --format ustar --no-xattrs --uid 0 --gid 0 \
  -C "$BOOTSTRAP_STAGE/data" -cpf "$DATA_ARCHIVE" \
  root/.ssh/authorized_keys_pocketjs

printf '%s\n' \
  usr/sbin/sshd \
  usr/libexec/pocketjs-device \
  usr/lib/libcrypto.0.9.8.dylib \
  private/etc/ssh/moduli \
  private/etc/ssh/sshd_config \
  private/etc/ssh/ssh_host_rsa_key \
  Library/LaunchDaemons/com.openssh.sshd.plist \
  >"$ROOT_EXPECTED"
printf '%s\n' root/.ssh/authorized_keys_pocketjs >"$DATA_EXPECTED"

COPYFILE_DISABLE=1 /usr/bin/tar -tf "$ROOT_ARCHIVE" >"$ROOT_ACTUAL"
COPYFILE_DISABLE=1 /usr/bin/tar -tf "$DATA_ARCHIVE" >"$DATA_ACTUAL"
if ! /usr/bin/cmp -s "$ROOT_EXPECTED" "$ROOT_ACTUAL"; then
  printf '%s\n' 'root archive does not contain exactly seven expected entries' >&2
  exit 1
fi
if ! /usr/bin/cmp -s "$DATA_EXPECTED" "$DATA_ACTUAL"; then
  printf '%s\n' 'data archive does not contain exactly one expected entry' >&2
  exit 1
fi

verify_archive_bytes() {
  archive="$1"
  source_root="$2"
  shift 2
  for entry in "$@"; do
    if ! COPYFILE_DISABLE=1 /usr/bin/tar --no-xattrs -xOf "$archive" "$entry" |
      /usr/bin/cmp -s - "$source_root/$entry"
    then
      printf 'archive byte mismatch: %s\n' "$entry" >&2
      exit 1
    fi
  done
}

verify_archive_bytes "$ROOT_ARCHIVE" "$BOOTSTRAP_STAGE/root" \
  usr/sbin/sshd \
  usr/libexec/pocketjs-device \
  usr/lib/libcrypto.0.9.8.dylib \
  private/etc/ssh/moduli \
  private/etc/ssh/sshd_config \
  private/etc/ssh/ssh_host_rsa_key \
  Library/LaunchDaemons/com.openssh.sshd.plist
verify_archive_bytes "$DATA_ARCHIVE" "$BOOTSTRAP_STAGE/data" \
  root/.ssh/authorized_keys_pocketjs
chmod 0600 \
  "$ROOT_ARCHIVE" "$DATA_ARCHIVE" \
  "$ROOT_EXPECTED" "$DATA_EXPECTED" \
  "$ROOT_ACTUAL" "$DATA_ACTUAL"
```

Install one volume at a time through a volatile ramdisk script. Its cleanup
ignores subsequent signals, returns the target to read-only, and machine-checks
the exact target mount line before it can report success. It uses plain `mkdir`
for the two paths proven absent above; an unexpected pre-existing directory is
therefore a hard failure:

```sh

sshrd '/bin/dd of=/var/root/pocketjs-install-volume.sh' <<'RAMDISK'
#!/bin/bash
set -e

mount_is_read_only() {
  target="$1"
  while IFS= read -r line; do
    case "$line" in
      *" on $target "*"read-only"*) return 0 ;;
    esac
  done < <(/sbin/mount)
  return 1
}

case "$1" in
  root) mountpoint=/mnt1 ;;
  data) mountpoint=/mnt2 ;;
  *) exit 64 ;;
esac

cleanup() {
  result=$?
  trap '' HUP INT PIPE TERM
  trap - EXIT
  if ! /sbin/mount -ur "$mountpoint"; then
    result=90
  fi
  if ! mount_is_read_only "$mountpoint"; then
    result=91
  fi
  if ! /sbin/mount; then
    result=92
  fi
  exit "$result"
}
trap 'exit 93' HUP INT PIPE TERM
trap cleanup EXIT

mount_is_read_only "$mountpoint"
/sbin/mount -uw "$mountpoint"
if [ "$1" = root ]; then
  /bin/mkdir /mnt1/private/etc/ssh
  /bin/chown 0:0 /mnt1/private/etc/ssh
  /bin/chmod 0755 /mnt1/private/etc/ssh
else
  /bin/mkdir /mnt2/root/.ssh
  /bin/chown 0:0 /mnt2/root/.ssh
  /bin/chmod 0700 /mnt2/root/.ssh
fi
/bin/tar -xpf - -C "$mountpoint"

if [ "$1" = root ]; then
  /bin/chown 0:0 \
    /mnt1/usr/sbin/sshd \
    /mnt1/usr/libexec/pocketjs-device \
    /mnt1/usr/lib/libcrypto.0.9.8.dylib \
    /mnt1/private/etc/ssh/moduli \
    /mnt1/private/etc/ssh/sshd_config \
    /mnt1/private/etc/ssh/ssh_host_rsa_key \
    /mnt1/Library/LaunchDaemons/com.openssh.sshd.plist
  /bin/chmod 0755 /mnt1/usr/sbin/sshd /mnt1/usr/libexec/pocketjs-device
  /bin/chmod 0555 /mnt1/usr/lib/libcrypto.0.9.8.dylib
  /bin/chmod 0644 \
    /mnt1/private/etc/ssh/moduli \
    /mnt1/private/etc/ssh/sshd_config \
    /mnt1/Library/LaunchDaemons/com.openssh.sshd.plist
  /bin/chmod 0600 /mnt1/private/etc/ssh/ssh_host_rsa_key
else
  /bin/chown 0:0 /mnt2/root/.ssh /mnt2/root/.ssh/authorized_keys_pocketjs
  /bin/chmod 0700 /mnt2/root/.ssh
  /bin/chmod 0600 /mnt2/root/.ssh/authorized_keys_pocketjs
fi
RAMDISK

sshrd '/bin/chmod 0700 /var/root/pocketjs-install-volume.sh'

if ! sshrd '/var/root/pocketjs-install-volume.sh root' <"$ROOT_ARCHIVE"; then
  printf '%s\n' 'root bootstrap install failed or root was not proven read-only' >&2
  exit 1
fi

# The root installer can return success only after its read-only machine check.
# Do not start the data-volume update before that success.
if ! sshrd '/var/root/pocketjs-install-volume.sh data' <"$DATA_ARCHIVE"; then
  printf '%s\n' 'data bootstrap install failed or data was not proven read-only' >&2
  exit 1
fi
```

Both installer invocations must exit zero, and each printed mount table must
show its target read-only. With both volumes read-only, archive and compare all
eight installed files byte-for-byte against the verified stage. If either
installer fails, do not blindly rerun it over the partial bootstrap; first prove
both mounts read-only and reconcile only the eight listed paths against the
receipt and pre-install inventory.

```sh
set -euo pipefail
umask 077

READBACK="$BACKUP_DIR/bootstrap-readback"
if [ -e "$READBACK" ]; then
  printf 'refusing to reuse readback directory: %s\n' "$READBACK" >&2
  exit 1
fi
mkdir "$READBACK"
mkdir "$READBACK/root"
mkdir "$READBACK/data"
chmod 0700 "$READBACK" "$READBACK/root" "$READBACK/data"

if ! sshrd '/bin/tar -cpf - -C /mnt1 usr/sbin/sshd usr/libexec/pocketjs-device usr/lib/libcrypto.0.9.8.dylib private/etc/ssh/moduli private/etc/ssh/sshd_config private/etc/ssh/ssh_host_rsa_key Library/LaunchDaemons/com.openssh.sshd.plist' |
  COPYFILE_DISABLE=1 /usr/bin/tar --no-xattrs -xpf - -C "$READBACK/root"
then
  printf '%s\n' 'root readback pipeline failed' >&2
  exit 1
fi
if ! sshrd '/bin/tar -cpf - -C /mnt2 root/.ssh/authorized_keys_pocketjs' |
  COPYFILE_DISABLE=1 /usr/bin/tar --no-xattrs -xpf - -C "$READBACK/data"
then
  printf '%s\n' 'data readback pipeline failed' >&2
  exit 1
fi

for relative in \
  root/usr/sbin/sshd \
  root/usr/libexec/pocketjs-device \
  root/usr/lib/libcrypto.0.9.8.dylib \
  root/private/etc/ssh/moduli \
  root/private/etc/ssh/sshd_config \
  root/private/etc/ssh/ssh_host_rsa_key \
  root/Library/LaunchDaemons/com.openssh.sshd.plist \
  data/root/.ssh/authorized_keys_pocketjs
do
  if ! /usr/bin/cmp -s "$BOOTSTRAP_STAGE/$relative" "$READBACK/$relative"; then
    printf 'installed byte mismatch: %s\n' "$relative" >&2
    exit 1
  fi
done

sshrd_script <<'RAMDISK'
set -e

mount_is_read_only() {
  target="$1"
  while IFS= read -r line; do
    case "$line" in
      *" on $target "*"read-only"*) return 0 ;;
    esac
  done < <(/sbin/mount)
  return 1
}

/sbin/mount -ur /mnt1
/sbin/mount -ur /mnt2
mount_is_read_only /mnt1
mount_is_read_only /mnt2
/sbin/mount
/bin/ls -ldn \
  /mnt1/private/etc/ssh \
  /mnt1/usr/sbin/sshd \
  /mnt1/usr/libexec/pocketjs-device \
  /mnt1/usr/lib/libcrypto.0.9.8.dylib \
  /mnt1/private/etc/ssh/moduli \
  /mnt1/private/etc/ssh/sshd_config \
  /mnt1/private/etc/ssh/ssh_host_rsa_key \
  /mnt1/Library/LaunchDaemons/com.openssh.sshd.plist \
  /mnt2/root/.ssh \
  /mnt2/root/.ssh/authorized_keys_pocketjs
RAMDISK
```

Require both mounts to be read-only, every `cmp` to pass, and the displayed
modes/owners to match the table and `bootstrap-receipt.json`, including
`0:0/0755` for `/private/etc/ssh` and `0:0/0700` for
`/private/var/root/.ssh`. The ramdisk cannot unmount these volumes; the verified
read-only remount is the safe boundary.

Do not execute `pocketjs-device`, `PocketJSDemo`, the installed historical
`sshd`, or stock 1.1.4 launch tools inside this pinned SSH ramdisk. Its own
`/bin/bash` carries `LC_CODE_SIGNATURE`, while those stock/bootstrap binaries do
not; the ramdisk can therefore terminate the new helper with `SIGKILL`. Ramdisk
acceptance is deliberately limited to byte-for-byte readback, modes, ownership,
and read-only mount state. A ramdisk-side `SIGKILL` is not evidence that the
helper fails on the target OS. Run the helper version check only after the phone
has booted normally into iPhone OS 1.1.4.

Only then choose the Kit's `Reboot Device` action. Do not run ZiPhone or a Kit
install action if normal-boot SSH does not start; return to the pinned ramdisk
and inspect only the eight scoped files.

### Archived 1.1.4 USB SSH and deployment design

The abandoned 1.1.4 design would have forwarded port 22 over usbmux after a
normal 1.1.4 boot:

```sh
"$IPHONE2G_KIT/bin/macos/arm64/iproxy" 2222 22 -s 127.0.0.1
```

In another terminal, use only the generated per-device configuration. This is
the first point at which executing the installed helper is a valid test:

```sh
SSH_CONFIG="$IPHONE2G_CACHE/bootstrap/ssh_config"
ssh -F "$SSH_CONFIG" iphone2g-pocketjs /sbin/mount
ssh -F "$SSH_CONFIG" iphone2g-pocketjs /usr/libexec/pocketjs-device version
```

The generated config already pins the prepared RSA host key in its dedicated
`known_hosts`; there is no interactive trust-on-first-use step. The normal-boot
root mount must be read-only and the helper must report version 3. Do
not put these legacy RSA/KEX/MAC relaxations in the global SSH configuration.
Password authentication must remain disabled.

The stock 1.1.4 root filesystem does not provide the usual `cp`, `mv`, `rm`,
`chmod`, `chown`, `mkdir`, `sync`, `tar`, or `scp` utilities. Use the repository
deployment command, which speaks only the fixed helper protocol:

```sh
bun iphone2g deploy
```

`deploy` first rebuilds the complete app and obtains the per-build identifier
from `build-receipt.json`. Before writing, it verifies that the installed helper
is byte-identical to the local bootstrap receipt and reports version 3, stops
the old application, and clears the previous runtime status. It sends exactly
`PocketJSDemo`, `Info.plist`, `PkgInfo`, `Icon.png`, and `build-receipt.json`.
On the phone, `pocketjs-device`:

1. acquires a durable build-identifier lock on the writable data volume before
   any root-volume update, then remounts `/` read/write and creates only
   `/Applications/.PocketJSDemo.app.pocketjs-stage`;
2. refuses to replace an existing app containing anything outside the same
   five-file allowlist;
3. moves a known previous bundle to a scoped backup and atomically renames the
   complete stage into `/Applications/PocketJSDemo.app`;
4. returns `/` to read-only on every exit path.

After install, the host reads every one of the five app files back through the
helper and compares its SHA-256 with the local byte stream. Only after that and
a positive read-only proof does the host commit the same transaction. Any
failure before commit invokes identifier-matched rollback and restores the old
bundle when one existed. The committed backup remains available until the next
deployment, which clears it only while preparing a new transaction. A final
read-only proof precedes the SpringBoard rescan. All of those checks must pass
for `deploy` to exit zero. If read-only state cannot be proven, stop and reboot;
do not issue an ad hoc transfer or mount sequence.

### Archived 1.1.4 rollback design

This path-scoped rollback was designed for the abandoned 1.1.4 bootstrap. Do
not use it on the current Cydia/3.1.3 installation. A whole-disk rewrite is
emergency recovery, not a normal uninstall path, and the raw disk image does
not restore baseband state.

#### Remove a deployed demo

Boot normally with the usbmux forward active and use only the scoped helper:

```sh
ssh -F "$SSH_CONFIG" iphone2g-pocketjs /usr/libexec/pocketjs-device remove
ssh -F "$SSH_CONFIG" iphone2g-pocketjs /usr/libexec/pocketjs-device root-state
ssh -F "$SSH_CONFIG" iphone2g-pocketjs /sbin/mount
```

The helper refuses an unfinished transaction or any unknown app entry, removes
only the allowlisted current/stage/backup bundle trees, clears the runtime
record, and returns root to read-only. Require all three commands to pass before
restarting SpringBoard or rebooting.

#### Remove the SSH bootstrap

Boot the pinned, byte-verified temporary ramdisk again, confirm the device
identity and backup availability, and mount both installed volumes read-only as
above. Remove only files proven absent before bootstrap. This fail-closed block
updates the existing mounts and always attempts to return both to read-only:

```sh
sshrd_script <<'RAMDISK'
set -e

cleanup() {
  result=$?
  trap - EXIT HUP INT TERM
  if ! /sbin/mount -ur /mnt2; then result=90; fi
  if ! /sbin/mount -ur /mnt1; then result=90; fi
  /sbin/mount
  exit "$result"
}
trap 'exit 91' HUP INT TERM
trap cleanup EXIT

/sbin/mount -uw /mnt1
/sbin/mount -uw /mnt2
/bin/rm -f \
  /mnt1/usr/sbin/sshd \
  /mnt1/usr/libexec/pocketjs-device \
  /mnt1/usr/lib/libcrypto.0.9.8.dylib \
  /mnt1/private/etc/ssh/moduli \
  /mnt1/private/etc/ssh/sshd_config \
  /mnt1/private/etc/ssh/ssh_host_rsa_key \
  /mnt1/Library/LaunchDaemons/com.openssh.sshd.plist \
  /mnt2/root/.ssh/authorized_keys_pocketjs
RAMDISK
```

If any target predated this work, restore its path-specific archive instead of
deleting it. Remove newly created `.ssh` or `private/etc/ssh` directories only
if they are empty, and never remove an existing shared directory recursively.
Require the final mount table to show both volumes read-only, then reboot
normally and confirm that USB port 22 no longer accepts the bootstrap identity
while activation, AFC services, baseband state, and stock filesystem policy
remain unchanged.

## Acceptance layers

Keep evidence for each layer separate. Passing an earlier layer is not evidence
for a later one.

### 1. Recovery and transport acceptance — passed

- CustomHJ IPSW SHA-1 equals
  `8140ed162c6712a6e8d1608d3a36257998253d82`.
- The erase restore reports `Status: Restore Finished`.
- The phone performs a normal, non-ramdisk boot and enumerates as USB `0x1290`.
- `ideviceinfo` reports `3.1.3`, `7E18`, and `FactoryActivated`.
- SpringBoard and Cydia launch.
- The installed `sshd` accepts a command over the USB transport.

These checks prove a usable restored system and shell transport. They do not
prove the PocketJS helper, app transaction, or runtime.

### 2. Linker ABI acceptance — passed locally

- `bun iphone2g doctor` reports all required inputs `[ok]`.
- `bun iphone2g build` exits zero.
- `file` reports `Mach-O executable arm_v6`.
- `otool-classic -L` and the build receipt match the pinned 1.1.4 linker ABI
  contract.
- The receipt identifies both embedded guest inputs and the combined native
  runtime executable.

This proves that the 1.1.4-ABI artifact links. It is not yet evidence that the
retargeted, signed bundle executes correctly in the restored 3.1.3 userspace.

### 3. 3.1.3 package and deployment acceptance — passed

On the attached restored phone, the current commands produced the following
live receipt:

- `bun iphone2g install-bootstrap` accepted the exact `iPhone1,1`, 3.1.3,
  `7E18` identity with read/write root and data mounts.
- The signed version-4 helper and dedicated key passed their device readback
  checks. A separate password-only SSH attempt was rejected.
- Hashes of the existing CustomHJ `sshd`, RSA host key, and launchd plist were
  identical before and after bootstrap installation.
- A second `install-bootstrap` run reported that the key-only bootstrap already
  matched and made no device changes.
- `bun iphone2g deploy` installed only the five allowlisted
  `PocketJSDemo.app` files, read every file back byte-for-byte, and committed
  the identifier-matched transaction. An independent readback matched all five
  local files and `transaction-state` returned `state=none`.
- The helper and independent mount checks still reported read/write root and
  data volumes after installation and commit. The application cache was
  refreshed as `mobile`, SpringBoard restarted, and the PocketJS app, Cydia,
  and `sshd` remained present.
- After the cold restart described below, `install-bootstrap` again reported
  an exact match without changing the device. Key-only SSH worked, a separate
  password-only attempt was rejected, and the original CustomHJ `sshd`, RSA
  host key, and launchd plist hashes still matched their pre-bootstrap values.

This proves signing, bootstrap policy, byte-exact installation, transactional
commit completion, and mount-policy preservation. SpringBoard icon rendering,
Hero drawing, and physical touch are layer 4 evidence.

### 4. Historical PocketJS Hero runtime receipt

- The iPhone app now mounts the shared PocketJS Hero at 320 by 480, adapts its
  action copy for touch, and reports the 60 Hz presentation rate.
- Its dedicated 59-by-60 RGBA SpringBoard icon keeps the black-backed metal
  mark but pre-bakes a bright chrome bevel, curved glass highlight, inner
  shading, and transparent rounded corners in the original iPhone idiom. It
  does not reuse the Hero demo player logo.
- After the final deploy and SpringBoard launch, the current-build runtime
  record was validated with:

  ```sh
  bun iphone2g device-status
  ```

  ```text
  schema=1
  build_id=ba1c0b15af4fdb72c6a98334332a8954
  state=running
  guest_frames=118
  touch_sequences=11
  touch_down=0
  last_touch_x=71
  last_touch_y=409
  last_touch_hit=46
  error=
  ```

  This schema-1 record predates the hardened acceptance protocol. It confirms
  that the previous guest produced frames and received a touch bounds hit, but
  **the current `device-status` command does not accept it** because it has no
  PID, timestamp, heartbeat, completed-release counter, or application action.
  A current receipt must report schema 2 and a `hero_tap` action after release.

- A device-side `/sbin/reboot` stopped services but remained on its shutdown
  spinner. Holding Home + Power completed the restart; this is a successful
  forced-restart recovery receipt, not evidence that unattended `/sbin/reboot`
  works on this installation.
- After that restart, the phone re-enumerated in normal USB mode and again
  reported `iPhone1,1`, 3.1.3, `7E18`, and `FactoryActivated`. Key-only SSH,
  helper version 4, and read/write root/data mounts all survived.
- The final deployment transaction found the complete pre-restart build
  `b9c69d6f30e24e0f24f05817ad3ec6c4` in the app location and moved its receipt
  into the transaction backup before installing the current build. This
  proves bundle persistence across the forced restart; it does not turn the
  stalled `/sbin/reboot` into a clean-reboot result.

A dated photo or video remains useful supplemental evidence. It is not a
replacement for a fresh, build-matched schema-2 status receipt.

**The changed Solid count after a completed release is the application-level
runtime proof.** The native host must load and execute the embedded guest,
render its PocketJS tree, deliver physical touch through the PocketJS input
path, and receive `hero_tap` from the reactive count effect. Build, upload, or
a bounds hit alone does not meet that criterion.

## Primary references

- [Pinned PocketJS toolchain manifest](../tools/cli/iphone2g-toolchain.json)
- [PocketJS iPhone 2G host notes](../hosts/iphone2g/README.md)
- [Legacy-iOS-Kit](https://github.com/LukeZGD/Legacy-iOS-Kit)
- [Legacy-iOS-Kit SSH ramdisk notes](https://github.com/LukeZGD/Legacy-iOS-Kit/wiki/SSH-Ramdisk)
- [Apple open-source Csu](https://github.com/apple-oss-distributions/Csu)
- [Saurik's historical toolchain notes](https://www.saurik.com/toolchain.html)
- [Saurik's historical Telesphoreo notes](https://www.saurik.com/telesphoreo.html)
