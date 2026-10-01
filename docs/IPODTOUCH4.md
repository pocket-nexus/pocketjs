# iPod touch 4

The private iPod touch 4 target runs PocketJS on an exact `iPod4,1` device
with iOS 6.1.6 build `10B500`. **The application owns a 320×480-point surface
backed by the device's 640×960 Retina display, rendered through the required
OpenGL ES 1.1 path of the shared legacy UIKit runtime.** The target id is
`ipodtouch4-dev`; it shares host ABI 8 with `iphone4s-dev` because the guest
protocol — the op table, the frame entry, the embedded `__pocket_js` /
`__pocket_pak` sections — is the same runtime compiled for the same
architecture. The target remains outside the public `POCKET_TARGETS` registry.

The target builds two applications from this repository, selected with
`POCKETJS_IPODTOUCH4_APP`:

| App | Id | Guest | Acceptance action |
|---|---|---|---|
| Pocket Clear | `clear` (default) | `apps/clear`, Vue Vapor, gestures only | `clear_gesture` |
| Pocket Nexus | `nexus-touch` | `apps/nexus-touch`, Solid, `ui.physics` | `nexus_play` |

Each app has its own bundle identifier, executable, bundle name and URL
scheme, so both install side by side.

Clear also supports **companion-backed Chinese pinyin composition** through
`io.offload`. The device owns the editor and a bounded input transcript; a
POSIX worker transfers requests to the Mac, where Rime and a CJK font produce
candidates and coverage tiles. See [Clear IME setup and device validation](CLEAR_IME.md).

## Multi-contact touch

This target is the reason the legacy UIKit runtime tracks a touch slot table
instead of one contact. **`hosts/ios-legacy/runtime.c` keeps eight slots — the
guest wire cap — with the slot index as the wire contact id, release-latched
delivery (a sub-frame tap is still delivered for at least one guest frame),
and a bounds hit fact resolved once at each contact's down edge.** The frame
entry is `pocket_runtime_frame_contacts`, which packs every contact into the
`frame()` wire words: `x:9 | y:9 | id:8` below 512 logical pixels, the bit-31
wide form above. A single id-0 contact produces the same bytes as the old
single-touch entry points, so existing tapes and hosts decode unchanged. The
1.x GSEvent fallback has no per-finger identity and owns slot 0 alone.

## Frame rate

**The display link fires at 60 Hz, the rate of the guest clock (`__simHz`),
and `hosts/ipodtouch4/runtime.c` advances the core one tick per callback.**
Animations, baked keyframes and physics therefore run at the durations the
guest authored, in step with its `after()` timers. The shared legacy runtime
keeps its default of two ticks per callback for the original iPhone, which
presents at 30 Hz. Before this rate was set in the iPod wrapper, core motion
on this target ran at twice its authored speed.

## Pocket Nexus and 2D bodies

`apps/nexus-touch` is the pocket.nexus homepage as a standalone app: the
spill, the toys, and letters that hop, talk, and go back to the pocket's
mouth. It shares its bodies, toys and bake with the 3DS scene in
`apps/nexus` (`homepage.ts`, `toys.ts`, `bake.ts`).

**The profile advertises `ui.physics`. For an app whose plan resolves it,
the build compiles `engine/quickjs-c/pocket_runtime.c` with
`POCKET_PHYSICS`, which binds ops 52..56 to the `ui_physics_*` exports of
the UI C ABI (`engine/ui-cabi`).** Other apps, and the other hosts that
compile the same runtime (iPhone 2G, iPhone 4S, Meizu M8, BlackBerry
Classic, Android), keep their op tables byte-identical. The host ABI stays 8:
the family is optional behind its capability, as `io.offload` is, and the
guest is embedded in the same binary as the host.

Measured on the device (`iPod4,1`, iOS 6.1.6) with the status record's window
counters: 60 fps at rest with 1.4 ms of guest and core time per frame, and 57
to 61 fps with 3.5 to 4.3 ms under a sustained load of a pop every 0.3 s, 14
live toys, bursts, waves and swallowed letters.

The app descriptor names an icon (`site/nexus/public/apple-touch-icon.png`)
and a launch image (`apps/nexus-touch/launch.png`, the app's first frame),
which replaces the generated `Default@2x.png`.

```sh
bun apps/nexus-touch/gen-art.ts                       # re-bake the art from the homepage
POCKETJS_IPODTOUCH4_APP=nexus-touch bun ipodtouch4 build
POCKETJS_IPODTOUCH4_APP=nexus-touch bun ipodtouch4 deploy
POCKETJS_IPODTOUCH4_APP=nexus-touch bun ipodtouch4 launch
```

## Device state

The device must be jailbroken before the PocketJS tool connects (p0sixspwn on
iOS 6.1.6 is untethered). The completed bootstrap provides:

- Cydia and a read/write root filesystem;
- OpenSSH on device port 22;
- a dedicated RSA client key and pinned device host key;
- `PasswordAuthentication no` after public-key login succeeds;
- `ldid`, `uicache`, and `uiopen` for application deployment;
- **AppSync Unified and its Cydia Substrate dependencies** for local self-signed
  User applications. Install the `iphoneos-arm` package from the
  [upstream release](https://github.com/akemin-dayo/AppSync/releases), then
  reboot once to activate it. `doctor` checks the installed package. The
  deployment command reports an installation failure if the signing support
  is inactive; it does not fall back to a System application.

The default local files are:

```text
~/.cache/pocket-nexus/ipodtouch4/ssh/id_rsa
~/.cache/pocket-nexus/ipodtouch4/ssh/known_hosts
```

`POCKETJS_IPODTOUCH4_KEY`, `POCKETJS_IPODTOUCH4_KNOWN_HOSTS`, and
`POCKETJS_IPODTOUCH4_UDID` override those paths and the selected USB device.

## Build inputs

**The toolchain is the iPhone 4S one, byte for byte: the validated iOS 6.1.3
ARMv7 sysroot, Apple's pinned Csu bootstrap, the pinned QuickJS sources, and
the pinned dyld extractor.** The sysroot supplies link-time TAPI stubs and
Mach-O images extracted from the 6.1.3 shared cache; iOS 6.1.6 is the 6.1.3
SDK surface plus a TLS fix, so every linked install name resolves identically
on the device. `bun ipodtouch4 setup-sources` and `bun ipodtouch4
prepare-sysroot` delegate to the iPhone 4S commands so the provenance stays
pinned exactly once.

```sh
bun ipodtouch4 setup-sources
bun ipodtouch4 prepare-sysroot   # needs POCKETJS_IPHONE4S_IPSW on a fresh machine
bun ipodtouch4 doctor
```

## Build and deploy

```sh
bun ipodtouch4 build
bun ipodtouch4 deploy
bun ipodtouch4 launch
bun ipodtouch4 status [--require-action]
bun ipodtouch4 capture
bun ipodtouch4 uninstall         # removes the app and its data
```

`build` resolves the selected app's manifest (`apps/clear/pocket.json` by
default) against the `ipodtouch4-dev` profile, produces the guest bundle and pak, compiles the shared legacy
runtime for `armv7-apple-ios6.0`, and links a `-no_pie` Mach-O with the app
embedded as `__pocket_js` / `__pocket_pak` sections. The build id hashes the
plan, the guest artifacts, every native object, the sysroot stubs, and the
baked artwork.

**`build` also produces the app's IPA, `dist/ipodtouch4/PocketJSiPodTouch4.ipa`
for Clear and `dist/ipodtouch4/PocketNexus.ipa` for Nexus.** `deploy`
transfers that IPA over the pinned USB SSH tunnel and calls iOS 6
`MobileInstallationInstall` with `ApplicationType=User`. **iOS creates the
UUID container under `/var/mobile/Applications`, owns updates, and preserves
`Documents` and `Library` on update.** Every installed bundle file, including
the build receipt, must match its local SHA-256. A kernel file lock serializes
installation and CLI removal; process exit releases the lock.

The first deployment migrates the former `/Applications/PocketJSiPodTouch4.app`
installation. It checks the bundle identifier, retains the old bundle in a
root-owned migration journal, and refreshes its System registration before
installing the User app. The migration restarts `installd` to reload its
in-memory System map; SpringBoard is not restarted. A failed installation restores the old bundle; the
next deployment reconciles an interrupted migration. The journal is removed
after User registration and installed byte verification pass. The app's old
bundle-specific preferences are copied into its new container when present;
other files in the shared mobile home are not treated as app-owned data.

**Long-pressing the User app on SpringBoard exposes the native delete badge.**
Deleting there, or running `bun ipodtouch4 uninstall`, uses iOS's uninstall
service and removes the application container, including its data. A later
`deploy` installs a fresh container. The CLI verifies that the registration
and container are gone. The privileged installer bridge stays under
`/var/root/Library/PocketJS`; its install/uninstall entitlement is never added
to the application binary.

`launch`, `status`, and `capture` look up the current container from the iOS
installation record. The runtime resolves `NSTemporaryDirectory()` and keeps
its receipts and captures inside that container. **`status` reads
`<container>/tmp/pocketjs.status` twice** and
requires the running build id, an advancing frame counter and heartbeat, and
the GLES1 640×960 density-2 drawable. With `--require-action` it additionally
requires at least one completed touch sequence and a reported action under
the app's action name (`clear_gesture`, `nexus_play`) — a receipt that an
interaction completed on the hardware.

`capture` asks the running app for a raw RGBA frame and converts it to
`dist/ipodtouch4/device-frame.png`.

User application icons use **opaque 57×57 and 114×114 artwork**. SpringBoard applies the rounded mask and shadow; `UIPrerenderedIcon` suppresses the stock gloss. The System application path uses a precomposed transparent mask instead. Baking that mask into a User icon adds an inset rim under the native mask. Icon filenames include the artwork revision so an update selects a fresh SpringBoard cache entry.

## Native application extensions

External app descriptors may supply `nativeCore`, `assets`, `icon` and
`launch`, resolved against `projectRoot`:

```json
{
  "nativeCore": {
    "manifest": "crates/game/Cargo.toml",
    "library": "libgame.a",
    "features": ["native"],
    "sources": ["hosts/ipod/bridge.c"]
  },
  "assets": ".pocket/ipod/assets",
  "icon": "assets/app-icon.png",
  "launch": "assets/launch.png"
}
```

**The application archive includes the UI C ABI and exports the existing
`pocketjs_symbian_extension_v1` provider.** That symbol retains its name for
ABI compatibility; the portable QuickJS C runtime uses the same V1 table.
`boot` registers application APIs before evaluating the guest. `before_guest`
advances native state; `after_guest` drains commands after the guest and its
pending jobs. The host keeps every callback on its UI/render thread.

A depth flag requests a 16-bit GLES1 depth attachment. `render` draws the
application world before `ui_gl_render_over` composites the retained UI.
The optional graphics tail releases GPU resources when the context shuts
down; it must retain guest and simulation state and recreate GPU resources
on the next render. Final shutdown runs before QuickJS context destruction.
The supplied `gl_context_current` flag determines whether the extension may
issue GL deletion calls or must abandon handles. Every app on this target
advances one UI tick per display-link callback (see Frame rate).

**Nested asset files participate in both build identity and installed-byte
verification.** Symlinks, unsupported filenames and replacements for generated
bundle content are rejected. The icon is baked into opaque 57- and 114-pixel
User artwork. `launch`, an opaque 640×960 PNG, replaces the generated
`Default@2x.png`; the 4-inch `Default-568h@2x.png` repeats its bottom row
below it. Keep the app's bundle identifier, executable, bundle name and URL
scheme distinct from installed applications.

UIKit touch callbacks carry up to eight contacts. Host receipts include
`touch_max_contacts`, `uikit_touch_events` and `legacy_touch_events` to
distinguish multi-contact delivery from a completed single-contact gesture.
