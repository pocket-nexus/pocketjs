# Nintendo 3DS product

The 3DS product composes **one archive containing `pocket-runtime-cabi` and
private recovery inspection** with the
generated QuickJS guest, a package source, input source, PICA renderer and two
display outputs. The runtime owns the retained tree, layout, animation, physics,
package admission and frame coordination. The C device driver consumes the public
DrawList and resource contracts and issues **PICA200 draws through citro3d**.

The app owns the **400x240 top screen** and **320x240 auxiliary bottom screen** at
raster density 1, under the private `3ds-dev` profile in `tools/3ds-profile.ts`.
The resistive panel reports contacts through `input.touch.auxiliary`. The profile
remains outside the production registry pending the complete hardware and golden
suite; the architecture migration has compiler, linker and host-test coverage.

```
core/                 one runtime staticlib plus package recovery inspection ABI
include/pocket_core.h package inspection and native resource convenience calls
include/pocket_profile.h generated profile facts, hash and operation identifiers
src/instance.c        runtime, package/input/provider registration
src/main.c            process boot, reusable guest lifecycle, frame boundary
src/runtime.c         immutable package storage, active/rollback state
src/devserver.c       discovery, paired TCP pump, uploads, screenshots, receipts
src/dev_protocol.c    byte-order-safe development wire encoding and admission
src/devmenu.c         host-owned bottom-screen development DrawList
src/native.c          .3dsx staging, verification and swap for the dev connection
src/hbldr.c           Luma3DS hb:ldr requests that start a .3dsx on exit
src/error_text.h      fixed-buffer error formatter
src/gfx.c             PICA driver registration and product texture/scene adapters
src/qjs.c             generated guest attachment and product namespaces
src/transition.c      app-switch overlay: scrim and activity indicator lists
src/bytecode.c        a slot's bundle bytecode on the SD card
src/services_host.c   host_services.h: clocks, owner name, sockets, SD slots
src/wifi.c            globalThis.wifi over AC and nwm::EXT
src/camera.c          camera texture, QR decode and stills
src/photos.c          camera.photo: JPEG save, list, decode, thumbnails
src/photos_jpeg.c     JPEG through libjpeg for photos.c
src/input_policy.c    reserved product chords and development-menu input latch
engine/host-services/ link, launcher, fs, JSON, SHA-256, photo images, quirc
platforms/3ds/        shared hooks, unreserved HID facts and input source
devices/3ds/          PICA renderer and vertex shader
Makefile              native build driven by this product’s build.ts
```

The independent renderer lives in `devices/3ds/pocket-3ds-pica`. It links the
public runtime ABI helpers for DrawList decoding and guarded glyph pages; it has
no dependency on `Ui`, QuickJS, camera, media or the launcher.

## Building

Two toolchains, one repository:

- The **Rust archive uses the root workspace and lockfile**, the built-in
  `armv6k-nintendo-3ds` target and the build-std compiler pinned in
  `tools/build/toolchains/rust.ts`. The recipe selects panic abort.
- The **C half builds in the digest-pinned `devkitpro/devkitarm` image**, which brings
  `arm-none-eabi-gcc`, libctru, citro3d, `picasso`, `smdhtool` and `3dsxtool`.

`tools/3ds.ts` drives both and hands this Makefile container paths in
environment variables (the list is at the top of the Makefile).
`src/instance.c` registers the PICA instance and both outputs.

```sh
bun tools/3ds.ts 3ds-demo              # dist/3ds/<output>.3dsx
bun tools/3ds.ts 3ds-demo --capture    # the deterministic e2e binary
bun tools/3ds.ts 3ds-demo --cia        # also dist/3ds/<output>.cia
bun tools/3ds.ts 3ds-demo --pocket-only # rebuild only dist/3ds/<output>.pocket
```

Every build writes a target-thinned `.pocket` next to the native artifact.
**The `.pocket` contains the admitted manifest, resolved plan, compiled JS and
target-flavoured PAK.** The native runtime embeds the same file as its immutable
recovery guest; it no longer embeds independent `app.js` and `app.pak` files.

## One runtime for every game

**Nothing in the program depends on the game.** At boot `main.c` reads
`romfs:/app.pocket` before it creates a render target: `pocket_package_open`
admits the package and returns the plan's `viewport` and
`surfaces.auxiliary` (logical size and raster density), its `io.offload` and
`media.playback` features, and the first 16 hex digits of SHA-256 over the
variant identity's app id. The surfaces must be the 400x240 top screen and the
320x240 bottom screen at density 1 (a plan without an auxiliary surface gets
the whole bottom screen); the hash names the state slot below
`sdmc:/pocketjs/runtime/apps/`. A guest installed later over the wire must
have the same surfaces. A `.3dsx` with no RomFS, or no `app.pocket` in it,
writes `this .3dsx carries no game: romfs:/app.pocket is missing` to the bottom
screen and to `sdmc:/pocketjs-error.txt`, and waits for HOME.

**The generic runtime is a separate program.** `programs/3ds` reads a file
package and registers the generated guest, input source and two PICA displays.
It has no product services, development server, camera, launcher or recovery
state. Its `3ds-runtime` profile accepts only the capabilities implemented by
that program. The generic program links the default Runtime archive; this
product links `core/` for its recovery inspection interface.

Use `pocket build --target 3ds --generic` for that runtime and
`pocket pack --runtime <build-directory> --pocket <application.pocket>` to
replace its RomFS. See [the minimal program](../../programs/3ds/README.md).
`pocket build --target 3ds --pocket <application.pocket>` selects this product
and its `3ds-dev` profile. Existing `tools/3ds.ts` options delegate to
`products/3ds/build.ts`, including capture, CIA and package-only builds.

## Updating the guest from SD

The build prints the application's 16-hex-digit runtime slot. The runtime
checks that application's staging path at boot:

```text
sdmc:/pocketjs/runtime/apps/<runtime-slot>/pending.pocket
```

With an FTP server running as a separate homebrew application, build and upload
the guest package, then exit the FTP server and start Pocket Runtime:

```sh
bun tools/3ds.ts 3ds-demo --pocket-only
curl --ftp-create-dirs -T dist/3ds/pocket3ds-demo-main.pocket \
  ftp://<device>/pocketjs/runtime/apps/<runtime-slot>/pending.pocket
```

The runtime verifies the package footer, exact `3ds-dev` target, host ABI,
identity, resolved plan and NUL-terminated JS section before it can boot. A
complete pending package is renamed to
`sdmc:/pocketjs/runtime/apps/<runtime-slot>/packages/<hash>.pocket`; package
blobs are immutable.
An incomplete FTP upload stays at `pending.pocket` and does not replace the
running or accepted guest.

**Each embedded application id has its own package, generation and recovery
state.** The slot is the first 16 hexadecimal digits of SHA-256 over the
manifest `id`, which the runtime computes at boot from the identity of
`romfs:/app.pocket`; the fixed length keeps native paths bounded. Contacts, Pocket
Shell and Pocket Term can therefore live as separate `.3dsx` files on one SD
card without one app's last-good package booting under another app's icon.
The pairing key remains device-wide at `sdmc:/pocketjs/runtime/dev.key`, so the
console is paired once. Pre-slot state directly under
`sdmc:/pocketjs/runtime/{packages,state}` is left untouched and is not loaded
by a slotted runtime.

**A package becomes active only after its first submitted PICA command list has
retired successfully.** State is committed by appending a generation marker
under the application's `state/` directory. Eval, frame or first-render failure
loads the previous active package, then last-good, then the embedded ROMFS
recovery package. Power loss before the generation marker leaves the previous
generation active.

**A newly installed `.3dsx` boots the guest it embeds.** The slot records the
embedded package's hash in `embedded.txt`. A start that finds a different hash
boots the embedded guest in place of the active package; once its first frame
retires it is the active generation and the package it replaced is last-good.
If that guest fails, the active package and then last-good are tried before
the failure is fatal. A push made before the install cannot shadow it, and a
push made after it is kept across restarts. Reinstalling an unchanged `.3dsx`
leaves the hash unchanged and keeps the push; `install` (below) then pushes
the embedded guest. A `pending.pocket` is admitted before this check.

`L+R+X` requests the same package check at a GPU-idle frame boundary. The full
chord is removed from the application's button mask. This supports an emulator
or direct SD writer; a separate 3DS ftpd cannot run concurrently with Pocket
Runtime.

Runtime receipts are written to:

```text
sdmc:/pocketjs/runtime/apps/<runtime-slot>/status.txt
sdmc:/pocketjs/runtime/apps/<runtime-slot>/last-error.txt
```

`status.txt` records the slot, current generation, active hash, last-good hash,
running package hash and source path. `last-error.txt` records the failed phase
without deleting the rejected package blob.

## Multiple Homebrew Launcher entries

Copy each product's `.3dsx` to a distinct filename under `/3ds/`; the SMDH
inside each file supplies its own title and icon. **`L+R+START` is owned by the
native host and exits the running `.3dsx` back to the Homebrew Launcher.** The
complete chord is removed from guest input. Select the next Pocket app in HBL
to switch while preserving each app's independent accepted and last-good
packages.

## In-process development connection

`L+R+SELECT` opens the **3DS host's native development menu** on the bottom
screen. It shows the current IP and port, pairing or connection state, active
generation, running package hash, update and screenshot counts, and transport
errors. `X` requests a dual-screen screenshot from a connected client; `B` or
`START` closes the menu.

**While visible, the menu replaces the guest's bottom-screen DrawList with a
host-owned DrawList and consumes all guest input.** It uses the same verified
PICA200 backend as the guest and reads a fixed native Runtime snapshot; it is
not part of `globalThis.ui`, the guest input contract, or a published PocketJS
capability. The input latch stays active until the keys used to close the menu
have been released.

Pocket Runtime listens on TCP and UDP port 8131 when this file exists:

```text
sdmc:/pocketjs/runtime/dev.key
```

Pair once while ftpd is running, then restart Pocket Runtime:

```sh
bun run 3ds:dev pair --host <device-ip> --ftp-port 5000
```

**The pairing command generates a random 32-byte key, stores the local copy
under `.pocket/3ds/devices/`, uploads the device copy, and verifies the FTP
readback byte for byte.** The Runtime does not open a listener without the key,
and a client must prove the complete key before any command or package byte is
accepted.

**The key authenticates a client but does not encrypt the TCP stream.** Use the
listener on a trusted LAN, and pass `--rotate` to `pair` after a key is exposed.
**The key authorizes native code: a paired client writes and starts any
`.3dsx` under `sdmc:/3ds/`.** Frames after the hello carry no MAC, so a host
that can inject into the TCP session can do the same.

After pairing, ftpd is not part of the development loop:

```sh
bun run 3ds:dev discover
bun run 3ds:dev push    --app 3ds-demo
bun run 3ds:dev install --app 3ds-demo
bun run 3ds:dev probe
bun run 3ds:dev dev     --app 3ds-demo
```

**`discover`, `push`, `install`, `launch`, `probe`, and `dev` do not require the 3DS IP**
(`install --ftp` does). The
Runtime answers one fixed-size UDP discovery request with its target, ABI,
TCP port, generation, active hash, and a stable ID derived from the pairing
key. The reply never contains the key. The desktop tool matches that ID to a
local key and then authenticates the TCP connection with the complete 32-byte
key. This keeps the pairing valid when DHCP changes the console's address.
Pass `--host <device-ip>` when broadcast discovery is unavailable; the native
menu supplies that address.

**`dev` waits when no paired Runtime is present, replaces a disconnected TCP
client, and rediscovers the same paired device ID until it reconnects.** Panel
commands and keyboard shortcuts are routed only to the current authenticated
client. A client that receives no PONG for eight seconds is replaced even when
the operating system has not reported the half-open TCP socket as closed. The
Runtime reserves the latest PONG until the bounded output queue can send it;
bulk screenshot traffic cannot discard the heartbeat response.

`push` builds and transfers the target-thinned `.pocket`, then waits for the
device's **accepted-after-retired-frame** receipt. `probe` requests runtime
status, native counters, the component tree, a live REPL evaluation, a console
message, and a combined top/bottom PNG. `dev` keeps the DevTools panel attached;
`r` rebuilds and pushes, `i` installs the `.3dsx` and restarts into it, `s`
captures both screens, and `o` opens the panel.

**`devStats.timingUs` records the mean and maximum microseconds over a 60-frame
window.** `pre` measures sockets, link and input before the tick; the retained
`js` slot now measures the complete canonical tick, including guest, layout,
rendering and terminal presentation. The legacy `tick`, `layout`, `draw` and `gpu` slots are zero until the runtime exposes phase counters.
`wait` measures the host VBlank boundary, and `frame` measures the interval.
`slowFrames` counts intervals above 25 ms. `gpuLate` counts extra VBlanks at the
host boundary; rendering now waits inside the canonical tick, so it is not a
measure of GPU time. Recovery and reload reset the sampled interval.
`ui.__dbgFrames()` retains the `pre,js,layout,draw,gpu,wait,frame` wire shape in
0.1 ms units, with the same zero placeholders.

**One authenticated, ordered TCP connection carries every development
message.** JSON frames contain only Pocket DevTools control and logs. Package
and rotated RGB8 screenshot bytes use bounded binary frames, so bulk data never
enters QuickJS or the application's capability surface. Uploads stream to
`network-upload.pocket`; the existing package admission, immutable blob,
GPU-idle cold-swap, acceptance, and rollback path remains the only route to an
active guest.

**A push replaces the guest `.pocket`, never the process that admits it.** A
native host or ABI change needs a new `.3dsx`, which the same connection writes
as a file for the next start (below); the embedded `.pocket` remains its final
recovery guest. Keeping that boundary lets ordinary app, asset and
resolved-plan changes use the in-process loop without letting a guest replace
the process that admits and rolls it back.

### Installing and launching `.3dsx` files

```sh
bun run 3ds:dev install --app 3ds-demo               # build, install, restart into it
bun run 3ds:dev install --file app.3dsx --no-launch  # install for the next start
bun run 3ds:dev launch pocket3ds-demo-main.3dsx      # start a .3dsx already on the card
```

**`install` streams a `.3dsx` to `sdmc:/3ds/<name>` over the paired
connection, so ftpd is needed once, for pairing.** The Runtime writes
`sdmc:/pocketjs/runtime/native-upload.3dsx`, checks the declared length (32
bytes to 32 MiB), CRC-32 and `3DSX` magic, moves the file it replaces to
`native-previous.3dsx`, and renames the upload into place. A name is 6..64
bytes of `[A-Za-z0-9._-]` ending in `.3dsx`: one file directly under
`sdmc:/3ds/`, never a path. `src/dev_protocol.c` holds the wire and name
rules; `src/native.c` holds the file steps and compiles on the host for
`tests/3ds-native-install.test.ts`.

**A transfer that replaces the running `.3dsx` moves to
`native-deferred.3dsx` and is renamed into place after `romfsExit()`**, on a
normal exit or a fatal error: libctru reads the ROMFS of a running `.3dsx`
from that file. Later transfers and aborts do not touch the deferred file.

**To restart, `src/hbldr.c` sends Luma3DS's `hb:ldr` port SetTarget (the path
without `sdmc:`) and SetArgv (`argv[0]` = the path), and the main loop
ends.** These are the two requests `3ds-hbmenu` sends when it starts an entry;
the loader starts the target as the process exits. Outside the Homebrew
Launcher (a CIA, or Azahar loading the `.3dsx`) the request fails, the file
stays installed, and the receipt says so. `launch` sends the same request for
a `.3dsx` already under `sdmc:/3ds/`.

After a restart the tool rediscovers the device under its pairing ID and
reads the running package hash. When the build's `.pocket` is known and an
older push is running, it pushes the embedded guest. A `.3dsx` that is not a
PocketJS dev build does not answer, which `install` reports and accepts. The
tool stops streaming at the first `transfer-error` and times its waits from
the end of the transfer. Receipts are `runtime.native` control records with a
bare `name` and its `path`: `receiving`, `installed`, `staged`, `launching`,
`rejected`, `transfer-error` and `launch-error`. **The handshake ack sets flag
`2` on a Runtime that accepts these messages**; for an older one, `install
--ftp --host <device-ip>` copies the file through ftpd instead. In `dev`, `i`
builds, installs, restarts and settles the guest over the reconnected
session.

Two build-time facts are load-bearing:

- **`-DJS_NO_NAN_BOXING` must be on every translation unit that includes
  `quickjs.h`.** The header turns NaN boxing on by default for any 32-bit
  target, which makes `JSValue` 8 bytes instead of 16, while `libquickjs.a` is
  compiled with the flag. The mismatch links cleanly and then hands the library
  differently shaped values: the guest boots and QuickJS's GC walks garbage
  pointers a few hundred milliseconds later.
- **`__stacksize__` is raised to 1 MiB.** devkitPro's 3dsx crt0 gives the main
  thread 32 KiB, and QuickJS's interpreter plus the guest's render pass recurse
  far past that.

## The svc companion channel

`src/svcwire.c` implements spec ops 30..32 (`svcOpen`/`svcPoll`/`svcSend`)
over the **SVC WIRE (PKNT) protocol** (`contracts/spec/spec.ts`,
`engine/modules/media/src/wire.rs`) — the transport the Vita host speaks in
`platforms/vita/net/src/lib.rs`, reduced to the devserver.c shape: non-blocking
sockets pumped once per frame by the main thread, no threads. The device
listens for the companion's once-a-second UDP beacon on port 8621 (or reads a
`sdmc:/pocketjs/host.txt` override, one line `a.b.c.d[:port]`, for
broadcast-hostile networks — a failed override alternates back to beacon
discovery), connects to the datagram's source address at its advertised TCP
port, and exchanges `ctrl` JSON-line frames. `ping` is answered with `pong`;
`file`/`stream` frame types are skipped by length and left unimplemented.

**The dev transport, companion transport and offload worker share one SOC
instance** through `src/soc.c`. An atomic state selects one initializer; a
competing caller returns without waiting. Failed initialization retries after
a three-second cooldown. Offload initializes and retries on its worker. The
process releases SOC after every transport stops and the worker is joined.
The companion channel works with or without a `dev.key`. Capture builds compile the whole
transport to inert stubs (`svcOpen` reports false forever), which keeps
golden runs deterministic — the Vita3K contract. A guest switch clears the
guest-visible queues but keeps the TCP connection; a different app id in
`svcOpen` restarts discovery.

[Pocket Term](https://github.com/pocket-nexus/pocket-term) is the reference
consumer, in its own repository: a terminal multiplexer whose Mac companion
owns the PTYs and one authoritative libghostty core per session and streams
cell-grid snapshots + ordered row diffs to the device replica.

**The transport outlives the guest.** A hot-pushed `.pocket` restarts
QuickJS, not this host, so the TCP connection and the companion's view of it
both survive. A guest therefore re-introduces itself on its first frame
(`svcOpen` rising edge → a fresh `hello`), and a companion must treat that
hello as "this replica has loaded nothing" rather than as a new socket — the
Pocket Term companion re-sends its runtime font atlas there, without which
the new guest draws blanks where the old one drew CJK.

## Installed apps and the launcher

**The embedded ROMFS guest is the launcher** (docs/LAUNCHER.md, "Nintendo
3DS"). Every other directory under `sdmc:/pocketjs/runtime/apps/` whose state
names a committed active package is an installed app: `ui.appTable()` lists
them (never the launcher's own slot) with `output`, `id`, `title`,
`version` and `bytes` from the `app` object of the package plan, plus
`current`, `resume`, `launcher` (the embedded output) and `lastError`. The
facts are cached per slot in `app.txt`, keyed by the package hash, so a table
rebuild after an install reads one small file per slot instead of a package.

`ui.appLaunch(output)` schedules the swap for the top of the next frame:
teardown, `runtime_select_slot` + `runtime_storage_init` for the target slot,
boot of its active package. **An installed app has no recovery chain of its
own and never enters the launcher's.** A boot failure or an uncaught frame
exception writes `last-error.txt` into the app's slot, switches to the
launcher and shows once as `appTable().lastError`. Only the launcher walks
active → last-good → embedded.

While an installed app runs, **SELECT belongs to the host**: the app never
sees the bit, and a SELECT press edge returns to the launcher with
`resume` set to the app's output. The edge detector is latched at every boot,
so a SELECT still held from the switch cannot bounce straight back. The
launcher sees SELECT unchanged. `ui.appShot()` returns -1: this host keeps no
frozen frame.

**A switch runs under a host-drawn transition** (`src/transition.c`) on
both screens:

| phase | on screen | length |
|-------|-----------|--------|
| leaving | the old guest's last frame, no longer running, under a black scrim that rises; an activity indicator (eight dots at the touch screen's centre) fades in | 150 ms |
| loading | both screens black, the indicator turning | teardown, bytecode, mount and first frame of the new guest |
| arriving | the new guest's frames, with the scrim and the indicator falling away | 250 ms of presented frames, at most 33 ms counted per frame |

The loading frames come from a thread of their own, one priority step above
the main thread, about a millisecond each. **The main thread issues no GPU
work between the teardown and the new guest's first frame**, and
`begin_frame_wait` and `fail()` stop the thread before they touch the GPU.
QuickJS's interrupt handler runs every 10,000 calls and back-jumps, a few
times a second during a mount, so the loading frames do not come from it.

**SELECT does not wait for the end of a long frame.** Once a frame of an
installed app has run 50 ms, QuickJS's interrupt hook scans the buttons; a
SELECT press edge there summons the launcher and ends the frame with an
uncatchable error, and the app is torn down without another frame. The scan
moves the press edges `hidKeysDown` reports (the dev menu chords) from the
next frame's scan to this one.

**A bundle boots from bytecode after its first boot** (`src/bytecode.c`).
`qjs_boot` compiles the source (`JS_EVAL_FLAG_COMPILE_ONLY`) and hands back
the bytecode (`JS_WriteObject`), which main.c writes to
`<slot>/bundle.qbc`; the next boot of the same package runs it with
`JS_ReadObject`. The file's header carries the package hash, the first 16
hex digits of the QuickJS build stamp (`POCKETJS_QUICKJS_STAMP`, from
`dist/3ds/quickjs/.stamp`) and an FNV-1a checksum; a mismatch compiles again.
On an Old 3DS, compiling Pocket Shell's 477 KB bundle takes 2.3 s and reading
its 368 KB of bytecode takes 80 ms. The guest's runtime strips function
source text (`JS_STRIP_SOURCE`): line tables stay, so a stack names its
lines, and `Function.prototype.toString` returns no source. Capture builds
compile from source on every boot.

**A dev-wire push of another app installs into that app's own slot**, commits
it as the slot's active package and launches it, so
`bun run 3ds:dev push --app nexus` works while the launcher runs. A push of the
running app keeps the candidate → accepted lifecycle; when that app is not the
launcher, a failing candidate returns to the launcher instead of a rollback.

## Pocket Link

`engine/host-services/link.c` is the console side of
`contracts/spec/link.ts`: **one
authenticated TCP connection to a paired companion computer, owned by the
host and kept across every app switch.** A guest switch drops the guest's net
handles, undelivered events and catalog replies; an install that is streaming
keeps writing to storage. Like `svcwire.c` it is non-blocking and pumped once
per frame, at most 64 KiB received (and therefore written to the SD card) per
pump.

- **Identity.** `sdmc:/pocketjs/link/device.txt` holds a random 16-hex device
  id; the name is the CFG user name and the model comes from
  `CFGU_GetSystemModel`. Each paired companion is
  `sdmc:/pocketjs/link/companions/<id>.txt` (key, name, last address, port).
- **Discovery.** The console listens on UDP 8627 and follows a beacon only from
  a companion it holds a key for, connecting to the datagram's source address.
  After 2.5 s without one it tries a paired companion's last address directly.
  Failures back off from 1 s to 8 s; a refusal holds that companion off for
  30 s. Pings every 3 s; 10 s of silence drops the link.
- **Handshake.** The HMAC key is the raw bytes of the secret (32-byte key,
  16-byte pairing secret). The console checks the companion's proof with a
  constant-time compare before it sends its own.
- **Pairing.** `link.pair(uri)` parses `pocketlink://pair?…`, replaces the
  current connection, tries each `h` host in order in mode `pair`, unmasks and
  stores the key on `paired` and stays linked.
- **`globalThis.net`.** The NET module rides the link: at most 2 requests in
  flight, request bodies up to 64 KiB sent as 16 KiB data frames, response
  bodies accumulated in one buffer bounded by `maxBytes`, events delivered by
  `net.poll()` once per tick. `net.start` refuses with
  `unavailable: no companion linked` while unlinked, and adds the running
  guest's app id as `app`.
- **Installs.** `link.install(appId)` streams into
  `apps/<slot>/link-upload.pocket` of the app's own slot, admits the file
  against the head's hash and commits it as that slot's active package. The
  admission reads the package back once, which costs one long frame per install
  (about 1.6 s for a 4.3 MB package on an Old 3DS). `link.remove` refuses the
  running app and the launcher.

`link.status()` carries four diagnostics beyond `LinkStatus`: `connectMs`
(TCP connect + handshake), `rttMs` (last ping), and `rxBytes` / `rxUs` /
`sdUs` / `pumpMaxUs` since the previous read. The development menu shows the
link state on one line.

## Wi-Fi and camera

`src/wifi.c` serves `globalThis.wifi`. Reads go through AC; **libctru's
`acInit` opens `ac:i` when it can, which the saved-slot SSIDs need**
(`ACI_LoadNetworkSetting` + `ACI_GetNetworkWirelessEssidSecuritySsid`, the
working copy only). `connect(slot)` makes the request Luma3DS Rosalina's
"Force wireless connection" makes and polls the completion event with a zero
timeout from `wifi_pump`; `setEnabled` goes through `nwm::EXT`. Nothing writes
a saved connection.

`src/camera.c` serves `globalThis.camera`: **the outer camera at 320x240
RGB565, 30 fps, into one 512x256 host texture.** A capture thread keeps one
`CAMU_SetReceiving` armed into three rotating buffers and restarts capture on
the buffer-error event; the main thread copies the newest frame into the
texture at the GPU-idle frame boundary (`camera_present`). Four times a second
a frame is handed to a low-priority thread that runs quirc. The camera
service starts on `open()` and stops on `close()` or a guest switch. Measured
on an Old 3DS: 30 frames and 4 decode passes a second with the guest still at
60 fps.

`open(flags)` selects the inner camera (`CAMERA_OPEN.inner`, previewed
mirrored) and drops QR decoding (`noScan`); a reopen with other flags restarts
capture behind the same texture handle. **camera.photo** adds stills on the
SD card. `capture()` stops the stream, switches the camera to its second
context (`CONTEXT_B`, 640x480, never mirrored), keeps the second frame, and
returns to the preview. `src/photos.c` encodes the still on a worker with
libjpeg (devkitPro's `3ds-libjpeg-turbo` portlib, linked by the Makefile) as
a JPEG under `sdmc:/DCIM/100POCKT/PKT_nnnn.JPG` (DCF names,
contracts/spec/camera.ts). `load(name, kind)` decodes on the same worker at
the smallest JPEG scale that covers the result (**1/4** of 640x480 for the
78 px centre thumbnail, cached under `sdmc:/pocketjs/photos/thumbs`; **1/2**
for the photo fitted to 320x240), and `photos_present` uploads the pixels as a core texture
and publishes a "loaded" event. Measured on an Old 3DS: the preview at 30 fps
with the guest at 16.9 ms a frame; a photo saved 3.3 s after the press
(0.7 s for the still, 2.6 s to encode and write it behind the 60 fps UI); a
full 640x480 decode in 0.64 s. The pure parts
(`engine/host-services/photos_image.c`: names, pixel conversion, box filters)
run natively in `tests/camera-photo.test.ts`.

Capture and offload builds compile link, net, wifi and camera to inert stubs
and leave the app switching ops out, so goldens stay deterministic.

## Files

A guest that declares `data.fs` gets `globalThis.fs`
([contracts/spec/fs.ts](../../contracts/spec/fs.ts)) from
`engine/host-services/fs.c`: the nine
synchronous ops over **its own slot's `data` directory**,
`sdmc:/pocketjs/runtime/apps/<slot>/data`. `main.c` binds the tree before
`qjs_boot` and unbinds it at a guest switch; no op names a path outside it,
and an uninstall deletes it with the slot. The quota is the plan's
`applet.store.maxBytes` (contracts/spec/applet.ts), else **4 MiB**; `usage()`
walks the tree once per binding and keeps the sum current after that.

FAT refuses a rename onto an existing name, so a truncating write over an
existing file stages the bytes in the slot's `fs-tmp` directory, records the
destination in `fs-tmp/write.dest`, removes the old file and renames the
staged one into place. The next binding finishes a replacement a power loss
cut between the two: the guest reads the old content or the new.
`tests/fs-3ds.test.ts` compiles `engine/host-services/fs.c` natively under
ASan and UBSan and
runs each scenario against it and the sim's fs host (`platforms/sim/fs.ts`), op by
op, result and `lastError` both, plus the FAT path and that recovery. Capture
builds leave the tree unbound.

## The agent stage

A guest that declares `system.agent` gets the top screen drawn by the host:
`src/stage.c` and `src/stage.v.pica` draw the mascot's room in stereo (a
right-eye target `GFX_RIGHT`, `gfxSet3D` on while such a guest runs), and
`src/agent.c` serves `globalThis.agent`: the L+R chord, the microphone (MICU
at 16,360 Hz), touch-screen shots, and the companion's glyph atlases and
own-screen frames, all over the Pocket Link. `main.c` filters the chord out of
the guest's buttons, copies the touch screen into the monitor's texture at
the start of the frame and calls `stage_render` in place of the primary
surface's draw. `ui.captureTexts` / `ui.capturedTexts` read the texts a
surface painted. The mechanism, the overlay and the companion side are in
[docs/POCKET-AGENT.md](../../docs/POCKET-AGENT.md).

## ZL and ZR

The New 3DS has four shoulder buttons and the PSP had two, so `BTN.ZL` /
`BTN.ZR` (`contracts/spec/spec.ts`) take two bits the PSP never assigned.
Hosts without these buttons leave the bits unset.

They do not arrive on the ordinary HID pad. ZL, ZR and the C-stick live in
**ir:rst**'s shared memory (libctru `irrst.h`), so `src/input.c` brings that
service up in `input_init()` after checking the model. `input_buttons()`
scans the shared memory and ORs `irrstKeysHeld()` into the held mask. An Old
3DS skips initialization and leaves the bits unset. Apps must retain an
interaction path that works without these extra buttons.

## The CIA, and the memory region it asks for

`--cia` writes `dist/3ds/<output>.cia` next to the `.3dsx`, from the same ELF
and the same staged romfs directory.

**A `.3dsx` runs under the Homebrew Launcher and lives inside hbmenu's memory
allocation. A CIA is its own installed title and asks the kernel for its own
memory region.** That request is `SystemMode: 64MB` in `app.rsf` — the largest
region an Old 3DS gives an application, out of the console's 128 MiB — plus
`SystemModeExt: 124MB`, which a New 3DS honours and an Old 3DS ignores. A guest
whose arena, expanded textures and pak add up past what hbmenu hands out has no
way to ask for more as a `.3dsx`. That is why the format is here: Pocket Voxel's
12 MiB arena plus ~14 MiB of expanded textures plus a 30.6 MiB pak is exactly
the budget that may not fit under the Homebrew Launcher on a real console.

Three facts about the packaging itself:

- **No banner is required.** makerom needs one only for a title that plays an
  animated banner in HOME Menu. The SMDH passed as `-icon` already carries the
  icon and the title strings, and `-exefslogo` supplies the boot logo.
- **The romfs is a directory, not an image.** makerom builds the romfs itself
  from `RomFs.RootPath`, pointed at the same directory 3dsxtool embeds. Handing
  it the raw romfs binary that `mkromfs3ds` produces — the container 3dsxtool
  takes — fails with `Invalid RomFS Binary`; the two packagers share the staged
  directory and nothing else.
- **makerom ships in neither devkitPro nor Homebrew**, so `tools/3ds.ts` fetches
  one pinned `github.com/3DSGuy/Project_CTR` revision into
  `dist/3ds/makerom/src`, builds it in the same container as everything else,
  and caches the binary against the container image and revision. mbedtls, blz
  and yaml are vendored in that repository, so the fetch is the only step that
  needs the network.

The title's identity comes from the resolved plan, never from a literal per app
(`ciaUniqueId`, `ciaProductCode`, `ciaProcessName` in `tools/3ds.ts`): the
**unique id is `0xFF000 | hash(app.id) & 0xFFF`**, inside the `0xFF000-0xFFFFF`
block that no retail or system title uses, so an app keeps one title id across
rebuilds and an install replaces its predecessor instead of accumulating. The
product code is `CTR-P-` plus four characters of the app id. The RSF's
`BasicInfo.Title` is the exheader's process name, which is 8 bytes — the cut
happens in TypeScript rather than silently inside makerom, and the title HOME
Menu shows is the SMDH's, still whole.

Azahar installs one and then boots the installed title from its own SD card:

```sh
azahar -i dist/3ds/pocket3ds-demo-main.cia
azahar "$HOME/Library/Application Support/Azahar/sdmc/Nintendo 3DS/\
00000000000000000000000000000000/00000000000000000000000000000000/\
title/00040000/0ffc1900/content/0429b6bc.app"
```

`00040000` is the application category and `0ffc1900` is this demo's unique id
shifted up by its 8-bit variation; `tools/3ds.ts` prints the whole title id when
it writes the file. A capture build installed and booted this way produced
frames **byte-identical to the `.3dsx` goldens** in `tests/goldens/3ds/`.

## Guest metadata and operations

**The generated QuickJS guest publishes all numbered UI operations and metadata.**
The runtime supplies the profile, admitted viewport, auxiliary root, raster
density, package bytes and named asset tables. `src/qjs.c` installs the product
namespaces (`link`, `net`, `wifi`, camera, media and agent) and private debugging
hooks around that guest; it has no second UI dispatcher or package registry.
Service, app-launch and debug-stat operations use the runtime's provider table.

`ui.__viewport` comes from the admitted runtime geometry. The primary and
auxiliary UI roots belong to the same runtime instance, including for a
primary-only plan that uses the profile's bottom-screen defaults. No host shim
creates another retained tree.

## 2D bodies

The generated bindings expose `ui.physics` through the canonical operation
schema. Parameters, command records and events cross as little-endian f64 byte
buffers. **The runtime steps physics before building both DrawLists; one world
spans both screens.** The app chooses the bottom screen's origin in world space.
`apps/nexus` is the reference scene ([Physics](../../site/content/docs/physics.md)).

## PICA renderer and display outputs

`devices/3ds/pocket-3ds-pica/src/driver.c` implements the public Renderer and
DisplayOutput vtables. The shared DrawList visitor validates the complete stream
before invoking callbacks and supplies inherited clipping. The driver batches
adjacent operations with the same texture and scissor.

**Each pending screen submission owns its vertex storage and resource leases.**
Textures and guarded glyph pages are cached by handle, revision and page. A new
revision allocates new storage; pending submissions keep the prior version until
retirement. The default 16 MiB cache evicts unpinned least-recently-used entries;
capacity failure rejects a submission without releasing another screen's data.
Each submission has a 32,768-vertex and 2,048-command limit. The implementation
allocates its geometry storage per submission; hardware performance acceptance
remains part of the final device validation.

**Renderer wait establishes GPU completion with a blocking `C3D_FrameBegin` after
`C3D_FrameEnd`.** `C3D_FrameSync` alone only waits for VBlank. Display flush runs
synchronous transfers outside a native frame and swaps its own screen. The main
loop owns one shared VBlank boundary. In 2D mode the right-eye framebuffer aliases
the left one, so a display transfers the right target only when `gfxIs3D()` is true.
Camera and media textures are borrowed only during the serialized canonical tick;
the host updates them before the tick and teardown runs after terminal completion.

- Render targets are created **rotated**: `C3D_RenderTargetCreate(240, 400, …)`
  for the top screen, and `Mtx_OrthoTilt` keeps guest coordinates landscape.
  `C3D_FrameDrawOn` resets the viewport, so `C3D_SetViewport` comes after it.
- **The scissor register is in raw framebuffer pixels and both of its axes run
  opposite to the logical ones**: the horizontal pair counts down from the
  logical height, the vertical pair from the logical width. Flipping only one
  of them mirrors the clip along the other axis, which stays invisible until
  the clipped content is not already the size of its window.
- Textures must be power-of-two, 8..1024 per side, and **already in the
  hardware's tiled layout** — 8x8 tiles row-major, Morton order inside a tile.
  `C3D_TexUpload` is a plain `memcpy`. Non-power-of-two images get a
  power-of-two envelope and their UVs are rescaled.
- **Tiled row 0 is sampled at v = 1**, so the source is flipped vertically
  while it is tiled and DrawList UVs then pass through unchanged.
- **RGBA8 texels are stored bytes A, B, G, R** — the reverse of the core's
  order. Font atlases are **LA8, stored bytes A, L**: luminance 255 and the
  glyph coverage as alpha sample as the same white ink at half the bytes, and
  they are written into the texture's memory in one pass (a 512x1024 runtime
  glyph atlas took about 60 ms through the RGBA8 path on an Old 3DS).
- **Vertex buffers must live in `linearAlloc` memory** (`BufInfo_Add` rejects
  any pointer below physical `0x18000000`), and the arena is flushed out of the
  data cache before the draws that read it.
- There is **no fragment shader**: one TEV stage modulates the sampled texel by
  the vertex colour, and untextured ops bind an 8x8 white texture so that
  single stage covers every op. There is also **no paletted format**, so
  `PSM_T8` is expanded at upload.

## Capture and the Azahar loop

`-DPOCKETJS_CAPTURE` turns `main.c` into the e2e binary: input comes from a
tape baked into the binary rather than from the emulator's filesystem, the
frames in `[POCKETJS_CAP_START, POCKETJS_CAP_START + POCKETJS_CAP_N)` are read
back off the render target, and the process **parks instead of exiting** —
Azahar does not stop when the app returns from `main()`.

Emitted under `sdmc:/pocketjs-captures/`: `fNNNN.raw` named by the
process-global frame counter (exactly `400*240*4` bytes), then `done` written
only after the last frame is closed, and `error.txt` on the failure path so the
driver reports the message instead of a timeout.

The readback is **not** `gfxGetFramebuffer` after `C3D_FrameEnd` — that buffer
has already been swapped and reads back black. It is an explicit
`C3D_SyncDisplayTransfer` of the render target, after a vblank so the GPU has
finished. The bytes stay in the screen's rotated orientation, 240 wide by 400
tall, so the driver decodes `src[(x * 240 + (239 - y)) * 4]` into
`dst[y * 400 + x]` and reads the channels back as A, B, G, R.

**That transfer's output format is `GX_TRANSFER_FMT_RGB8`, and `main.c` widens
B, G, R into the A, B, G, R capture word itself.** Asking the transfer engine
for a 32-bit linear output out of this 240x400 tiled colour buffer returns rows
that are each individually correct and progressively misregistered — every
fourth output row slips a further 64 texels — while the same frame presents
perfectly on the screen. Azahar's software rasterizer answers the 32-bit request
correctly, so the wrong format is invisible until something renders through a
GPU: the identical build and the identical CIA both came back shredded under
Vulkan. Measured in the Pocket Voxel host against a known probe rectangle,
RGBA8 out matched 74.6% of it and RGB8 out matched 100.0%. RGB8 is also the
format citro3d's own presentation transfer uses, so the capture travels the path
the screen travels; the alpha byte it drops was never read, because the decode
takes R, G and B only.

```sh
bun tests/e2e/azahar.ts
```

**Azahar's two renderers agree on the picture but not on every byte.** With the
RGB8 readback in place, a Vulkan (`graphics_api=2`) capture of the demo differs
from the committed Software (`graphics_api=0`) goldens on **5.1% of pixels,
99.5% of them by 1 or 2 of 255** — the two rasterizers round texture filtering
and TEV blending differently — plus **24 pixels along the logo's one diagonal
edge**, by up to 157. A golden therefore still belongs to one backend, and the
e2e fixture pins it to Software, the backend that does not depend on the
developer's GPU driver. `E2E_AZAHAR_GRAPHICS_API=2 bun tests/e2e/azahar.ts`
re-measures the gap.

Azahar derives its whole user directory from `$HOME` and has no switch for any
part of it, so a run gets its own config and SD card by getting its own `$HOME`.

## Not advertised

`input.touch` is deliberately absent from the profile. The touchscreen belongs
to the **bottom auxiliary surface**, so it is exposed only as
`input.touch.auxiliary`; contacts are never remapped into the top screen's
coordinate space. `audio.pcm` is not implemented in v1.

The New 3DS C-stick is exposed as the optional right analog lane. Applications
read `rightAnalogX()` / `rightAnalogY()` from the framework lifecycle API, using
the same normalized axes and deadzone as the left stick. Older hardware returns
centered values. IRRST scanning stays in the host input adapter.

## Native QuickJS sources

`tools/3ds-toolchain.ts` prepares a verified QuickJS checkout through
`tools/native-source.ts`, shared with the BlackBerry native host. The 3DS pin
specifies a repository, full commit and source version. **Source preparation
does not resolve the PSP Cargo dependency graph.** `ensureQuickJs` calls this
preparation step before checking its compiler/source/image cache stamp.

Standalone native hosts can import `ensureQuickJsSources` to prepare the C
sources before a build. It has no guest compiler or package-manifest dependency.
The default checkout is `~/.cache/pocketjs/sources/quickjs-<revision>`; an existing
directory with a different revision, version or modified files is rejected.
