# BlackBerry Classic

PocketJS runs on the BlackBerry Classic (SQC100, BlackBerry 10.3) through
**the native QNX host in `hosts/blackberry-classic-qnx`**. It mounts the
no-std Rust UI core, GLES2 DrawList backend, and QuickJS bridge
(`engine/quickjs-c/pocket_runtime.c`) against one private device profile:
**720×720 physical, 360×360 logical at raster density 2, 60 Hz fixed
simulation time, `input.buttons`, `input.touch`, and `text.glyphs.baked`.**

| Property | Native QNX host |
| --- | --- |
| Process | BlackBerry 10 Core Native ELF: libscreen window, EGL, OpenGL ES 2, BPS event loop |
| Package | unsigned development BAR (`blackberry-nativepackager -devMode`) |
| Install requirement | **a rooted Classic**: a stock device accepts an unsigned development BAR with a BlackBerry debug token, and the service that issued tokens is retired |
| Input source | libscreen keyboard, multi-touch, and `SCREEN_EVENT_JOYSTICK` trackpad events; navigator system keys |
| Toolchain | digest-pinned BBNDK Docker image (compile, package, deploy) |
| Hardware status | **first device run recorded** (below) |
| Command | `bun blackberry-qnx …` |

The target stays outside `POCKET_TARGETS` until installation, boot,
presentation, touch, keyboard, trackpad, background/resume, and repeatable
delivery are all recorded.

## Device contract

`apps/blackberry-classic-demo` is the Hero wrapper the host builds.
`tools/blackberry-classic-profile.ts` registers **`blackberry-qnx-dev`,
host ABI 9**. The target id is compiled into the guest and native host and
checked at boot.

**Package identity comes from the resolved plan.** `plan.app` carries the
manifest's `id`, `title`, and `version`; `extractHostBuildInputs` hands them to
the host tool, and `packageIdentity` (`tools/native-host-build.ts`) maps them
onto the BAR: the package id is the manifest id with `-` replaced by `_`
(`dev.pocket_stack.blackberry_classic_demo`), the version string is used
verbatim, and `buildId` is `major·1 000 000 + minor·1 000 + patch`
(0.1.1 → 1001). `bar-descriptor.xml` contains `@POCKET_…@` placeholders
rendered at build time.

Input reaches the guest through the portable button mask and touch snapshot.
**The mask constants come from `contracts/generated/pocket_spec.h`, generated
from `contracts/spec/spec.ts` by `contracts/spec/gen-c.ts` and byte-compared by
`tests/contract.ts`.** The host feeds platform events into
`hosts/blackberry-classic/pocket_input.c`, the input state machine also used
by the Android host and tested with the host compiler in
`tests/pocket-input.test.ts`:

| Physical input | Portable input |
| --- | --- |
| trackpad movement | one d-pad focus pulse per threshold crossing of the accumulated motion, then the axis resets; QNX feeds the integer `SCREEN_PROPERTY_DISPLACEMENT` with threshold 1, so every non-zero event pulses |
| trackpad click | the press button (`CIRCLE`), held while the button is down, tracked apart from keys |
| Enter/Return, d-pad center | the press button |
| arrow keys | d-pad; a key down is one press edge, platform auto-repeat does not re-press |
| Space | `START` |
| Menu | `TRIANGLE` |
| Send (QNX navigator system key) | a one-shot press edge; End and Back stay with the system |
| touchscreen | one tracked contact (a second finger never becomes input), divided into 360×360 logical coordinates, with the host-resolved bounds hit fact; **a contact that went down and up between two frames still reports one down frame, and a release is reported at the next frame** |

The frame call is `pocket_runtime_tick(&input)` in
`engine/quickjs-c/pocket_runtime.c`: **one guest turn followed by one core tick
per presented frame** (docs/RUNTIMES.md, law 3), taking the mask, sampled
contact, and hit fact.

The Rust package is `pocketjs-ui-cabi` (`engine/ui-cabi`): the no-std C-ABI
build of `pocketjs-core` plus the GLES2 DrawList backend that the Nokia E7,
iPhone 2G/4S, and Meizu M8 hosts link. The Classic host builds it with the
`bare-platform` feature. **Its compatibility archive remains
`libpocketjs_symbian_core.a`, preserving the existing link input and C ABI.**
The build uses `hosts/blackberry-classic-qnx/armv7-qnx-eabi.json`
(ARMv7, VFPv3, soft-float ABI, PIC, `build-std`).

## Host requirements

The build tool needs Bun, git, `zip`/`unzip`, `patch`, Docker with a running
daemon, and rustup with **`nightly-2026-07-02`**:

```sh
rustup toolchain install nightly-2026-07-02 --profile minimal --component rust-src
```

`rust-src` feeds the QNX `build-std` link.
**QuickJS is `pocket-stack/quickjs-rs` at `ba5bdd0dc013518768e76cd9e05cd30ed53dd35b`
(version 2026-06-04)**. `setup` clones it under the tool's cache with
`--filter=blob:none`; builds reject a checkout at another revision or with
local changes.

**The unsigned BAR build has run on Linux x86-64 and macOS on Apple silicon
with the same commands.** Device installation from macOS has not been
exercised. The compiler, BAR packager, and `blackberry-deploy` run inside
`accupara/bbndk` (linux/amd64, pinned by digest, about 2.9 GB compressed).
On Apple silicon Docker Desktop runs that image under Rosetta for x86-64
and QEMU for the BBNDK's 32-bit x86 host tools. USB deployment (below) uses
`udevadm` and `ip route` on Linux; other hosts skip the interface check and
reach the device at the address in `POCKETJS_BLACKBERRY_DEVICE`.

The QuickJS checkout and Rust target directory live under
`~/.cache/pocket-stack/blackberry-qnx/`.

## Native QNX host

### Toolchain

`tools/cli/blackberry-qnx-toolchain.json` pins:

- BBNDK target API **10.3.1.995**, host tools **10.3.1.12**;
- `qcc` **GCC 4.8.3** for `armle-v7`;
- the `accupara/bbndk` image digest;
- the QuickJS revision and the Rust nightly and target spec.

The image's default entry point is an interactive shell for a different user;
the tool overrides the entry point, runs as the calling uid/gid, publishes no
ports, and compiles and packages with **container networking disabled**.

QuickJS needs two QNX-specific changes (`tools/blackberry-qnx/quickjs-qnx.patch`):
BlackBerry's C library has no `<stdatomic.h>`, so the single-threaded host
omits the Atomics intrinsic, and it has no `malloc_usable_size()`, so the
allocator reports usable size as zero.

```sh
bun blackberry-qnx setup     # pulls the image, clones QuickJS, runs doctor
bun blackberry-qnx doctor
bun blackberry-qnx build     # build-demo + build-runtime
```

`build-demo` resolves the manifest against `blackberry-qnx-dev`, writes the
plan to `.pocket/blackberry-qnx/`, and compiles the guest into
`dist/blackberry-qnx/guest/`. `build-runtime` builds the Rust core, compiles
QuickJS, `pocket_runtime.c`, and `hosts/blackberry-classic-qnx/main.c` with the plan's
target id, host ABI, raster density, and logical viewport, links the PIE ELF
against `libbps`, `libscreen`, `libEGL`, and `libGLESv2` with `--no-undefined`,
and packages the unsigned BAR from the rendered `hosts/blackberry-classic-qnx/bar-descriptor.xml`
template.
**The tool rejects a build whose ELF is not ARM, lacks the QNX dynamic loader
or one of the four libraries, whose BAR manifest does not carry the
plan-derived package name and version, or whose BAR embeds a different
executable than the one it linked.**

```text
dist/blackberry-qnx/pocketjs-blackberry-classic-hero.bar
dist/blackberry-qnx/build-receipt.json
```

The receipt records the resolved host contract, image digest, QuickJS and
Rust pins, build id, `readelf` output, and SHA-256 of every native input and
output.

### Install and device acceptance

Installing or launching changes device state and is not part of `build`.
Enable Development Mode on the Classic (Settings › Security and Privacy ›
Development Mode), which assigns the USB address `169.254.0.1`, then:

```sh
export POCKETJS_BLACKBERRY_DEVICE=169.254.0.1
export POCKETJS_BLACKBERRY_PASSWORD='device-password'   # omit when the rooted transport takes none
bun blackberry-qnx device-info
bun blackberry-qnx install        # -installApp -launchApp
bun blackberry-qnx device-status  # reads data/pocketjs-qnx.status from the app sandbox
```

On Linux the Classic appears as a CDC-NCM network interface (USB vendor
`0fca`); the tool refuses to deploy until that interface carries a link-local
route and prints the `sudo ip address replace 169.254.0.2/16 dev …` command
that adds one. `blackberry-deploy` runs in the same image with `--network
host`; **on Docker Desktop that is the Linux VM's network, so use the device's
Wi-Fi development address if the USB link-local address is unreachable.**

The host rewrites `data/pocketjs-qnx.status` whenever its content changes:
build id, lifecycle stage, frame count, raw keyboard and trackpad facts, event
totals, and the latest reported Hero action.

The first hardware run must show: the Hero fills the 720×720 display through
GLES2; the spinner and underline animate at the fixed 60 Hz step; a tap
activates the button; trackpad movement focuses it and a click activates it;
Enter and Send activate it; background and resume stop and restart
presentation without losing state; repeated installs keep a usable sandbox.

### First Classic hardware result

**BlackBerry Classic SQC100-4, BlackBerry 10.3.3.3216.** The unsigned
development BAR installed and launched through the rooted device transport.
The live status record confirmed:

- **720×720 GLES2 presentation with the 360×360 density-2 guest**;
- **2,747 rendered frames** across foreground, background, and resume;
- **12 touchscreen events**;
- **56 trackpad joystick events and 4 trackpad clicks**;
- **8 completed `hero_press` actions**.

This accepts native loading, the QuickJS and Rust runtime, rendering, touch,
trackpad navigation and click, and lifecycle resume. Physical keyboard
symbols, navigation-key policy, repeated upgrade delivery, and a captured
screen remain open, so the target stays private. **The input path changed
after that run** — the host now feeds the shared `pocket_input` state machine,
which reports a touch release at the next frame instead of one frame later
and ignores a second finger — **and the host was re-accepted on the same
device with that path** (`device-status`: tap, trackpad focus and click, and
release timing as specified).
