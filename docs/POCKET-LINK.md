# Pocket Link

Pocket Link is the console's system link to one computer its owner paired with.
The console's runtime holds **one authenticated TCP connection** to a companion
process on that computer. Three services ride it: a worker's HTTP requests as
credited byte streams, the companion's app catalog, and app installs.
The wire contract is `contracts/spec/link.ts`; this page describes the
mechanism. Pocket Hub (`pocket-nexus/pocket-hub`) is the companion. The
reference implementation in `tools/pocket-link/` holds the wire codec, a
console client and the companion's `net.stream` requests, and the tests check
the console's C client against it.

## Roles

| Side | Process | Sockets |
| --- | --- | --- |
| Console | the host runtime (3DS: `products/3ds`; M5Stack Tab5: pocket-m5's `pocket_system`) | UDP **8627** for beacons, one outgoing TCP connection |
| Companion | the Pocket Hub daemon, on its own or inside Pocket Hub.app | TCP **8628** listener, UDP beacon sender, control API on 127.0.0.1 |

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

1. The owner opens a pairing window in Pocket Hub. The companion mints a
   **16-byte single-use secret** valid for **10 minutes**.
2. The companion shows the pairing URI as a QR code (byte mode, error
   correction level M):

   ```
   pocketlink://pair?v=1&c=<companion id>&h=<ipv4>[,<ipv4>…]&p=<port>&s=<secret>&n=<name>
   ```

   `h` lists up to three non-internal IPv4 addresses, Ethernet and Wi-Fi
   interfaces first; tunnels and VM bridges are left out. The URI is shorter
   than **160 bytes**: the companion shortens the name to fit, and the console
   receives the full name in the `paired` reply.
3. In Pocket Shell's **Settings › Mac › Pair a Mac…** the console scans the
   code with its camera (the 3DS's outer camera), connects to each host in
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

**net.stream.** The companion performs a worker's HTTP request
(`contracts/spec/net.ts`, the worker's `io.http` resource) with its own HTTP
and TLS stack, and streams the response body in blocks of at most 1 KiB under
the console's byte credit:

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
default; the Tab5 sends `tab5-home`). A row carries the identity section's
id, title and output, the app contract's `version` and `summary` (or
`description`), the file size and the file's **footer hash** (FNV-1a64, 16
hex digits). The footer is verified when the file is scanned; a file that
fails it is skipped. At most **64** rows; one row per app id, the first
directory winning. The companion watches the
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
| `ready` | companion, every **500 ms** | companion id, name, features (`media`), clock |
| `hello` | console, every **1 s** while linked | device id, name, model, target |
| `media.req` | console | the ticket of a media stream to open, or a close |
| `media.ring` | companion, in place | a 64-byte head (generation, bytes written, closed flag), then a **1 MiB** ring of the stream's bytes |
| `media.ack` | console, in place | the stream bytes the console has read |

Each record is a 64-byte header (magic `PKLU`, the companion's epoch, the
console's boot id, a sequence number, the kind, a beat counter, the JSON
length and its FNV-1a 32 hash) followed by the JSON. The companion writes
under a temporary name and renames; the console's writes are plain, so the
companion reads a record whose hash fails again on its next poll: **every
100 ms** behind a directory watch that sees the console's writes, **every
10 ms** without one.

**The cable is the trust boundary.** The computer serving the share already
chooses every file the console reads, including the program it runs, so the
carrier has no pairing and no key. It carries link status and media. It
carries no network requests: HTTP is a worker resource (`io.http`), and the
PSP host runs no worker domain. It carries no catalog and no installs,
because a PSP's apps are embedded in the EBOOT the share serves.

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
`programs/psp/src/service_bindings.rs` installs `globalThis.link` and
`globalThis.media` over them. A worker thread at a lower priority than the
guest reads `ready` and writes `hello`, so a USB round trip never lands
inside a frame; the guest's thread reads the companion's status from memory
and performs no `host0:` read. The first guest evaluates after the worker's
first `ready` read or **200 ms**, whichever comes first, so a media stream
opened at mount finds the session up and a hung share delays the boot by
200 ms at most. A `ready` left behind by a companion that went silent (a
crash, an OOM kill) links again only once its beat moves. With no companion
the worker reads `ready` once a second. A new epoch (the companion
restarted) or **10 s** without a beat (the TCP link's silence) ends the
session: the companion stops the stream, and the console's ring reader sees a
head from another epoch. `link.status()` reports `linked` with the
companion's name while it beats and `searching` otherwise; `pair`, `forget`,
`catalog`, `install` and `remove` refuse.

```
# on the computer the PSP is plugged into, in a Pocket Hub checkout
usbhostfs_pc /opt/pocket/host0 &
bun run hub serve --usb /opt/pocket/host0 --no-agent
```

## The companion and the reference implementation

Pocket Hub implements the companion: the daemon (listener, beacons, pairing
windows, catalog, installs, `net.stream`, the USB carrier, the companion
services and the console agent), its control API on 127.0.0.1, the Mac app
and the CardputerZero's screen. Its documentation covers running it, the
control API, its storage and its tests.

`tools/pocket-link/` holds the reference implementation. Pocket Hub imports
these files from its PocketJS submodule.

| File | Content |
| --- | --- |
| `protocol.ts` | Beacon, preamble and frame codec, the handshake proofs, the masked pairing key, the pairing URI |
| `console-client.ts` | The console side in TypeScript: both handshake modes, ping, `net.stream`, catalog and install requests, the agent channel's messages and streams, a beacon listener |
| `catalog.ts` | The companion's app offer from `.pocket` files, with each file's footer hash |
| `qr.ts` | The pairing code's QR encoder: byte mode, level M, versions 1–10 |
| `fetch.ts` | The companion's side of `net.stream`: destination checks, redirects, `maxBytes`, timeout, the proxy settings |
| `stream-credit.ts` | The byte credit a streamed response body waits on |

## Tests

Three files in the unit stage of `tools/test.ts` test the reference
implementation and the console's C client:

- `tests/pocket-link.test.ts`: protocol vectors (proofs, the masked key, the
  beacon layout, preamble and frame header, split frames and the frame-size
  guard, the pairing URI) and the destination policy. The QR encoder is read
  back by an independent decoder in the test (format and version words,
  Reed–Solomon syndromes, payload) for versions 1–10 and all eight masks, and
  on macOS by CoreImage's `CIDetector`.
- `tests/3ds-link.test.ts` compiles the socket-free half of the console's
  client (`engine/host-services/link_proto.c`, `sha256.c`, `jscan.c`) and the
  vendored QR decoder for the build machine and checks them against
  `protocol.ts` and `qr.ts`: the same proofs and masked key, the same pairing
  URI and beacon, and the decoder reading the pairing code at camera size.
- `tests/worker-http-stream.test.ts`: the byte credit, response headers
  before the body through `fetch.ts`, and `engine/host-services/link_http.c`
  holding a full byte window and its disconnect terminal.

Pocket Hub's tests run its companion on loopback against `console-client.ts`,
and build `engine/host-services/link.c` into a POSIX link client that runs
against the companion.
