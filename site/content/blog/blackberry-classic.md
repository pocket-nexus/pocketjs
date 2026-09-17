<img class="w-full rounded-xl border border-line" src="/assets/blog/blackberry-classic-hero-720.png" alt="A real BlackBerry Classic on a wooden desk, its square screen running the PocketJS Hero demo: a PocketJS header with 60 FPS / 42 NODES / 9 DRAWS counters and 'ONE RUST CORE · ONE JSX APP', the headline 'JSX on Classic.', body text 'Flexbox, springs and baked type — running as a native BlackBerry 10 app.', a blue 'CLICK OR TAP' button, 'Count: 4', and 'Reactive on real hardware.' Below the square screen are the physical QWERTY keyboard and the tool belt with its optical trackpad." />

<p class="text-sm text-slate-500 -mt-4">The Hero demo running as a native BlackBerry 10 application on a real Classic — the square 720×720 screen above the tool belt and the physical keyboard.</p>

The BlackBerry Classic is a 2014 phone with a square screen, a physical QWERTY keyboard, an optical trackpad under your thumb, and a microkernel operating system underneath in which even the display server is an ordinary user-space process. It is also, in 2026, a phone you are **not allowed to install your own software on**: every legal route onto it runs through servers that went dark on January 4, 2022.

We got a freshly written app onto one anyway. If you are new here: [PocketJS](/blog/introducing-pocketjs/) runs real Solid and Vue components on machines with no browser and no OS UI toolkit, by pairing a no-std Rust core that owns the frame with a QuickJS guest that owns the app. On the Classic that pairing compiles into a BlackBerry 10 Core Native process which asks `libscreen` for a window, gets an OpenGL ES 2 context through EGL, and drives every frame from a BPS event loop, against one private device profile: **720×720 physical pixels, 360×360 logical, raster density 2, a fixed 60 Hz simulation clock, `input.buttons` + `input.touch` + `text.glyphs.baked`**.

Everything above the QuickJS bridge (`engine/quickjs-c/pocket_runtime.c`, also linked by the iPhone 2G/4S and Meizu M8 hosts) is the same code every other PocketJS target runs. Everything the Classic cost us is below it, and almost none of that cost was graphics. It was **getting in**: a phone that carried security to the point where, in 2026, native development is nearly impossible; a community root project that pushed that door back open; the "everything is the network" way a BlackBerry talks to a computer; and a genuinely archaeological pair of protocols — **management and updates over HTTPS + CGI + XML/form-data, file management over SMB/CIFS** — so you can mount the phone's filesystem on your computer and manage it like local files.

## The machine

<svg viewBox="0 0 760 300" width="100%" role="img" aria-label="BlackBerry Classic (SQC100 / Q20, December 2014) specifications. Screen: 3.5 inch, 720 by 720 square, about 294 ppi. SoC: Qualcomm Snapdragon S4 Plus MSM8960, dual 1.5 GHz Krait, Adreno 225. Memory: 2 GB RAM, 16 GB plus microSD. OS: BlackBerry 10.3.3 on QNX, which reports itself as QNX 8.0.0. Input: physical QWERTY keyboard plus a tool belt with an optical trackpad and four keys. For PocketJS: a 360 by 360 logical viewport at raster density 2 scaled to 720 by 720, 60 Hz, button and touch contracts. The guest reaches the phone as an unsigned QNX BAR installed on a rooted Classic, with no BlackBerry server anywhere in the loop." font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <text x="14" y="20" fill="#64748b" font-size="11">BLACKBERRY CLASSIC · SQC100 / Q20 · DECEMBER 2014</text>
  <rect x="14" y="34" width="732" height="222" rx="10" fill="#0b0f1a" stroke="#2b3a55"/>
  <g font-size="12">
    <text x="34" y="66" fill="#64748b">Screen</text><text x="150" y="66" fill="#e2e8f0">3.5″ · 720×720 · ~294 ppi · 1:1 square</text>
    <line x1="34" y1="80" x2="726" y2="80" stroke="#1e293b"/>
    <text x="34" y="100" fill="#64748b">SoC</text><text x="150" y="100" fill="#e2e8f0">MSM8960 Snapdragon S4 Plus · 2×1.5 GHz Krait · Adreno 225</text>
    <line x1="34" y1="114" x2="726" y2="114" stroke="#1e293b"/>
    <text x="34" y="134" fill="#64748b">Memory</text><text x="150" y="134" fill="#e2e8f0">2 GB RAM · 16 GB + microSD</text>
    <line x1="34" y1="148" x2="726" y2="148" stroke="#1e293b"/>
    <text x="34" y="168" fill="#64748b">OS</text><text x="150" y="168" fill="#e2e8f0">BlackBerry 10.3.3 · QNX-based (reports QNX 8.0.0)</text>
    <line x1="34" y1="182" x2="726" y2="182" stroke="#1e293b"/>
    <text x="34" y="202" fill="#64748b">Input</text><text x="150" y="202" fill="#e2e8f0">physical QWERTY + tool belt (optical trackpad + Menu/Back/Send/End)</text>
  </g>
  <rect x="26" y="216" width="708" height="30" rx="6" fill="#0c1a22" stroke="#22d3ee"/>
  <text x="34" y="235" fill="#22d3ee" font-size="12">PocketJS</text><text x="150" y="235" fill="#e2e8f0" font-size="12">360×360 @density 2 → 720×720 · 60 Hz · input.buttons + input.touch</text>
  <text x="14" y="278" fill="#64748b" font-size="10.5">How the guest gets on: <tspan fill="#22d3ee">unsigned QNX BAR</tspan> on a rooted Classic · <tspan fill="#38bdf8">no debug token, no signing server</tspan></text>
</svg>

The BlackBerry Classic (model SQC100, codename Q20) shipped in December 2014 as BlackBerry looking back in the all-touch era: it put the familiar physical shape from around 2011 back on. A full physical QWERTY keyboard, a navigation strip above it called the **tool belt** (Menu / Back / Send / End, with an optical trackpad in the middle), and a **square** screen.

- **Screen**: 3.5 inches, **720×720**, about 294 ppi. The square screen is a BlackBerry keyboard-phone tradition — the display gives way to the keyboard, so its width equals its height. For us, square means the logical viewport is a square 360×360, scaled at raster density 2 to 720×720.
- **SoC**: Qualcomm Snapdragon S4 Plus **MSM8960**, dual-core 1.5 GHz Krait, Adreno 225 GPU.
- **Memory / storage**: 2 GB RAM, 16 GB storage, microSD slot.
- **OS**: BlackBerry 10.3, built on QNX; the unit we verified runs **10.3.3.3216**, the last generation of BB10 firmware.

In the family of PocketJS targets the Classic is not weak — it has far more compute than the PSP or the Symbian E7. What makes it hard was never performance. It is **what you are allowed to do to get code onto it**.

## One guest, one thin host

Before the archaeology, the whole shape of the port in one picture.

<svg viewBox="0 0 760 482" width="100%" role="img" aria-label="The shape of the BlackBerry Classic port: one guest bundle over one thin QNX host. From the top, three portable layers: the guest bundle, an ordinary Solid TSX app in apps slash blackberry-classic-demo; the no-std Rust core with its GLES2 DrawList backend, the same one the Nokia E7, iPhone 2G and 4S, and Meizu M8 hosts link; and the QuickJS bridge, which runs one guest turn followed by one core tick. A dashed seam marks the QuickJS bridge as the boundary: everything above it is identical to every other PocketJS target. Below the seam sits the part written for this phone: a libscreen window bound to an EGL GLES2 surface; a BPS event loop feeding the shared pocket_input state machine, which turns screen and navigator events into a button mask and a touch snapshot; and the nativepackager step that produces an unsigned development BAR installed on a rooted Classic. The bottom layer presents 720 by 720 through eglSwapBuffers at 60 hertz, square and unscaled." font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <text x="14" y="20" fill="#64748b" font-size="11">ONE GUEST · ONE THIN HOST · the seam is the QuickJS bridge</text>
  <rect x="14" y="34" width="732" height="416" rx="10" fill="#0b0f1a" stroke="#2b3a55"/>
  <g font-size="11">
    <rect x="40" y="54" width="418" height="44" rx="6" fill="#0c1a22" stroke="#22d3ee"/>
    <text x="249" y="73" fill="#e2e8f0" text-anchor="middle">Guest bundle · Solid + TSX</text>
    <text x="249" y="88" fill="#22d3ee" text-anchor="middle" font-size="9.5">apps/blackberry-classic-demo</text>
    <text x="474" y="80" fill="#64748b" font-size="9.5">portable · knows nothing about QNX</text>

    <rect x="40" y="106" width="418" height="44" rx="6" fill="#0c1a22" stroke="#22d3ee"/>
    <text x="249" y="125" fill="#e2e8f0" text-anchor="middle">no-std Rust core + GLES2 DrawList</text>
    <text x="249" y="140" fill="#22d3ee" text-anchor="middle" font-size="9.5">engine/ui-cabi · bare-platform</text>
    <text x="474" y="132" fill="#64748b" font-size="9.5">portable · E7 · iPhone 2G/4S · M8</text>

    <rect x="40" y="158" width="418" height="44" rx="6" fill="#0c1a22" stroke="#22d3ee"/>
    <text x="249" y="177" fill="#e2e8f0" text-anchor="middle">QuickJS bridge</text>
    <text x="249" y="192" fill="#22d3ee" text-anchor="middle" font-size="9.5">one guest turn + one core tick</text>
    <text x="474" y="184" fill="#64748b" font-size="9.5">portable · pocket_runtime.c</text>
  </g>
  <line x1="32" y1="216" x2="418" y2="216" stroke="#22d3ee" stroke-dasharray="5 4" opacity="0.7"/>
  <text x="430" y="220" fill="#22d3ee" font-size="9.5">everything above: portable across targets</text>
  <g font-size="11">
    <rect x="40" y="230" width="418" height="44" rx="6" fill="#0e1626" stroke="#38bdf8"/>
    <text x="249" y="249" fill="#e2e8f0" text-anchor="middle">libscreen window + EGL / GLES2</text>
    <text x="249" y="264" fill="#64748b" text-anchor="middle" font-size="9.5">screen_create_window → eglCreateWindowSurface</text>
    <text x="474" y="256" fill="#a3e635" font-size="9.5">new · main.c, 547 lines</text>

    <rect x="40" y="282" width="418" height="44" rx="6" fill="#0e1626" stroke="#38bdf8"/>
    <text x="249" y="301" fill="#e2e8f0" text-anchor="middle">BPS event loop → pocket_input.c</text>
    <text x="249" y="316" fill="#64748b" text-anchor="middle" font-size="9.5">screen + navigator events → buttons + touch</text>
    <text x="474" y="308" fill="#64748b" font-size="9.5">shared state machine, unit-tested</text>

    <rect x="40" y="334" width="418" height="44" rx="6" fill="#0e1626" stroke="#38bdf8"/>
    <text x="249" y="353" fill="#e2e8f0" text-anchor="middle">nativepackager -devMode → unsigned BAR</text>
    <text x="249" y="368" fill="#64748b" text-anchor="middle" font-size="9.5">installed on a rooted Classic</text>
    <text x="474" y="360" fill="#a3e635" font-size="9.5">new · toolchain + deploy glue</text>

    <rect x="40" y="386" width="418" height="44" rx="6" fill="#14251d" stroke="#65a30d"/>
    <text x="249" y="405" fill="#d9f99d" text-anchor="middle">720×720 present · eglSwapBuffers</text>
    <text x="249" y="420" fill="#84a35b" text-anchor="middle" font-size="9.5">square panel, 1:1, 60 Hz</text>
    <text x="474" y="412" fill="#64748b" font-size="9.5">no stretch, no scale</text>
  </g>
  <path d="M249 98 V106 M249 150 V158 M249 202 V216 M249 216 V230 M249 274 V282 M249 326 V334 M249 378 V386" stroke="#475569"/>
  <text x="14" y="472" fill="#64748b" font-size="10">One new process is the entire port. Nothing above the bridge is Classic-specific.</text>
</svg>

|  | The QNX host: `hosts/blackberry-classic-qnx` |
| --- | --- |
| Process | BlackBerry 10 Core Native ELF: `libscreen` window, EGL, OpenGL ES 2, BPS event loop |
| Package | **unsigned** development BAR (`blackberry-nativepackager -devMode`) |
| Install prerequisite | **a rooted Classic**: a stock device accepts an unsigned BAR only with a debug token, and the token-issuing service is gone |
| Input source | libscreen keyboard, multi-touch, `SCREEN_EVENT_JOYSTICK` trackpad events; navigator system keys |
| Toolchain | a digest-pinned BBNDK Docker image (compile, package, deploy) |
| Device status | **verified on real hardware**: an SQC100-4 at 10.3.3.3216 |

`apps/blackberry-classic-demo` is the Hero wrapper this host builds, and the profile module (`tools/blackberry-classic-profile.ts`) registers the target `blackberry-qnx-dev`: **host ABI 9**, `takeover` form, one 720×720 display at raster density 2, and exactly three capabilities. That target id is compiled into the guest bundle *and* into the native host, and checked when the guest mounts, so a bundle built for any other machine refuses to start rather than half-running.

The Rust package is `pocketjs-ui-cabi` under `engine/ui-cabi`: the no-std C-ABI build of `pocketjs-core` plus the GLES2 DrawList backend the Nokia E7, iPhone 2G/4S, and Meizu M8 hosts all link. Its compatibility archive is still `libpocketjs_symbian_core.a`. The Classic builds it with the `bare-platform` feature against a hand-written target spec (`hosts/blackberry-classic-qnx/armv7-qnx-eabi.json`: ARMv7 + VFPv3 + NEON, soft-float ABI, PIC, `build-std`). Note the spec says `"os": "none"` — the core asks the operating system for nothing at all, so as far as Rust is concerned it is a bare-metal build that happens to get linked into a QNX process.

In other words, **the code this port actually adds is very thin**: one 547-line `main.c`, the shared input state machine it feeds (`pocket_input.c`, 115 lines, already unit-tested before BlackBerry existed as a target), a 33-line BAR descriptor, a 24-line target spec, and a deploy tool that has to go find the phone on the network. The core, the renderer, the fonts, the reactivity: not a byte of it changed for BlackBerry.

The guest side is thinner still: an ordinary Solid component that knows nothing about what is underneath it.

```tsx
import Hero from "../hero/app.tsx";
import { reportAppAction } from "@pocketjs/framework/host";

// Nothing in here is allowed to know that QNX, libscreen or EGL exist.
export default function BlackBerryClassicHero() {
  return (
    <Hero
      headline="JSX on Classic."
      deviceLabel="running on a BlackBerry Classic."
      actionLabel="CLICK OR TAP"
      runtimeLabel="RUST + QUICKJS + GLES2"
      presentationHz={60}
      spinnerFrameStep={6}
      onAction={(count) => reportAppAction("hero_press", count)}
    />
  );
}
```

That `reportAppAction("hero_press", …)` writes each press into a line of status inside the device sandbox: from a tap in TSX, through an entire native stack, to a record on the phone. Not one line of it is Classic-specific.

## A phone that carved distrust into every layer

BlackBerry's seriousness about security is the kind that stops a developer who just wants to run a demo dead in their tracks.

On BB10, a native `.bar` application has only two legal ways onto a stock device:

- **Release**: sign the BAR with keys issued by BlackBerry's signing authority (RDK/PBDT, later the BlackBerry ID token). Signing is online — you trade for it against BlackBerry's servers.
- **Development**: put the device in Development Mode and install a **debug token** — a credential signed by BlackBerry's servers, **bound to the device PIN and valid for 30 days**. Only then will the device run an unsigned `-devMode` BAR. When the token expires, unsigned apps stop running and you have to go ask the servers for a new one.

The design was coherent for its time: even a developer's local debugging needs a time-limited, device-bound, officially blessed pass, and malware has almost nowhere to stand. But it has one fatal premise for its era — **BlackBerry's online services have to be alive**.

They are not. BlackBerry gave notice back in September 2020: **after January 4, 2022**, the whole set of legacy services for BB7-and-earlier, BB10, and PlayBook OS 2.1-and-earlier would shut down. That did not just cut off data, calls, and texts — **the signing authority, debug-token issuance, BlackBerry ID, BlackBerry Link, and BlackBerry Blend all went with it**.

So in 2026 a stock Classic is caught in a deadlock: to install an unsigned development BAR you need a debug token, and the server that issues tokens went dark four years ago. Release signing is the same — that path leads to a server that no longer exists. **Through official channels, you cannot install a single application you wrote onto a stock BlackBerry 10 device.**

### The project that reopened the door

Then, not long ago, someone pushed the door back open.

<https://bb10.root.sx> is a project called **"BlackBerry 10 root and more"**, credited to **Oleksandr** (handle `bb10root`), with **guizmox** and **sw7ft** among those who contributed and supported it. It uses known vulnerabilities in BB10 to get **root** on the device and — the part that matters most to us — **bypasses the BAR signature check so unsigned `.bar` files install directly** (one of its routes exploits the `install_apk` command path skipping the bar signature check, plus packages with certain prefixes skipping verification). It has publicly verified 10.3.3.3216 — the firmware on the unit in our hands.

Our host reaches the device exactly this way. `blackberry-nativepackager -devMode` produces an unsigned BAR, `blackberry-deploy` pushes it to a rooted Classic, installs it, and launches it. No debug token, no signing authority, not a single living BlackBerry server anywhere in the loop.

The people who do this kind of work usually get nothing back for it. They reverse-engineer a platform its own maker has sentenced to death, to serve a small group of people still tinkering with these old machines. And yet it is exactly that work that lets a square-screened 2014 phone run freshly written code in 2026.

**A salute to the developers who put this work in.** Without bb10.root.sx this post would not exist at all. It would be stuck forever at "the build passes, but it installs on no real device."

## Everything is the network: how the phone talks to a computer

Plug the Classic into USB expecting a storage disk, and what shows up on the computer instead is **a network adapter**.

This is BlackBerry 10's default way of talking to a computer: the device's USB function enumerates as a CDC-NCM Ethernet adapter (USB vendor `0x0fca` — Research In Motion). In Development Mode the device puts itself at the link-local address **`169.254.0.1`** and the computer takes `169.254.0.2`. Everything after that — device info, installing apps, backup, OS updates, debugging — **all runs over that USB-Ethernet link, over HTTP/HTTPS**. ("Connect to Windows" mode switches the adapter to RNDIS so Windows' native driver can take over; the standard/Mac mode is CDC-NCM/ECM.)

Our deploy tool follows exactly that path. On Linux, `tools/blackberry-qnx.ts` first uses `udevadm` to find the adapter whose vendor is `0fca` and whose driver is `cdc_ncm`, confirms it carries a `169.254.x` link-local route, and only then pushes the BAR; if the route is missing it simply prints `sudo ip address replace 169.254.0.2/16 dev …` for you to add. The `blackberry-deploy` that does the real work runs inside the BBNDK image with `--network host`, reaches the device's development service over `169.254.0.1`, and `-installApp -launchApp` installs and launches.

**Debugging is the network, too.** Turn on Development Mode and the device starts a **`qconnDoor`** service **listening on TCP 4455** with challenge-response authentication; `blackberry-connect` / `blackberry-deploy` all connect to the device IP, and SSH runs on port 22 where only the unprivileged `devuser` account can log in. That underlying channel is a binary protocol over TCP with an RSA-1024 challenge and an AES-128-CBC session (in the reverse-engineered tooling the permission handshake is literally named `QCONNDOOR_PERMISSIONS`). No serial cable, no adb — to a computer, a BlackBerry is first of all a host on the network.

## BlackBerry Link, and a little protocol archaeology

To manage the files on the device, the official tool is **BlackBerry Link**. It is nice, but for us in 2026 on an Apple Silicon Mac it is basically a relic:

- **Link only ships for Windows and macOS.** The macOS build stopped at **1.2.1 (April 2014)**, requires OS X 10.7+, and is **32-bit Intel**. Apple stopped running 32-bit binaries as of macOS Catalina (10.15) — so on today's macOS 26.6 on Apple Silicon **it simply will not launch**. The Windows build went a little further, to 1.2.3.56 (June 2014), and stopped there.
- **Even if you have an old machine that can run Link, its servers are gone.** Per BlackBerry's own EOL notice, after January 4, 2022 the "download system is no longer available," and Link/Blend/Desktop Manager/BlackBerry World were reduced to "limited functionality." Anything that depends on the official servers — downloads, updates — is dead.

Fortunately the community left reverse-engineered tools behind. The archetype is **Sachesi** — a cross-platform tool by **Sacha Refshauge (GitHub `xsacha`)**, GPL-3.0, formerly "Dingleberry," open-sourced in May 2014. It searches, downloads, and extracts firmware; installs and uninstalls `.bar`; backs up and restores; wipes; reboots; reads device info — and it needs **no Development Mode**. It is written in Qt and still builds and runs from source today on Apple Silicon with a current Qt — which is how we read its source and saw the protocol clearly.

And once you do see the protocol clearly, something interesting shows up: **BlackBerry uses two completely different protocols for "device management" and "file management."**

### Management and updates: HTTPS + CGI + XML

Device info, installing apps, backup, OS updates — this class of operation runs over an **HTTPS + CGI** interface: requests go to `/cgi-bin/*.cgi` on the device, and **every response is XML rooted at `<RimTabletResponse>`**. A few of the key endpoints:

- `discovery.cgi` (plaintext HTTP:80): returns `<DeviceCharacteristics>` — PIN, model, `OsType`, `PlatformVersion`, `DeveloperModeEnabled`, and so on.
- `login.cgi` (HTTPS:443): a challenge-response login. The device answers with an `<AuthChallenge>` (`Salt`, `Challenge`, iteration count `ICount`); the client runs **iterated SHA-512** (hashing `counter ∥ salt ∥ password` repeatedly, folding the challenge in on the last round) and sends the result back.
- `dynamicProperties.cgi`: `POST` a `Get Dynamic Properties=Get Dynamic Properties` form and get back the list of every application on the device (os/radio/application), the battery level, `HardwareID`, and more.
- `update.cgi`: this is how a `.bar` gets installed. First `POST` an `application/x-www-form-urlencoded` `mode=bar&size=<bytes>` to start the install; the device answers `<UpdateStart>`; then the client POSTs the **raw bytes of the `.bar` directly as the body**, and the device drives it with a run of `<UpdateProgress>` (each with a `<Status>` and a percentage), finishing with `<UpdateEnd>`.

Laid out, a single `.bar` install looks like this (endpoints, fields, and XML shapes taken from Sachesi's implementation):

```text
# 1) Start the install: form-encoded, declaring the mode and total size
POST /cgi-bin/update.cgi        Content-Type: application/x-www-form-urlencoded
mode=bar&size=4193095
    → <RimTabletResponse><UpdateStart>…</UpdateStart></RimTabletResponse>

# 2) POST the raw .bar bytes as the body (note: not multipart)
POST /cgi-bin/update.cgi?type=bar   Content-Type: application/octet-stream
<…raw .bar bytes…>

# 3) The device drives progress with a run of XML until it finishes
    → <RimTabletResponse><UpdateProgress><Status>InProgress</Status><Progress>42</Progress></UpdateProgress></RimTabletResponse>
    → <RimTabletResponse><UpdateProgress><Status>InProgress</Status><Progress>88</Progress></UpdateProgress></RimTabletResponse>
    → <RimTabletResponse><UpdateEnd><Status>Success</Status></UpdateEnd></RimTabletResponse>
```

(One small correction so "form-data" doesn't mislead you: **the kickoff request is form-encoded, but the actual body is a raw octet-stream, not multipart.** The skeleton of "HTTPS + CGI + XML responses + a form kickoff" is right.) These tools also spoof their `User-Agent` as `QNXWebClient/1.0` and **deliberately ignore TLS certificate errors** — because the device uses a self-signed certificate. The login step (`login.cgi`) is a challenge-response: the device returns an `<AuthChallenge>` carrying a `Salt` and iteration count, and the client hashes `counter ∥ salt ∥ password` with **iterated SHA-512**, folds the challenge in on the last round, and sends the result back.

### File management: SMB/CIFS, mountable directly

For "manage the files on the device," BlackBerry switches to a completely different protocol: **SMB/CIFS**. The device runs an SMB service (it identifies as **Samba 3.0.x** — and note, it runs on **QNX**, not Linux; people who sniffed the traffic years ago saw Samba and assumed Linux, which is wrong) listening on ports **139/445**, exporting a few shares:

- **`media`**: internal user storage;
- **`removeable_sdcard`** (yes, the device misspells "removable"): present only when an SD card is inserted;
- **`certs`**: certificates.

The username is set on the device under **Settings → Storage and Access → "Identification on Network"**, and the password is the **"Wi-Fi storage password"** there. It works over both USB and Wi-Fi.

Which means something genuinely nice: **you can mount the BlackBerry's filesystem straight onto your computer and manage it like local files.** On macOS, `smb://169.254.0.1/media` in Finder connects; on Linux:

```sh
sudo mount -t cifs //169.254.0.1/media /mnt/bb \
  -o user=<network-identification-user>,password=<wifi-storage-password>,vers=1.0,sec=ntlm
```

(Because the other end is SMB1-era Samba 3.0.37 and modern kernels disable SMB1 by default, you have to add `vers=1.0` explicitly.) A 2014 phone, and its filesystem is just a drive on your desktop.

## MSC, and the MTP that was never chosen

BlackBerry also supports USB Mass Storage (MSC), but sparingly: **it exposes only the external SD card as an MSC block device**, never the internal storage.

And there is a knock-on limit: **once the SD card is enumerated as MSC, the SMB file management above can no longer mount that card.** The reason is not BlackBerry but MSC itself — **MSC is fundamentally a "dumb" block-device protocol** (Bulk-Only Transport + SCSI commands) that hands the computer **exclusive block-level ownership** of the whole device. The filesystem layer can have only one owner: either the computer has it mounted or the phone does, never both. So the moment MSC is on, the card has to be unmounted on the phone side, and the phone's apps — and the SMB path — can no longer see it.

The period comparison is the interesting part. On most Android devices of that era, **MTP** was already the norm — and MTP works at the **file-object** layer, not the block layer, so a phone can expose files to the computer while it keeps reading and writing the same storage itself, and it can expose internal storage without switching to a block device. BlackBerry had a more modern option available and **did not pick MTP**, going instead with "SMB for internal storage + MSC for the SD card only." Why exactly, I could not find an official statement; but the result is that to fully manage this device's files you go over the network with SMB, not by plugging in USB as a thumb drive.

## QNX's graphics, and a different design philosophy

To understand why this phone is "everything is the network, everything is a service," you have to start with the QNX underneath it.

QNX is a **microkernel** real-time operating system, built in 1980 by Quantum Software Systems (Dan Dodge and Gordon Bell) in Kanata, Canada (first commercial release in 1982, renamed QNX in 1984). It goes the opposite way from the **monolithic** kernels you know, Linux/XNU: **the kernel itself (`procnto`) is tiny**, doing only a few things — CPU scheduling, **synchronous message passing** (`MsgSend`/`MsgReceive`/`MsgReply`), interrupt redirection, timers. The filesystem, the network stack, device drivers, **and even the graphics** are all ordinary **user-space processes**.

This has two consequences. First, **isolation**: when a driver crashes, only a user-space process crashed — it can be restarted, the kernel is untouched. This is exactly why QNX runs in cars, medical devices, industrial control, and routers — places that "can't die" (over 275 million vehicles run QNX today; it is exactly what RIM wanted — Harman bought QNX in 2004, RIM bought it from Harman in April 2010 — which is how there came to be a PlayBook and BB10). Second, **everything is a message**: opening a device, reading a file, asking for a display buffer — underneath, all of it is sending a message to some user-space **service process**. QNX registers those services as **pathnames** in one unified namespace (a resource manager), so it is very "Unix" at heart, but implemented as client-server message round-trips:

```c
// Client: send a message, then block until the server replies. That is almost
// the whole of QNX IPC.
MsgSend(server_conn, &request, sizeof request, &reply, sizeof reply);

// Server (in another process): receive, do the work, reply.
int rcvid = MsgReceive(channel, &request, sizeof request, NULL);
/* …do the work… (open/read/write on a device is exactly this round-trip) */
MsgReply(rcvid, EOK, &reply, sizeof reply);
```

The `open()`/`read()` you write in POSIX get translated by the C library into a `MsgSend` like this, sent to the user-space service that registered the matching pathname. The kernel's only job is to move the message from one process to another — even the filesystem and the network card live outside it.

Graphics is the same model. BB10's windowing and composition is handled by the **Screen graphics subsystem** (`libscreen`) — `screen` is itself a user-space service (it exposes pathnames under `/dev/screen`, exactly the resource-manager pattern) that owns the displays, the display pipelines, and composition. Applications are its clients:

- An app creates a `screen_context_t`, a `screen_window_t`, allocates buffers (`screen_create_window_buffers`), and then either draws into them with the CPU and calls `screen_post_window`, or binds the buffers to EGL and draws with OpenGL ES — **our QNX host takes the latter**: `libscreen` window + EGL + GLES2.
- What actually stacks all the windows into the final image is the `screen` **compositor** service, using hardware display layers/overlays where it can and falling back to GPU composition when it can't. (One detail that happens to apply to us: in the official docs, when the whole screen has only one fullscreen application, Screen **bypasses composition entirely** — and our host is exactly one fullscreen takeover application.)
- And a very BB10 concept: **window groups** (`screen_create_window_group` / `screen_join_window_group`). One process can embed **another process's window** inside its own. Video, Cascades child windows, **and even the entire Android runtime's window** are composited into the picture this way — the system shell (the **navigator** process) owns top-level composition, and applications "join" its group.

<svg viewBox="0 0 760 360" width="100%" role="img" aria-label="The QNX Screen graphics subsystem on BlackBerry 10. Several clients each render into their own off-screen buffer: the native app window (our QNX host, using EGL and GLES2), the Cascades scene graph (drawn on its own rendering thread), and the entire Android runtime as a single window. The navigator shell owns the top-level window group they join. The screen compositor service, which owns the displays and display pipelines, combines all the visible window buffers into one final image using hardware overlays or the GPU, and bypasses composition entirely when only one fullscreen application is present. The result is one 720 by 720 final frame on the panel. Clients only ever draw into their own buffer; combining them into a screen is the screen service's job." font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <text x="14" y="20" fill="#64748b" font-size="11">QNX SCREEN · every window is an off-screen buffer; compositing is a service's job</text>
  <rect x="14" y="34" width="732" height="312" rx="10" fill="#0b0f1a" stroke="#2b3a55"/>
  <rect x="32" y="58" width="696" height="70" rx="7" fill="none" stroke="#475569" stroke-dasharray="4 4"/>
  <text x="40" y="52" fill="#64748b" font-size="10">Window group · navigator (shell) owns top-level composition · each client draws into its own buffer</text>
  <g font-size="10.5">
    <rect x="44" y="66" width="210" height="54" rx="6" fill="#0c1a22" stroke="#22d3ee"/><text x="149" y="88" fill="#e2e8f0" text-anchor="middle">native app window</text><text x="149" y="106" fill="#22d3ee" text-anchor="middle" font-size="9.5">our QNX host · EGL/GLES2</text>
    <rect x="275" y="66" width="210" height="54" rx="6" fill="#0e1626" stroke="#38bdf8"/><text x="380" y="88" fill="#e2e8f0" text-anchor="middle">Cascades scene</text><text x="380" y="106" fill="#64748b" text-anchor="middle" font-size="9.5">scene graph · own render thread</text>
    <rect x="506" y="66" width="210" height="54" rx="6" fill="#0e1626" stroke="#38bdf8"/><text x="611" y="88" fill="#e2e8f0" text-anchor="middle">Android runtime window</text><text x="611" y="106" fill="#64748b" text-anchor="middle" font-size="9.5">all of Android = one QNX process</text>
  </g>
  <path d="M149 120 V170 M380 120 V170 M611 120 V170" stroke="#475569"/>
  <path d="M149 170 l-4 -7 M149 170 l4 -7 M380 170 l-4 -7 M380 170 l4 -7 M611 170 l-4 -7 M611 170 l4 -7" stroke="#475569" fill="none"/>
  <rect x="40" y="170" width="680" height="58" rx="7" fill="#0c1a22" stroke="#22d3ee"/>
  <text x="380" y="192" fill="#f1f5f9" text-anchor="middle" font-size="12" font-weight="700">screen compositor service</text>
  <text x="380" y="212" fill="#22d3ee" text-anchor="middle" font-size="9.5">owns displays &amp; pipelines · composites via HW overlays or GPU · bypasses composition for one fullscreen app</text>
  <path d="M380 228 V258" stroke="#475569"/><path d="M380 258 l-4 -7 M380 258 l4 -7" stroke="#475569" fill="none"/>
  <rect x="230" y="262" width="300" height="52" rx="7" fill="#0e1626" stroke="#38bdf8"/>
  <text x="380" y="284" fill="#e2e8f0" text-anchor="middle" font-size="12">720×720 panel</text><text x="380" y="302" fill="#64748b" text-anchor="middle" font-size="9.5">one final frame</text>
  <text x="14" y="338" fill="#64748b" font-size="10">Clients draw only into their own buffer; combining them into one screen is the screen service's job.</text>
</svg>

Our host takes the most direct path in there: ask `screen` for a window, bind its buffer to EGL, and then draw purely with GLES2. Condensed, the bring-up looks like this:

```c
/* 1) Ask the screen service for a context; EGL gets a GLES2 context */
screen_create_context(&screen_ctx, SCREEN_APPLICATION_CONTEXT);
egl_display = eglGetDisplay(EGL_DEFAULT_DISPLAY);
eglInitialize(egl_display, NULL, NULL);
eglBindAPI(EGL_OPENGL_ES_API);
eglChooseConfig(egl_display, config_attrs, &config, 1, &n);
egl_context = eglCreateContext(egl_display, config, EGL_NO_CONTEXT,
    (EGLint[]){ EGL_CONTEXT_CLIENT_VERSION, 2, EGL_NONE });

/* 2) Create the window, open our own window group, configure it as one
      720×720 double-buffered GLES2 target */
screen_create_window(&screen_win, screen_ctx);
screen_create_window_group(screen_win, group_name);
screen_set_window_property_iv(screen_win, SCREEN_PROPERTY_FORMAT, &format);
screen_set_window_property_iv(screen_win, SCREEN_PROPERTY_USAGE,  &(int){ SCREEN_USAGE_OPENGL_ES2 });
screen_set_window_property_iv(screen_win, SCREEN_PROPERTY_BUFFER_SIZE, (int[]){ 720, 720 });
screen_create_window_buffers(screen_win, 2);

/* 3) Bind that window buffer as an EGL surface; from here it's just GLES2 */
egl_surface = eglCreateWindowSurface(egl_display, config, screen_win, NULL);
eglMakeCurrent(egl_display, egl_surface, egl_surface, egl_context);
eglSwapInterval(egl_display, 1);   /* follow vsync */
```

Notice the "window" is, all the way through, **a buffer you asked a service for** — not a slab of video memory the kernel handed you. That is exactly what the resource-manager model looks like when applied to graphics.

In this architecture, events arrive through **BPS** (BlackBerry Platform Services): a C library that folds screen, navigator, sensors, and the rest into a **single event queue**. Our host uses it in the plainest possible way — `bps_initialize()`, register for screen and navigator events, then loop on `bps_get_event`. Window activate/deactivate, orientation, exit, and system keys all arrive as events from the navigator shell process. (System state lives in a separate mechanism, **PPS** — a pile of readable/writable "objects" under `/pps`, where writing publishes and reading subscribes.)

Our main loop is plain, too — **drain everything currently queued, then run exactly one frame**:

```c
while (!app_shutdown) {
  int timeout = app_active ? 0 : -1;   /* foreground: take without blocking; background: block for a wake */
  bps_get_event(&event, timeout);
  handle_event(event);                 /* screen (touch/keys/trackpad) + navigator (lifecycle/system keys) */

  if (app_active) {
    do {                               /* drain everything still queued this instant… */
      bps_get_event(&event, 0);
      handle_event(event);
    } while (event != NULL);
    render_frame();                    /* …then advance exactly one 60 Hz tick, then eglSwapBuffers */
  }
}
```

This design philosophy is quite unlike the other mobile systems of the era:

- **iOS / Android** are built on monolithic kernels (XNU / Linux), the display driver lives in the kernel, the app's main thread drives UIKit / the view system directly, and a system compositor (iOS's render server, Android's SurfaceFlinger) puts it all on screen.
- **QNX / BB10** breaks all of that into message round-trips between user-space services; graphics is "just another service," and cross-process **window-group composition** is a first-class citizen. It carries the **isolation-and-determinism** genes it built up in cars and medical devices straight into a phone.
- Even BB10's own native UI framework, **Cascades** (from TAT, the Swedish design house RIM acquired, built on Qt/QML), follows the same bent: **it draws on a separate rendering thread, over a retained scene graph**, so a busy app thread never stalls the animation. Together with bezel gestures, Peek/Flow, and Active Frames, BB10's interaction itself grows out of "the shell owns the edges, rendering owns its own thread."

What is striking is how naturally PocketJS lands on this structure. Our core is already **one pure frame function that must return quickly**, with the host owning the event pump — the same shape QNX wants ("drain the events, run a frame, return"), as naturally as it did on Symbian's active object. QNX wants to be asked politely, and PocketJS's host only knows how to ask politely.

## The key in the middle: from wheel to trackpad

<svg viewBox="0 0 760 300" width="100%" role="img" aria-label="BlackBerry's navigation-input lineage and the Classic's tool belt. A timeline: 1999 side track wheel on the 850; 2006 trackball on the Pearl 8100; 2009 optical trackpad on the Curve 8520; 2013 all-touch BB10 phones remove it; 2014 the Classic Q20 brings it back. Below, the Classic tool belt: a Send key, a Menu key, a central optical trackpad, a Back key, and an End key. The optical trackpad is a tiny optical mouse that reports relative displacement, delivered to native apps as the SCREEN_EVENT_JOYSTICK displacement property." font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <text x="14" y="20" fill="#64748b" font-size="11">The key under your thumb · from wheel to trackpad</text>
  <rect x="14" y="34" width="732" height="252" rx="10" fill="#0b0f1a" stroke="#2b3a55"/>
  <line x1="80" y1="92" x2="680" y2="92" stroke="#334155"/>
  <g font-size="10" text-anchor="middle">
    <circle cx="95" cy="92" r="5" fill="#0c1a22" stroke="#64748b"/><text x="95" y="70" fill="#94a3b8" font-size="11">1999</text><text x="95" y="116" fill="#e2e8f0">side track wheel</text><text x="95" y="130" fill="#64748b" font-size="9">850</text>
    <circle cx="235" cy="92" r="5" fill="#0c1a22" stroke="#64748b"/><text x="235" y="70" fill="#94a3b8" font-size="11">2006</text><text x="235" y="116" fill="#e2e8f0">trackball</text><text x="235" y="130" fill="#64748b" font-size="9">Pearl 8100</text>
    <circle cx="375" cy="92" r="5" fill="#0c1a22" stroke="#64748b"/><text x="375" y="70" fill="#94a3b8" font-size="11">2009</text><text x="375" y="116" fill="#e2e8f0">optical trackpad</text><text x="375" y="130" fill="#64748b" font-size="9">Curve 8520</text>
    <circle cx="515" cy="92" r="5" fill="#0b0f1a" stroke="#be123c"/><text x="515" y="70" fill="#94a3b8" font-size="11">2013</text><text x="515" y="116" fill="#fda4af">all-touch · removed</text><text x="515" y="130" fill="#64748b" font-size="9">Z10 / Q10</text>
    <circle cx="665" cy="92" r="6" fill="#14251d" stroke="#a3e635"/><text x="665" y="70" fill="#a3e635" font-size="11">2014</text><text x="665" y="116" fill="#bef264">Classic brings it back</text><text x="665" y="130" fill="#64748b" font-size="9">Q20</text>
  </g>
  <text x="380" y="172" fill="#64748b" text-anchor="middle" font-size="10.5">The Classic tool belt — four keys, one optical trackpad in the middle</text>
  <rect x="170" y="188" width="420" height="64" rx="14" fill="#0e1626" stroke="#38bdf8"/>
  <g font-size="10.5" text-anchor="middle">
    <rect x="190" y="205" width="60" height="30" rx="6" fill="#0b0f1a" stroke="#65a30d"/><text x="220" y="224" fill="#d9f99d">Send</text>
    <rect x="258" y="205" width="60" height="30" rx="6" fill="#0b0f1a" stroke="#475569"/><text x="288" y="224" fill="#e2e8f0">Menu</text>
    <circle cx="380" cy="220" r="24" fill="#0c1a22" stroke="#22d3ee"/><text x="380" y="217" fill="#22d3ee" font-size="9">optical</text><text x="380" y="229" fill="#22d3ee" font-size="9">trackpad</text>
    <rect x="442" y="205" width="60" height="30" rx="6" fill="#0b0f1a" stroke="#475569"/><text x="472" y="224" fill="#e2e8f0">Back</text>
    <rect x="510" y="205" width="60" height="30" rx="6" fill="#0b0f1a" stroke="#be123c"/><text x="540" y="224" fill="#fda4af">End</text>
  </g>
  <text x="14" y="274" fill="#64748b" font-size="10">A tiny optical mouse reporting <tspan fill="#22d3ee">relative displacement</tspan> — to native apps, that's <tspan fill="#22d3ee">SCREEN_EVENT_JOYSTICK</tspan> DISPLACEMENT.</text>
</svg>

BlackBerry's identity is bound, in large part, to **the navigation key under your thumb**. Its lineage is worth a moment:

- **Side track wheel**: the earliest BlackBerrys (the 850 in 1999 through the 8700 series around 2005) put a wheel on the side of the body — thumb-scroll, press to confirm. Every navigation key BlackBerry shipped afterwards is a descendant of it.
- **Trackball**: the Pearl 8100 in 2006 moved a small rolling ball to the front, four-way plus press; the Curve 8300 and Bold 9000 used it. Nice, but prone to dirt and wear.
- **Optical trackpad**: from the Curve 8520 in 2009, an **optical sensor** replaced the trackball — like a tiny optical mouse, no moving parts, sensing the finger's relative motion directly; the Bold 9700 and 9900 carried it on.
- On BB10's all-touch phones (Z10, Q10, Passport…) the key was removed entirely.
- Then the **Classic (Q20, December 2014)**: it **deliberately put the tool belt back** — Menu / Back / Send / End, with an **optical trackpad** in the middle, a nod to the Bold 9900 era. BB10.3.1 added trackpad support to a system that was never designed for one: **there is no global cursor** (only the browser and Maps get a pointer); everywhere else, a blue focus highlight moves cell by cell through the Cascades UI.

For us, this trackpad is an interesting engineering problem, because **it is a relative pointing device**: it gives you displacement deltas, not coordinates, and certainly not discrete "up/down/left/right." Our guest, meanwhile, lives in a d-pad / button world (`input.buttons`). So the host has to turn relative motion into discrete focus movement.

In `libscreen` the trackpad arrives as **`SCREEN_EVENT_JOYSTICK`** events carrying `SCREEN_PROPERTY_DISPLACEMENT` and a button mask. The displacement is an integer and every event is one "notch," so the host initialises the threshold at 1: every non-zero event is one d-pad pulse in its direction, and a click (`buttons != 0`) becomes `CIRCLE`. Those deltas go into the same few lines every relative input in PocketJS goes through, in the Classic host input state machine (`hosts/blackberry-classic/pocket_input.c`):

```c
/* Relative motion → one d-pad pulse per threshold crossing; the axis resets
   after a pulse, so the remainder of a big move can never flip the next one.
   On the Classic the threshold is 1: one displacement notch, one pulse. */
void pocket_input_relative(PocketInputState *state, float delta_x, float delta_y)
{
  const float threshold = state->relative_threshold;
  state->relative_x += delta_x;
  state->relative_y += delta_y;
  if (state->relative_x <= -threshold)      { state->pressed |= POCKET_BTN_LEFT;  state->relative_x = 0.0f; }
  else if (state->relative_x >= threshold)  { state->pressed |= POCKET_BTN_RIGHT; state->relative_x = 0.0f; }
  if (state->relative_y <= -threshold)      { state->pressed |= POCKET_BTN_UP;    state->relative_y = 0.0f; }
  else if (state->relative_y >= threshold)  { state->pressed |= POCKET_BTN_DOWN;  state->relative_y = 0.0f; }
}
```

(The `POCKET_BTN_*` bits are not typed by hand: `pocket_spec.h` is generated from `contracts/spec/spec.ts`, the same table the Rust core and the JS runtime are generated from, and the contract test refuses to let it drift.)

This echoes a long-standing PocketJS attitude toward input. The independent [Pocket Vapor experiment](https://github.com/pocket-stack/pocket-vapor) has a **hardware-neutral incremental-input contract** — `RelativeAxis` / `onAxisDelta` ([input.ts](https://github.com/pocket-stack/pocket-vapor/blob/experiment/standalone/vapor/host/input.ts)) — a device-agnostic ABI for **incremental controls** like a Playdate crank or a rotary encoder. In that worldview the trackpad is "just another relative axis." The Hero demo only needs buttons, so we collapse the axis down to d-pad pulses rather than exposing `RelativeAxis` to the guest; but the bloodline is the same: **never let a device concept cross the boundary into the guest.**

So the side wheel of 1999 and the optical trackpad of 2014 are, in PocketJS's eyes, the same thing — **a relative motion sensor hiding under your thumb** — exactly the way it sees a Playdate crank.

## Input: collapsing a keyboard, a trackpad and a touchscreen into one contract

QNX's `SCREEN_EVENT_*` events and the navigator's system keys are **not allowed across the QuickJS bridge**. The guest sees only one portable button mask and one touch snapshot, and the host does the whole translation:

| Physical input | Portable input |
| --- | --- |
| trackpad movement | discrete d-pad focus pulses, one per threshold crossing of the accumulated `SCREEN_PROPERTY_DISPLACEMENT`; it arrives as integer notches, so the threshold is 1 |
| trackpad click | the press button (`CIRCLE`), held while the button is down, tracked apart from the keys |
| Enter/Return, d-pad center | the press button |
| arrow keys | d-pad; a key down is one press edge, auto-repeat does not press again |
| Space | `START` |
| Menu | `TRIANGLE` |
| Send (a navigator system key) | a one-shot press edge; End and Back stay with the system |
| touchscreen | one tracked contact (a second finger never becomes input), divided into 360×360 logical coordinates, with the host-resolved bounds hit fact |

All of it lands in `pocket_input.c`, a small state machine the BPS callbacks feed and the frame loop samples exactly once per guest turn. It is plain C with no platform headers, so it is unit-tested with the host compiler — key edges, trackpad pulses, the click, and the touch latch all have a scenario in `tests/fixtures/pocket-input-test.c`.

For this host, `pocket_runtime.c` grew one new entry point: `pocket_runtime_tick`, **exactly one guest turn followed by one core tick**, taking the button mask, the sampled contact, and its hit fact. (The older `pocket_runtime_frame*` calls stay for the original iPhone host, whose 30 Hz presentation advances two core ticks per guest turn.)

One frame's worth of input is fed in like this — sample the state machine into "a button mask + a touch snapshot," run one tick, then let the GPU draw:

```c
static int render_frame(void) {
  PocketInputSample sample;
  PocketRuntimeInput frame;
  pocket_input_sample(&input, &sample);                       // held + one-frame edges; latch consumed here

  frame.buttons    = sample.buttons;
  frame.touch_down = sample.touch_down;
  frame.touch_x    = (int)(sample.touch_x * POCKET_LOGICAL_WIDTH  / surface_width);   // 720 → 360 logical
  frame.touch_y    = (int)(sample.touch_y * POCKET_LOGICAL_HEIGHT / surface_height);
  frame.touch_hit  = sample.touch_down ? pocket_runtime_hit_test_bounds(frame.touch_x, frame.touch_y) : 0;

  pocket_runtime_tick(&frame);                                // one guest turn + one core tick
  pocket_runtime_gl_render(surface_width, surface_height);   // GPU draws the retained tree; the CPU touches no pixel
  eglSwapBuffers(egl_display, egl_surface);
  return 1;
}
```

The press edges and the touch latch inside that state machine are the cure for a trap this port shares with the Meizu M8 one: **an event stream and a sampled state are two different things**. The trackpad hands you a run of displacement events, but the guest samples only once per 60 Hz; a quick press-and-release can happen entirely between two samples. So the host has to **latch** an edge like a press until at least one frame has observed it. Touch is the same: a tap's down and up can fall in the same inter-frame gap — and the latch has to fire **only on the down**, never on the release, or a long press would hand the guest one more "down" frame after the finger had already left. (The first cut of this host did exactly that; a reviewer caught it, and it is now the kind of mistake the unit test refuses.)

## The translation seam: the host owns the pump, the guest owns the UI

<svg viewBox="0 0 760 402" width="100%" role="img" aria-label="PocketJS as a translator between the modern app model and the BlackBerry Classic host pump. On the guest side, Solid signals and TSX drive a retained PocketJS tree that does layout, focus and hit testing, and a GLES2 DrawList renders a complete 720 by 720 frame on the GPU. That frame crosses one narrow seam to the host, which presents it with eglSwapBuffers. Input returns through the same seam: QNX screen events and navigator system keys are normalized by a host adapter into one portable frame input of a button mask and a touch snapshot. The app never sees a screen window, BPS or a joystick event; the host never learns what a button or a component means." font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <text x="14" y="20" fill="#64748b" font-size="11">Translation seam · host owns pump and presentation, guest owns state and its UI</text>
  <rect x="14" y="34" width="440" height="340" rx="10" fill="#0c1a22" stroke="#22d3ee"/>
  <rect x="474" y="34" width="272" height="340" rx="10" fill="#0b0f1a" stroke="#2b3a55"/>
  <text x="32" y="60" fill="#f1f5f9" font-size="13" font-weight="700">Modern app model (guest)</text>
  <text x="492" y="60" fill="#f1f5f9" font-size="13" font-weight="700">The host pump (QNX)</text>
  <rect x="34" y="80" width="182" height="48" rx="7" fill="#0e2530" stroke="#22d3ee"/><text x="125" y="100" fill="#e2e8f0" text-anchor="middle" font-size="11.5">Solid signals + TSX</text><text x="125" y="117" fill="#22d3ee" text-anchor="middle" font-size="9.8">declare relationships</text>
  <path d="M220 104 H250" stroke="#475569"/><path d="M250 104 l-8 -5 M250 104 l-8 5" stroke="#475569" fill="none"/>
  <rect x="254" y="80" width="182" height="48" rx="7" fill="#0e2530" stroke="#22d3ee"/><text x="345" y="100" fill="#e2e8f0" text-anchor="middle" font-size="11.5">PocketJS retained tree</text><text x="345" y="117" fill="#22d3ee" text-anchor="middle" font-size="9.8">layout · focus · hit test</text>
  <path d="M345 132 V164" stroke="#475569"/><path d="M345 164 l-5 -8 M345 164 l5 -8" stroke="#475569" fill="none"/>
  <rect x="254" y="168" width="182" height="48" rx="7" fill="#0e1626" stroke="#38bdf8"/><text x="345" y="188" fill="#e2e8f0" text-anchor="middle" font-size="11.5">GLES2 DrawList</text><text x="345" y="205" fill="#64748b" text-anchor="middle" font-size="9.8">GPU draws all of 720×720</text>
  <path d="M440 192 H506" stroke="#22d3ee"/><path d="M506 192 l-8 -5 M506 192 l-8 5" stroke="#22d3ee" fill="none"/>
  <rect x="510" y="168" width="216" height="48" rx="7" fill="#0c1a22" stroke="#22d3ee"/><text x="618" y="188" fill="#e2e8f0" text-anchor="middle" font-size="11">eglSwapBuffers</text><text x="618" y="205" fill="#22d3ee" text-anchor="middle" font-size="9.8">720×720 present · no stretch</text>
  <line x1="32" y1="246" x2="728" y2="246" stroke="#1e293b"/>
  <text x="32" y="268" fill="#64748b" font-size="10">Input returns through the same seam · no OS concept crosses the boundary</text>
  <rect x="510" y="286" width="216" height="48" rx="7" fill="#0e1626" stroke="#38bdf8"/><text x="618" y="306" fill="#e2e8f0" text-anchor="middle" font-size="10.5">SCREEN_EVENT_* · bps_get_event</text><text x="618" y="323" fill="#64748b" text-anchor="middle" font-size="9.5">navigator system keys</text>
  <path d="M506 310 H440" stroke="#475569"/><path d="M440 310 l8 -5 M440 310 l8 5" stroke="#475569" fill="none"/>
  <rect x="254" y="286" width="182" height="48" rx="7" fill="#0e2530" stroke="#22d3ee"/><text x="345" y="306" fill="#e2e8f0" text-anchor="middle" font-size="11">host adapter</text><text x="345" y="323" fill="#22d3ee" text-anchor="middle" font-size="9.5">coords · edges · one tick</text>
  <path d="M250 310 H220" stroke="#475569"/><path d="M220 310 l8 -5 M220 310 l8 5" stroke="#475569" fill="none"/>
  <rect x="34" y="286" width="182" height="48" rx="7" fill="#0e2530" stroke="#22d3ee"/><text x="125" y="306" fill="#e2e8f0" text-anchor="middle" font-size="11">frame input</text><text x="125" y="323" fill="#22d3ee" text-anchor="middle" font-size="9.5">buttons + touch, nothing else</text>
  <path d="M125 286 V136" stroke="#475569" stroke-dasharray="4 4"/><path d="M125 136 l-5 8 M125 136 l5 8" stroke="#475569" fill="none"/>
  <text x="234" y="360" fill="#22d3ee" text-anchor="middle" font-size="10.5">app speaks only state + desired UI</text>
  <text x="610" y="360" fill="#64748b" text-anchor="middle" font-size="10.5">host speaks only pump + present</text>
</svg>

PocketJS's role on BlackBerry is the same as it was on Windows CE: **it does not replace the OS event loop; it sits inside it.** `bps_get_event` is the pump. It drains the screen and navigator events, normalizes them into one frame input, lets the guest take exactly one tick, and presents 720×720 with `eglSwapBuffers`.

Solid, the app code, and the Rust core **never know** that `screen_window_t`, BPS, or `SCREEN_EVENT_JOYSTICK` exist. And in reverse, the host never learns what "a button" or "a component" means. Each side of the boundary owns half the world: **the host owns the pump and the presentation, the guest owns the state and the UI it wants.**

This is also why adding a new target costs so little. The M8 turned Windows CE into a whole phone platform; we go the other way, bringing a self-contained modern UI runtime and asking the OS for only the smallest surface that will hold it. From QNX that surface is three things: a window, an event queue, and a GL context.

## Why bother

PocketJS's whole bet is that **one guest, one core, dropped onto machines of every shape, changes only a thin layer of host**. The Classic tests that bet from an unfamiliar direction.

It is not a slow machine. Two 1.5 GHz cores and an Adreno 225 are more than the PSP or the E7 ever had, and the frame loop was never in doubt. What is strange about the Classic is everything *around* the frame loop. The window is a buffer you ask a user-space service for. The phone shows up on your desk as a host on the network, not as a disk. The keyboard is real, the trackpad reports displacement instead of position, and the screen is a square. Against all of that, the port is one 547-line `main.c`, and the component sitting above it would run unchanged on a PSP.

And the machine itself is a specimen about trust. BlackBerry carved security into every layer: even a developer's local debugging needs a time-limited, device-bound, officially blessed pass; files go over challenge-response CGI or password-protected SMB; an app is either signed or holds a token. It was impregnable in its day, and the price was this — when the servers behind it went dark, the whole device closed its door to new code. It was the community, not the vendor, that pushed the door back open.

So the last word of this post goes to those people: to **bb10.root.sx**'s Oleksandr, and to guizmox, sw7ft, and everyone who re-rooted a platform its maker had already condemned; to **Sachesi**'s Sacha Refshauge, who reversed the official tools' protocol into a program that still compiles and runs today; to everyone still making firmware, writing tools, and keeping documentation for these square-screened phones. What you did is far heavier than this port — you are the reason a 2014 BlackBerry can still light up a freshly written frame in 2026.

Respect.

---

*Further reading: QNX's [System Architecture](https://www.qnx.com/developers/docs/7.1/com.qnx.doc.neutrino.sys_arch/topic/kernel.html) on the Neutrino microkernel and its [message passing](https://www.qnx.com/developers/docs/6.5.0SP1.update/com.qnx.doc.neutrino_sys_arch/ipc.html); the [Screen Graphics Subsystem](https://www.qnx.com/developers/docs/8.0/com.qnx.doc.screen/topic/manual/cscreen_appDevelopment.html) developer guide, including [composition](https://www.qnx.com/developers/docs/8.0/com.qnx.doc.screen/topic/manual/cscreen_composition.html) and [window groups](http://www.qnx.com/developers/docs/7.0.0/com.qnx.doc.screen/topic/manual/cscreen_windowing-groups.html); the [PPS](https://www.qnx.com/developers/docs/7.1/com.qnx.doc.neutrino.sys_arch/topic/pps.html) service; RIM's own [GoodCitizen](https://github.com/blackberry/NDK-Samples/blob/master/GoodCitizen/main.c) sample for BPS, screen, and the navigator. The BB10 root project lives at [bb10.root.sx](https://bb10.root.sx), and [Sachesi](https://github.com/xsacha/Sachesi) is the community tool whose source made the device protocol legible. BlackBerry's [End of Life FAQ](https://www.blackberry.com/us/en/support/devices/end-of-life) records the January 4, 2022 shutdown. PocketJS's Classic hosts are documented in [`docs/BLACKBERRY_CLASSIC.md`](https://github.com/pocket-stack/pocketjs/blob/main/docs/BLACKBERRY_CLASSIC.md).*
