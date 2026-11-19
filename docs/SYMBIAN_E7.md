# Nokia E7 / Symbian Belle development

The current native build entry takes a compiled `--bundle` input. See [Device native builds](DEVICE_BUILDS.md) for compilation, host configs and artifact paths. Dated device validation records retain their recorded commands.

PocketJS includes a pinned, repeatable command-line bootstrap for building
standard Symbian Qt applications and an experimental PocketJS host for a Nokia
E7 (RM-626). The probe exercises the compiler, Qt ABI, E32 executable, resource
registration, SIS packaging, and signing. The private runtime additionally
links the PocketJS Rust core and pinned QuickJS, embeds a compiled application
and its `.pak`, and exposes the host operations needed to draw and accept
button and native-resolution touch input. The separate MTP command proves byte delivery to the phone;
with the CODA agent open, `coda usb install` and `coda usb launch` install and
start a staged package over the same USB cable.

This workflow does not flash or modify firmware. A CFW may relax installation
policy on the phone, but applications should still use the smallest possible
capability set. The runtime uses a private `symbian-e7-dev` host contract; it
does not register Symbian in the production `POCKET_TARGETS` registry.

## What gets installed

`bun tools/symbian.ts setup --yes` downloads five pinned, SHA-256-verified inputs into
the shared `pocket-nexus` toolchain cache:

- Belle SDK for Qt SDK 1.2.1 (`SymbianSR1Qt474`)
- GCCE 4.6.3 for Linux/i686
- Qt 4.7.4 source, used to build a native Linux `qmake`
- GnuPoc's native EKA2 resource, executable, and SIS tools
- `pocket-nexus/quickjs-rs` at revision
  `0fc946fb670c0c29bc0135f510bcb0f595415a61` (QuickJS `2026-06-04`)

Setup also uses `rustup` to install `nightly-2026-07-02` with the `rust-src`
component. That toolchain cross-compiles the no-std PocketJS core static
library for the ARMv6 Symbian EABI.

The build runs in an isolated `linux/amd64` container because the historical
GCCE binaries are 32-bit Intel Linux executables. The SDK and generated signing
identity live in separate named volumes, so a toolchain-version update does not
silently replace the signer. The repository is mounted read-only, only
`dist/symbian` is writable, and USB is never passed into the container. MTP
deployment remains a separate macOS host operation.

The historical SDK inputs are development dependencies and are not
redistributed by this repository. Review and comply with their original terms.

## One-time setup

On macOS, install the host prerequisites:

```sh
brew install libmtp libusb pkgconf
# Install rustup, if it is not already available, then verify:
rustup --version
# Install OrbStack or Docker Desktop, then verify:
docker version
```

Build and inspect the toolchain:

```sh
bun tools/symbian.ts setup --yes
bun tools/symbian.ts doctor
```

The setup is idempotent. Re-running it verifies every critical tool hash and
executes a fresh GCCE/E32/SIS/signing smoke build before reusing the pinned
downloads, container image, and toolchain generation.

The default cache is:

```text
${POCKET_NEXUS_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/pocket-nexus}/symbian
```

`POCKETJS_SYMBIAN_DOWNLOADS` can point at a pre-populated directory containing
the exact manifest assets.

The development certificate and private key live in
`pocketjs-symbian-signing-v1`. Setup migrates an earlier PocketJS E7 signer but
never silently rotates a valid identity. `doctor` prints its SHA-256
fingerprint. Losing that volume means a replacement certificate cannot upgrade
an installed package with the same UID, so keep an offline, access-controlled
backup:

```sh
docker run --rm --network=none \
  --mount type=volume,src=pocketjs-symbian-signing-v1,dst=/signing,readonly \
  --mount type=bind,src="$PWD",dst=/backup \
  --entrypoint tar pocketjs-symbian-toolchain:sr1-qt474-v1 \
  -czf /backup/pocketjs-symbian-signing-v1.tgz -C /signing .
chmod 600 pocketjs-symbian-signing-v1.tgz
```

Treat that archive as a private signing credential. Docker volume pruning does
not preserve it.

## Build and stage a physical-device probe

Keep the E7 in **Nokia Suite / Ovi mode**, then run:

```sh
bun tools/symbian.ts doctor --device
bun tools/symbian.ts build probe
bun tools/symbian.ts deploy dist/symbian/pocketjs-e7-probe.sis
```

The deploy command:

1. discovers the current top-level `Mass memory/Installs` object ID;
2. uploads the SIS exactly once;
3. reads the new object back by its returned MTP object ID; and
4. compares the local and device SHA-256 values.

It deliberately does not report the app as installed. On the phone, open:

```text
File manager > Mass memory > Installs > pocketjs-e7-probe.sis
```

Accept the self-signed development warning and launch **PocketJS E7 Probe**.
The probe requires `CAPABILITY NONE` and displays a full-screen Qt status page.
If installation policy blocks it, check:

```text
Application manager > Installation settings > Software installation > All
```

Do not disable certificate checks globally unless the specific CFW workflow
requires that choice and its security consequences are understood.

## Build and stage a PocketJS application

Compile the application for the `symbian-e7-dev` host its config lists, then
pass its **bundle (`.pkb`)** to the native builder. The native step checks
the bundle's identity, builds the Rust runtime, links the Qt/QuickJS host, and
signs one SIS:

```sh
bun tools/pocket.ts compile --config apps/hero/pocket.host.config.ts --project-root . \
  --target symbian-e7-dev --output dist/symbian/application.pkb
bun tools/symbian.ts build app --bundle dist/symbian/application.pkb \
  -- --sis-version 1.0.0
```

From the application's directory, `pocket build --target symbian-e7-dev`
compiles the application and runs the same recipe in one command.

It writes both the installable package and a build receipt:

```text
dist/symbian/hero-main.sis
dist/symbian/hero-main.receipt.json
```

Every application gets a stable private-range UID derived from its Pocket app id,
a collision-resistant executable name, its own application-menu caption, and
output-specific SIS/receipt filenames. Multiple PocketJS apps can therefore be
installed side by side instead of replacing one shared runtime package. The
receipt records that identity, the package version, pinned QuickJS revision,
and SHA-256 hashes for the JavaScript, `.pak`, resolved plan and Rust core.
Receipt schema 4 also carries a `data` array of
`{path, bytes, sha256}` entries for custom-core mass-storage files. It also
records the deterministic GCCE data base:
the historical 4 MiB baseline plus the raw embedded JS/pak byte count,
rounded to 1 MiB. This keeps large DeepZoom packs above
the read-only qrc segment without weakening the linker's overlap check. Stage
the SIS over the same readback-verified USB/MTP path:

```sh
bun tools/symbian.ts doctor --device --coda-usb
bun tools/symbian.ts deploy dist/symbian/hero-main.sis
```

Install it from `File manager > Mass memory > Installs`, then launch
the application's title. With CODA open on the phone, the host installs and
launches the staged package instead:

```sh
bun tools/symbian.ts coda usb install hero-main.sis
bun tools/symbian.ts coda usb launch <executable>   # the receipt's "executable"
```

Symbian package upgrades must use a version greater
than the version already installed on the phone. After installing `1.0.0`, for
example, pass `--sis-version 1.0.1` for the next build rather than reusing
`1.0.0`.

External Pocket projects use the same authority without copying the toolchain:

```sh
bun tools/symbian.ts build app \
  --bundle /path/to/project/dist/application.pkb \
  --outdir /path/to/project/dist/symbian
```

Applications that need an app-specific native surface can supply a prebuilt
archive through `--core-library`. The archive must implement the ordinary
PocketJS `ui_*` ABI; it may also export the versioned
`pocket_native_extension_v1` table from
`pocket_native_extension.h`. The table adds synchronous boot, fixed-step
input, post-guest command draining, resize, render, and shutdown callbacks
without copying or forking the Qt/QuickJS host:

```sh
bun tools/symbian.ts build app \
  --bundle /path/to/project/dist/application.pkb \
  -- --core-library /path/to/libapplication_symbian_core.a
```

An application-specific core can package a non-empty external data tree in the
same SIS by adding `--mass-storage-data-root`:

```sh
bun tools/symbian.ts build app \
  --bundle /path/to/project/dist/application.pkb \
  -- --core-library /path/to/libapplication_symbian_core.a \
  --mass-storage-data-root /path/to/native-data
```

This option is restricted to `--core-library`; the stock core cannot use it.
The source must be a real directory containing only
regular files. Symlinks, special files, empty trees, unsafe relative paths,
case-insensitive path collisions, and a source that overlaps the build payload
are rejected. Portable path components use ASCII letters, digits, spaces,
periods, underscores, and hyphens, and may not begin or end with a period or
space.

The host copies the tree into the locked payload and writes a deterministic
manifest containing only relative paths, byte counts, and SHA-256 digests. The
offline container revalidates the manifest, exact file set, and every file's
byte count and digest before packaging. Each file is installed to
`E:\private\<application UID without 0x>\data\<relative path>`. These bytes are
not embedded in the Qt resource, exposed to QuickJS, or counted in the GCCE
read-only data-base calculation; the custom native core owns how it opens and
interprets them. The receipt's `data` array is the authoritative record of
what the SIS carried.

The stock core's provider returns null, so it retains the exact 2D runtime and
requests no depth buffer. A custom core disables that default Cargo feature
and exports the same symbol with a callback table. This explicit null-provider
shape is intentional: Symbian's historical E32 conversion tools cannot safely
consume ELF weak relocations. An extension can request a depth attachment,
render its scene first, and let `pocket_native_program_gl_render_rect` composite the retained
PocketJS HUD without clearing the color buffer. The PAK bytes stay owned by the
host and may be borrowed only until the matching shutdown call; the generated QuickJS guest
borrows the bundle storage until shutdown. QuickJS-NG marks it immutable;
engines without that API can write the bundle bytes. Shutdown reports whether the owning GL context is current,
allowing the extension to delete live resources normally or abandon stale
handles after context loss. The selected
archive is copied inside the serialized build transaction and its exact bytes
remain covered by the receipt's `sha256.core`. The pinned QuickJS archive also
includes its official `static-functions.c` wrappers, so Rust extensions can
call the inline value helpers through stable C symbols without carrying a
second QuickJS build.

Rust application cores should import the matching table, flags, and native-key
bits from `pocket_native_program::extension`; that module is the Rust ABI
authority paired with the public C header.

**One SIS embeds one application and boots one canonical Runtime through
`PocketNativeProgram`.** The program is created from the embedded `app.js`
and `app.pak` at the window's viewport, with the build's host profile facts
and hash. The generated QuickJS binding dispatches core operations against
that instance; the host registers no application-switching operations. Qt
owns the window and native extension callbacks. The runtime owns its copy of
the script and pack, input encoding, core ticks and the presentation
coordinator. These C records remain a candidate ABI.

The experimental host has these runtime semantics:

- PocketJS uses the full native Qt window as its logical viewport: `640x360`
  in landscape and `360x640` in portrait. There is no PSP-shaped `480x272`
  surface, scaling, or black letterbox margin on the E7.
- Qt automatic orientation delivers window resize events. The host resizes the
  Rust core first, then calls the framework's live-viewport hook. Solid and Vue
  Vapor update their app and overlay roots in place, so application state,
  focus ownership, and timers survive rotation rather than being remounted.
- **An application whose dynamic viewport range admits one orientation only is
  held in it.** When `pocket build` compiles the application from its host
  config, the recipe reads `app.viewport.dynamic`: a maximum width below the
  minimum height is `portrait`, a maximum height below the minimum width is
  `landscape`, and every other range is `auto`. A bundle compiled elsewhere
  carries no range, rotates (`auto`), and takes `--orientation
  auto|portrait|landscape` after `--` to hold an orientation. The host sets Qt's portrait or landscape lock in place of automatic
  orientation, so opening the keyboard does not rotate the app. The receipt
  records the choice as `runtime.orientation`. Pocket Clear and Pocket Nexus
  declare `360x640` as both minimum and maximum and stay portrait.
- Applications targeting the E7 must declare a compatible dynamic viewport.
  Responsive rows should use wrapping or other flexible layout constraints;
  the Hero example keeps its PSP/Vita fixed viewport and adds a
  `360x360`–`640x640` dynamic variant with a `640x360` default.
- The default host calls the JavaScript frame at 30 Hz and advances the
  PocketJS core with `60 / POCKETJS_FRAME_RATE` fixed ticks per frame (two at
  the default rate). **`build app --frame-rate 60` requests a 60 Hz host timer.**
  Builds reject non-positive rates and rates that do not divide the core's
  fixed 60 Hz clock. The requested rate is a scheduling target; frame work
  and presentation can reduce the achieved rate.
- Arrow keys map to the four directions, the navigation center/Select key and
  keyboard Enter to `CIRCLE`, Escape to `CROSS`, Space to `START`, Backspace
  and Home to `SELECT`, Q/E to the left/right triggers, and T/S to
  `TRIANGLE`/`SQUARE`.
- Native extensions additionally receive an independent held-key bitset:
  W/A/S/D move, arrows look, E fires, Space jumps, R reloads, and Shift walks.
  This channel does not change the portable PocketJS button mask seen by the
  guest.
- Touch frame v2 uses tagged 10-bit coordinates for the E7's full 640-pixel
  axis while retaining the original untagged 9-bit wire for PSP/Vita-era
  hosts. `symbian-e7-dev` advertises `input.touch`; the framework exposes the
  same immutable per-frame contact snapshots on both encodings.
- **`symbian-e7-dev` advertises `ui.physics`.** For a plan that resolves it,
  the build passes `POCKETJS_PHYSICS=1` to qmake and the runtime admits
  ops 52–56. The generated binding mounts these methods after checking the
  instance capabilities. The receipt records the choice as `runtime.physics`.

### Measure frame work

**The host requests RGB888 color buffers.** Qt's default E7 format selects
RGB565 despite the 32-bit system desktop, adding a dither grid to gradients
and baked artwork. The request uses eight bits for each RGB channel and no
alpha buffer. Startup logs and the trace's `framebuffer_rgba_bits` field
report the channel sizes returned by GL, so a fallback remains observable.

The GLES backend joins adjacent ranges with matching textures and scissors,
skips repeated scissor state, and uses direct coordinates for a native-sized
viewport. **A 4 × 4 opaque patch in unused font-atlas padding** lets solid fills
share a batch with surrounding glyphs. A two-pixel gap protects glyph filtering;
atlases without room use the separate white texture. An image containing an
opaque white 4 × 4 block can also supply constant-color fills without changing
its pixels. Scaled text resolves a font page once per run and page transition;
font revisions and texture generations are checked before reuse.

**Full-size and scaled glyphs share the same coverage pages.** Each glyph has
a transparent texel gutter. GLES uploads white coverage palettes as
`GL_LUMINANCE_ALPHA` (two bytes per texel), retaining the RGBA path for colored
palettes. Before first presentation, it warms single-page baked fonts within
a **2 MiB coverage / 4 MiB GPU upload budget**. Multi-page and streamed fonts
remain demand-loaded. A font replacement invalidates its pages; texture
generation checks reject handles freed by the application.

Static text placements are cached by node slot, text, font revision, wrapping
width, tracking, line height and alignment. **The placement cache holds at
most 256 runs, 64 KiB of text and 256 KiB of glyph placements**, plus entry
metadata. Streamed fonts and runs with missing glyphs bypass this cache.
Transforms and colors are applied when drawing. Cached glyph bounds reject
text outside the clip before emitting its glyphs.
Scaled 2D text retains each glyph's quad endpoints and uses the inherited
scissor for inner clipping. Moving an occluding edge no longer changes the
sampling of visible ink. Glyphs crossing the viewport still clip their UVs
to keep draw coordinates within the viewport contract.

The framework touch recorder allocates **128 frame slots per chunk** as
contacts arrive. This avoids initializing a 36,000-slot array on first touch;
the ten-minute recording window, surface lanes and replay format are retained.

The straight center of a vertical rounded gradient uses clipped gradient
rectangles; curved rows retain coverage spans. Small flat borders reuse local
coverage masks when a parent scales them. **The border cache holds at most
16 masks of at most 128 × 128 texels (1 MiB RGBA).** Shapes outside that budget,
nonuniform scales, and animated shapes that exhaust the cache use analytic
spans. The cache never evicts a mask referenced by the current draw list.

**Release frames do not query the GL error queue.** `glGetError` can wait for
queued GPU work on mobile drivers, serializing CPU and GPU execution. Shader,
texture and renderer initialization retain their error checks. Debug builds
check each frame.
The synchronization mechanism is described in Apple's
[OpenGL ES design guidelines](https://developer.apple.com/library/archive/documentation/3DDrawing/Conceptual/OpenGLES_ProgrammingGuide/OpenGLESApplicationDesign/OpenGLESApplicationDesign.html).

**`build app --perf-trace` enables a bounded native trace.** It records the
GLES version, vendor, renderer and extensions, plus the EGL version and swap
behavior, then buffers a 30-second workload with
limits of 60 wall-clock seconds and 2,048 frames. After measurement, it writes
`E:/Installs/pocketjs-perf.tsv`. Normal builds omit tracing and replay.
Collection and replay begin after 120 warmup frames, allowing first-presentation
uploads and deferred context cleanup to settle before the opening gesture.
The SIS receipt records the requested frame rate, tracing flag and QuickJS
optimization level (`-O2`, with wrapping signed arithmetic and strict aliasing
disabled). **The E7 host, QuickJS and Rust core use VFPv2 instructions with the
soft argument ABI** required by the Symbian C libraries and Qt. The E7 HAL
reports `EHardwareFloatingPoint=EFpTypeVFPv2`; the SIS receipt identifies this
as `vfpv2-softfp`.
The built-in E7 Rust core uses `opt-level=3`; other hosts retain their build
profiles. A caller-supplied `--core-library` retains its caller's compiler flags.

The frame rows contain elapsed time, frame interval, JavaScript execution,
core ticks, GLES submission and presentation time in milliseconds.
`js_ms` measures the guest callback and its native extension hooks;
`tick_ms` includes input encoding and core ticks. `hit_ms` is `-1` in the
canonical composition because the generated binding has no per-operation
profiler; the trace records `hit_ms_available=0`. Historical traces measured
those queries inside `js_ms`.
**Replay uses the framework's virtual frame clock** (`replay_ms`), so a slow
frame cannot skip a whole press/release sequence. Phase assignment uses this
clock; FPS and CPU durations use wall time. Without replay, both clocks use
wall time. This measures rendering throughput for a fixed input sequence.
Drawing is split into scene generation, resource synchronization, vertex
generation, buffer upload, GLES submission and frame validation, with batch
and vertex counts. `error_ms` is zero when frame validation is disabled, apart
from the trace callback's clock quantization.
The program API `pocket_native_program_set_gl_trace` supplies these boundaries on the render
thread; a null callback disables them. Callbacks must not re-enter the UI or
issue GL commands.
`present_ms` includes `draw_ms` and Qt's swap. **These are CPU wall times,
not GPU timer queries or panel scanout measurements.** The GLES driver calls
`glFinish` before the coordinator retires frame resources. The measured loop
performs no readback or file writes. `draw_ms` includes this terminal wait;
traces from the earlier submission-only renderer have a different boundary.
The next completed frame after measurement is saved to
`E:/Installs/pocketjs-perf.png` for visual inspection. This readback is outside
the measured interval.
On Symbian, diagnostic builds reset the inactivity timer once per second
for five minutes, covering collection and inspection: packed replay bypasses
the window server's input activity tracking. Replay fixes orientation to the
application's initial viewport so icon hit targets stay at the recorded positions.
Normal builds retain automatic orientation and device sleep behavior.
Keep the device unlocked with the application in front. `inactive_frames`
counts samples taken without an active window after the first startup second;
discard such runs when measuring interactive performance.

For repeatable input, a trace build reads `E:/Installs/pocketjs-perf-input.tsv`
at startup. A nonempty `E:/Installs/pocketjs-perf-<uid>-input.tsv`, where `<uid>` is
the package UID as eight lowercase hex digits, takes its place and selects
`pocketjs-perf-<uid>` as the output prefix, so each installed application
reads and writes its own trace files. Each row contains an elapsed millisecond timestamp and one packed
touch-v2 contact, separated by a tab; zero releases the contact. Timestamps
must stay ordered, remain within 0–30,000 ms and end with a release. The file is
limited to 128 KiB and 4,096 points. Remove it before measuring manual input.
Replay exercises the guest input path; it does not measure physical touch
delivery through Qt.

## Physical acceptance

For physical acceptance, launch the app in landscape, change some visible
state, then close/open the keyboard or rotate the phone. The UI should fill and
reflow at `360x640`, preserve that state, and return to `640x360` without a
restart, red error screen, stale strip, or black margin.

`PocketJS E7 Runtime` version `1.1.1` passed the original manual landscape/portrait
launch and live-relayout check on an RM-626.

## Optional CODA device agent

Qt SDK 1.2.1 shipped `Public-CODA-1.0.6-for-S60v5-Anna-Belle-vFuture.sis`.
For Belle devices it selects CODA 4.0.23. If that original SIS has been
obtained from the historical Qt SDK, it can use the same verified staging path:

```text
SHA-256 db1a0b4208ab90a8c08f62e73aada2f4dbfaa7cea60557bf4fe7d89e0b3cc333
```

```sh
bun tools/symbian.ts deploy /absolute/path/to/Public-CODA-1.0.6-for-S60v5-Anna-Belle-vFuture.sis
```

Install it manually and open **RnD Tools**. USB is the preferred path on this
macOS workflow: keep the phone in Nokia Suite mode, select USB in CODA, and run:

```sh
bun tools/symbian.ts coda usb
# Or include it in the complete device check:
bun tools/symbian.ts doctor --device --coda-usb
# Launch an installed app without touching the phone (read the exact name
# from that app's *.receipt.json):
bun tools/symbian.ts coda usb launch PocketJsHeroMainEB73AD06.exe
# Install a SIS that `deploy` staged in Mass memory/Installs:
bun tools/symbian.ts coda usb install hero-main.sis
```

The host opens only the exact Nokia E7 Suite-mode VID/PID and claims CODA's
control/data interfaces 3 and 4 directly through `libusb`. It sends the
historical CODA serial ping followed by the TCF Locator handshake, without
querying a serial number or IMEI. This avoids relying on the old Nokia USB
driver binding that modern macOS no longer provides. A successful check reports
the agent version, for example `4.0.23:app`.

`coda usb launch <executable.exe>` waits for the device's Locator service list,
requires the `Processes` service, and sends CODA's non-debug-controlled
`Processes.start` command for that exact independently packaged executable.
Success includes the CODA process context, for example
`CODA process: p2382`. The command never guesses which app to start and never
terminates an existing process; close the app first if CODA reports that it is
already running.

`coda usb install <package.sis>` requires the `SymbianInstall` service and
sends `SymbianInstall.install` for `E:\Installs\<package.sis>` with target
drive `E:`, the command Qt Creator's CODA deploy step sends. **The phone shows
no installer dialogs; the command waits up to 180 s for the reply.** The
argument is a bare file name of ASCII letters, digits, `.`, `_` and `-` ending
in `.sis`, so the host cannot name a file outside `Installs`. The version rule
of a manual upgrade still applies.

This is a repeatable remote-launch path for device testing, not yet a
source-level debugger. CODA also exposes run control, logging, memory,
registers, and breakpoints, but PocketJS does not yet ship the CODA-to-GDB
adapter, a Symbian GDB, or the matching native symbol artifact. QuickJS
source-level breakpoints require a separate PocketJS DevTools transport.

WLAN remains an alternative. Connect the phone and host to the same network,
select WLAN in CODA, and use the IP and port shown on the phone (the historical
Qt Creator default is `65029`). Belle can tear down an idle WLAN bearer, so USB
is more reliable for a long development session.

CODA's historical Nokia certificate is expired and the package contains
protected capabilities. Its signer is valid from 2011-10-21 through 2016-01-02;
do not re-sign it with the PocketJS development key. If the phone reports
`Certificate expired`, disconnect it from networks, disable automatic time,
temporarily set the date to `2015-06-01`, install the original SIS, and restore
the correct date immediately. A CFW can still block that path according to its
install-server policy.

## PocketJS port boundary

The toolchain now implements the GCCE-compatible Rust core, QuickJS execution
and Promise-job draining, the base HostOps surface, embedded compiled
JavaScript and `.pak` resources, fixed-step presentation, live native-viewport
relayout, buttons, native touch, and independent app identities. The app build and MTP readback checks make both the
native package and delivery substrate repeatable. A signed SIS is
time-dependent and therefore is not expected to be byte-for-byte reproducible
between builds.

Those implementation milestones do not make Symbian a production PocketJS
target. Installation, launch, visible output, and live landscape/portrait
relayout are confirmed on one RM-626, but that single manual check is not
repeatable golden validation. The CODA USB command verifies the transport and
TCF Locator session, while MTP remains the implemented file-delivery path.
`symbian-e7-dev` stays private until the host passes a full physical-device
acceptance suite and repeatable visible-output/button-input golden tests. Touch
is specifically outside the published contract during that period.

## Device and privacy boundaries

The device doctor uses MTP discovery only. The separate AT investigation used
only read-only model and firmware commands; the toolchain never queries an
IMEI or serial number. Logs redact 14–16 digit identifiers and modem device
paths. The tested device was an RM-626 running firmware `111.040.1514`
(Symbian Belle Refresh), whose ROM Qt 4.8 remains compatible with this Qt 4.7.4
application build.

## Sources

- [Qt SDK 1.2.1 release](https://www.qt.io/blog/2012/04/18/qt-sdk-1-2-1-update-released)
- [Qt 4.7 source archive](https://download.qt.io/archive/qt/4.7/)
- [GnuPoc package](https://github.com/mstorsjo/gnupoc-package)
- [Qt's historical Symbian support notes](https://wiki.qt.io/Support_for_Symbian)
- [Qt Creator 2.4 CODA serial transport](https://code.qt.io/cgit/qt-creator/qt-creator.git/tree/src/shared/symbianutils/codadevice.cpp?h=v2.4.1)
- [Qt Creator 2.4 macOS Symbian device discovery](https://code.qt.io/cgit/qt-creator/qt-creator.git/tree/src/shared/symbianutils/symbiandevicemanager.cpp?h=v2.4.1)
- [libmtp `mtp-sendfile` implementation](https://github.com/libmtp/libmtp/blob/v1.1.23/examples/sendfile.c)
