# Pocket Link

Pocket Link is the console's system link to one computer its owner paired with.
The console's runtime holds **one authenticated TCP connection** to a companion
process on that computer. Three services ride it: the NET module's HTTP on hosts
whose net transport is the link, the companion's app catalog, and app installs.
The wire contract is `contracts/spec/link.ts`; this page describes the
mechanism and the companion implementation in `tools/companion/`.

## Roles

| Side | Process | Sockets |
| --- | --- | --- |
| Console | the host runtime (3DS: `products/3ds`) | UDP **8627** for beacons, one outgoing TCP connection |
| Companion | `tools/companion.ts serve`, or the daemon inside Pocket Companion.app | TCP **8628** listener, UDP beacon sender, control API on 127.0.0.1 |

**The companion listens; the console connects.** The console holds no listening
socket for the link. A companion that cannot bind 8628 listens on an ephemeral
port; its beacons and pairing codes carry the port in use.

**The companion beacons once a second**: a 64-byte datagram with magic `PKLB`,
the companion id, the TCP port, a pairing-window flag and the display name. It
goes to `255.255.255.255`, to the broadcast address of each LAN interface, and
as unicast to the last address of every paired console. macOS sends a
`255.255.255.255` datagram out of the default route and no other interface, so
the per-interface broadcast and the unicast copies are what reach a console on
a second network.
The datagram's source address is the console's connect target. A console
ignores beacons from companion ids it holds no key for.

## Pairing

1. The owner opens a pairing window (menu bar: **Pair a Console…**, or
   `bun tools/companion.ts pair`). The companion mints a **16-byte single-use
   secret** valid for **10 minutes**.
2. The companion shows the pairing URI as a QR code (byte mode, error
   correction level M):

   ```
   pocketlink://pair?v=1&c=<companion id>&h=<ipv4>[,<ipv4>…]&p=<port>&s=<secret>&n=<name>
   ```

   `h` lists up to three non-internal IPv4 addresses, Ethernet and Wi-Fi
   interfaces first; tunnels and VM bridges are left out. The URI is shorter
   than **160 bytes**: the companion shortens the name to fit, and the console
   receives the full name in the `paired` reply.
3. The console scans the code with its outer camera, connects to each host in
   order, and runs the handshake in mode `pair` with the secret.
4. The companion mints a **32-byte link key**, stores it, and sends it masked
   with an HMAC of the secret and both nonces. The window closes: the secret
   is used. **Five failed proofs** also close a window.

A pairing URI from a 160-byte budget does not fit a version-6 code at level M
(106 bytes); typical URIs encode as **version 7 or 8** (122 or 152 bytes).

## Handshake and trust

Every connection starts with an 8-byte preamble (`PKLK`, version 1) and then
frames: an 8-byte header (type, flags, reserved, u32 length) and at most
**32 KiB + 4** bytes of payload. A longer frame closes the connection.

```
console   -> hello      {mode, device, companion, nonce nD, name, model, target}
companion -> challenge  {nonce nC, proof = HMAC(secret, "pocket-link/1/companion\n" nD \n nC \n device \n companion)}
console   -> auth       {proof = HMAC(secret, "pocket-link/1/console\n" nD \n nC \n device \n companion)}
companion -> ready | paired {key = linkKey XOR HMAC(secret, "pocket-link/1/key\n" nD \n nC)} | refused {code}
```

The secret is the link key in mode `connect` and the pairing secret in mode
`pair`. **The HMAC key is the secret's raw bytes** (32 or 16 bytes, decoded
from hex); the message is the UTF-8 label string with the nonces and ids as
lowercase hex, as sent. Proofs travel as 64 lowercase hex digits and
the companion compares them in constant time.

The console checks the companion's proof before it answers, so a companion
without the secret learns nothing it can replay. Refusal codes:
`unknown_device` (no key for this console, or the console paired with another
companion), `bad_proof`, `pairing_closed` (no window, expired, or used),
`version`.

After `ready` the frames are **neither encrypted nor authenticated**. The link
assumes the owner's LAN, the same assumption as the dev wire and offload. The
key proves that both ends hold it when the connection opens; it does not
protect the bytes that follow from an attacker on the same network.

Forgetting a console deletes its key from the companion store and closes its
connection. The console's next `connect` gets `unknown_device` and it has to
pair again.

## What rides the link

All requests are ctrl frames (one JSON object, at most **32 KiB**) with a
console-chosen `id`; bodies are data frames (`u32` stream id = request id, then
at most **32 KiB**). A closed connection fails every open request; nothing is
replayed.

**net.** The companion performs the NET module's whole-response request
(`contracts/spec/net.ts`) with its own HTTP and TLS stack:

- methods `GET HEAD POST PUT PATCH DELETE OPTIONS`; request body at most
  **64 KiB**; timeout at most **120 s**; response at most `maxBytes` (at most
  **256 KiB**), read until the limit and failed with `response_too_large` past
  it;
- redirects followed by hand, at most **3**; each hop is resolved and checked;
- **every destination address is checked** before the request: loopback,
  link-local, RFC 1918, CGNAT (`100.64/10`), multicast, unique-local and
  reserved addresses are refused with `invalid_request` unless the companion
  runs with `--allow-private`. A name that resolves to any refused address is
  refused;
- response headers are lowercase, hop-by-hop headers are dropped, and
  `content-encoding` / `content-length` are dropped when the body was
  decompressed; several `set-cookie` headers are joined with `\n`; at most
  **32 headers / 8 KiB**;
- failures map to `NET_ERROR` codes (`dns`, `connect`, `tls`, `timeout`,
  `redirect`, `cancelled`, …). `net.cancel` aborts the request.

The companion sends through `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY`. When
none is set, the daemon copies the macOS proxy settings (`scutil --proxy`) into
them at start, because an app launched from Finder inherits no shell
environment.

**catalog.** The companion offers every `.pocket` file in its apps directories
that has a variant for the console's `target` from `hello` (`3ds-dev` by
default). A row carries the identity section's id, title and output, the
manifest's `version` and `summary` (or `description`), the file size and the
file's **footer hash** (FNV-1a64, 16 hex digits). The footer is verified when
the file is scanned; a file that fails it is skipped. At most **64** rows; one
row per app id, the first directory winning. The companion watches the
directories and pushes `{"t":"catalog.changed"}` to every linked console after
the offer changes.

**install.** The companion streams the `.pocket` file verbatim:
`install.head` with the footer hash and byte count, then the bytes in 32 KiB
data frames; a chunk waits for the socket's `drain` when its buffer is full (backpressure). Size
and hash come from the open file descriptor, so a file replaced mid-install
streams one consistent version. At most **4 installs** run per connection;
files above **24 MiB** are not offered.

**agent.** A companion that runs the console agent lists the feature `agent`
in `ready`. Its messages are ctrl frames whose `t` starts with `agent.`, and
its streams carry microphone audio and touch-screen shots from the console,
glyph atlases and own-screen frames from the companion (stream ids from the
companion have bit 31 set). [POCKET-AGENT.md](POCKET-AGENT.md) describes them.

## USB carrier

A PSP has no network link to its companion. It reaches the companion through
the PSPLINK file share: `usbhostfs_pc` serves a directory on the tethered
computer (a CardputerZero or a Mac) as `host0:`, and the companion runs the
**USB carrier** in that directory (`serve --usb <share>`). The records are in
`contracts/spec/link.ts` under "USB carrier".

| File in `<share>/pocket-link/` | Writer | Content |
| --- | --- | --- |
| `ready` | companion, every **500 ms** | companion id, name, features (`net`, `media`), clock |
| `hello` | console, every **1 s** while linked | device id, name, model, target |
| `net0.req`, `net1.req` | console | the TCP link's `net` ctrl and the request body, or a cancel |
| `net0.res`, `net1.res` | companion | the NET event (`done` or `error`) and the response body |
| `media.req` | console | the ticket of a media stream to open, or a close |
| `media.ring` | companion, in place | a 64-byte head (generation, bytes written, closed flag), then a **1 MiB** ring of the stream's bytes |
| `media.ack` | console, in place | the stream bytes the console has read |

Each file is one record: a 64-byte header (magic `PKLU`, the companion's
epoch, the console's boot id, the slot's sequence number, the kind, the
request id, a beat counter, the JSON and body lengths, and an FNV-1a 32 hash
of each), the JSON, the body. The companion writes under a temporary name and
renames; the console's writes are plain, so the companion reads a record whose
hashes fail again on its next poll: **every 100 ms** behind a directory watch
that sees the console's writes, **every 10 ms** without one.

**The cable is the trust boundary.** The computer serving the share already
chooses every file the console reads, including the program it runs, so the
carrier has no pairing and no key. It carries `net` and `media`: no catalog
and no installs, because a PSP's apps are embedded in the EBOOT the share
serves.

**Media rides a ring, not records.** A service's `MediaSource` names a ticket
on the companion's media stream server; the console writes its token to
`media.req`, and the carrier takes the ticket in process, runs its producer
and writes the bytes the TCP endpoint would send (the 32-byte header, then the
packets) into `media.ring`. The console holds the ring open, so the companion
writes it in place, the stream bytes before the head that counts them, and
never more than **1 MiB** past what `media.ack` reports read. A new
`media.req`, a revoked ticket, a new boot or a silent console stops the
producer. The decode is in [MEDIA.md](./MEDIA.md).

On the console, `platforms/psp/io/src/link.rs` runs the carrier,
`programs/psp/src/media.rs` reads the media ring, and
`programs/psp/src/service_bindings.rs` installs `globalThis.net`,
`globalThis.link` and `globalThis.media` over them. A worker thread at a lower priority than the guest performs
every `host0:` read and write, so a USB round trip never lands inside a frame.
The guest's thread builds records and allocates each slot's reply buffers at
its first request; it performs no `host0:` I/O. The first guest evaluates
after the worker's first `ready` read or **200 ms**, whichever comes first, so
a request made at mount finds the session up and a hung share delays the boot
by 200 ms at most. A `ready` left behind by a companion that went silent (a
crash, an OOM kill) links again only once its beat moves. With no companion
the worker reads `ready` once a second. A new epoch (the companion
restarted) or **10 s** without a beat (the TCP link's silence) fails every open request with
`unavailable`; nothing is replayed. `link.status()` reports `linked` with the
companion's name while it beats and `searching` otherwise; `pair`, `forget`,
`catalog`, `install` and `remove` refuse.

```
# on the computer the PSP is plugged into
usbhostfs_pc /opt/pocket/host0 &
bun tools/companion.ts serve --usb /opt/pocket/host0 --no-agent
```

## Running the companion

```
bun run companion serve                     # dist/3ds + ~/Library/Application Support/Pocket Companion/apps
bun run companion serve --apps ./my-apps --allow-private --name "Studio Mac"
bun run companion pair --wait               # QR code in the terminal; waits for the console
bun run companion status
bun run companion forget <console id>
bun run companion apps-dir <path>
```

`serve` options: `--apps <dir>` (repeatable; replaces the checkout's
`dist/3ds`), `--name`, `--port` (default 8628), `--allow-private`,
`--store <dir>`, `--unicast <ip>` (repeatable extra beacon target),
`--usb <share>` (repeatable; the USB carrier in that share),
`--parent-pid <pid>` (exit when that process exits). Logs are one line per
event.

State lives in `~/Library/Application Support/Pocket Companion/`
(`$POCKET_COMPANION_HOME` or `--store` overrides it):

- `companion.json` (mode **0600**): the companion id, the owner's apps folder,
  and each paired console `{id, name, model, key, lastAddress, lastSeen}`;
- `control.json` (mode **0600**, present while a daemon runs): `{port, token, pid}`
  of the control API;
- `services/<name>/`: a service's credentials (the X session, the Discord bot
  token), mode **0600**;
- `tools/`: `yt-dlp` and `ffmpeg` fetched by `service youtube install`
  (`tools/companion/tools.ts`): yt-dlp's macOS build from its latest release,
  checked against that release's `SHA2-256SUMS`, and a pinned ffmpeg 9.0.2
  static build for the Mac's architecture, checked against a SHA-256 in the
  source. The YouTube service uses these before any on `PATH`. Without bun,
  deno or node on the Mac, the compiled daemon runs yt-dlp's JavaScript
  itself (`BUN_BE_BUN=1`).

### Control API

HTTP on `127.0.0.1`, a random port, `Authorization: Bearer <token>`:

| Request | Result |
| --- | --- |
| `GET /status` | companion `{id, name, port, version, addresses, allowPrivate}`, `consoles` (linked: `{id, name, model, target, address, since}`), `paired` (without keys), `apps`, `appsDirs`, `appsDir`, `pairing {open, uri?, expiresAt?}` |
| `POST /pair` | opens a window: `{uri, expiresAt}` |
| `DELETE /pair` | closes the window |
| `DELETE /consoles/:id` | forgets the console: `{removed}` |
| `POST /apps-dir {path}` | sets the owner's apps folder: `{appsDir, apps}` |
| `POST /service {name, args}` | runs a service's owner command (`x login`, `x logout`, `discord token <token>`, `discord logout`, `youtube install`): `{output}` |
| `GET /services` | `services`: each service's setup state (`x {signedIn, since, signingIn, lastError}`, `discord {configured, bot, servers, invite, gateway, contentIntent}`, `youtube {ready, ytDlp, ffmpeg, managed, install}`), never a credential; `agent {on, enabled, codex, signedIn}`, the last two read at the request |

`status.apps` entries carry each applet's `summary` and the `services` its
manifest declares.

## Pocket Companion.app

```
bun run companion:app        # -> dist/companion/Pocket Companion.app
open "dist/companion/Pocket Companion.app"
```

The build compiles the daemon with `bun build --compile`, compiles
`tools/companion/macos/*.swift` with `swiftc`, draws the icon, writes
`Info.plist` (`LSUIElement`, `NSLocalNetworkUsageDescription`) and signs the
bundle. Options of `tools/companion-app.ts`:

| Option | Effect |
| --- | --- |
| `--apps <dir>` | copies the `.pocket` files of `<dir>` into `Contents/Resources/apps`; the app offers them with no folder set (repeatable) |
| `--release` | leaves out `PocketRepoAppsDir`, the checkout's `dist/3ds` |
| `--universal` | builds every executable for `arm64` and `x86_64` and joins them with `lipo` |
| `--version <v>` | `CFBundleShortVersionString` |
| `--sign <identity>` | signs with a Developer ID, the hardened runtime and a timestamp; the daemon gets the JIT entitlements a compiled Bun program needs |
| `--notarize <profile>` | submits the signed app to Apple's notary service with a `notarytool` keychain profile, staples the ticket and checks it with `spctl` |
| `--zip <file>` | writes the app as a zip with `ditto` |

The release of the app and its applets is built from Pocket Shell, which
builds the applets and passes their folder with `--apps`.

The app lives in the menu bar and starts `Contents/MacOS/pocket-companion
serve` as a child process with `--parent-pid` and `--apps` for its bundled
applets, or attaches to a daemon already running for the same store. It reads
`/status` once a second, and `/services` every two seconds while its window is
open. The window opens at launch when no console is paired; while it is open
the app shows in the Dock. Its pages:

- **Get Started**: four steps with links to Pocket Shell on Pocket Studio and
  the install guide, the pairing QR code (CoreImage, level M, integer-scaled
  modules) with its countdown, the applets, and the service pages.
- **Consoles**: paired consoles, connected or last seen, with **Forget…**, and
  the pairing code.
- **Applets**: the offered applets with their summaries, links to the pages
  of the services each declares, and a folder chooser for developers.
- **X**: sign in through `pocket-websignin` (`x login`) or sign out.
- **Discord**: the three steps of making a bot (Developer Portal, Message
  Content Intent, the token in a secure field), then the bot, its servers, the
  invite link and a warning when the intent is off.
- **YouTube**: the programs found, a download of both with a progress bar, and
  **Update yt-dlp** for the fetched copy.
- **Assistant**: whether Codex is installed and signed in; **Sign In to
  Codex…** runs `codex login`, and a restart turns the agent on once Codex is
  ready.
- **Settings**: open at login (`SMAppService`), the name and address consoles
  see, the version, the log, a restart.

Quitting the app stops the daemon. Daemon output goes to
`~/Library/Logs/Pocket Companion/companion.log`. The app and the daemon read
`$POCKET_COMPANION_HOME` for the store.

Launch arguments for checks: `--show-window` opens the window at launch,
`--pair` opens a pairing window, `--snapshot <png> [--page <page>] [--window]`
renders a page (`start`, `consoles`, `applets`, `x`, `discord`, `youtube`,
`assistant`, `settings`) to a PNG after five seconds without screen-recording
permission; `--window` draws the page inside a picture of the window's title
bar and sidebar (Pocket Studio's listing pictures).

## Tests

`tests/pocket-link.test.ts` (unit stage of `tools/test.ts`) runs the companion
on loopback against `tools/companion/console-client.ts`, the reference console
implementation: protocol vectors, both handshake modes and every refusal, net
against a local server (with and without `--allow-private`, redirects,
`maxBytes`, timeout, cancel), catalog, install of a package with a `3ds-dev`
variant, `catalog.changed`, the frame-size guard, beacons and the control API.
The QR encoder is read back by an independent decoder in the test (format and
version words, Reed–Solomon syndromes, payload) for versions 1–10 and all eight
masks, and on macOS by CoreImage's `CIDetector`.
