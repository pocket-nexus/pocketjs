# Pocket Link 2

Pocket Link is the one link between a device's runtime and Pocket Hub on its
owner's computer, **on every device and every carrier** (§2.0). **The device
opens one connection to Hub; system messages and one channel per running
applet share it.** Version 2 replaces Pocket Link 1 and absorbs the 3DS
development connection (TCP 8131, `products/3ds/src/devserver.c`). It is
**not compatible with version 1**: version 1's wire, the current 3DS firmware
and the development connection stop working against it.

This page is the specification. The wire constants and types move to
`contracts/spec/link.ts`, the reference codec, console client and test vectors
to `tools/pocket-link/` and `tests/vectors/pocket-link-2/`; until those land on
this branch, this page is the only definition. Statements about version 1 and
the development connection cite the code at `becc0e21`.

The first device is the Nintendo 3DS over Wi-Fi, the Old 3DS included
(**64 MB RAM**, a QuickJS guest, a worker realm with a **512 KiB heap**,
`products/3ds/README.md` "Worker scheduling"). Limits are chosen for it. **The
numbers of §13 were measured on a New 3DS XL; an Old 3DS is slower and has
not been measured** (§11, question 3).

## 1. Scope and roles

| Side | Process | Sockets |
| --- | --- | --- |
| Device | the host runtime (3DS: `products/3ds` with `engine/host-services/link.c`) | On TCP: UDP **8627** for beacons, one outgoing TCP connection. **No listening socket.** |
| Hub | Pocket Hub's resident core process, written in Rust: the Pocket Link endpoint | On TCP: TCP **8628** listener, UDP beacon sender |

The sockets column is the TCP carrier's; §2.0 says what a carrier is. The
protocol keeps the role name `companion` for Hub in fields, labels and file
names, as version 1 does. **The TypeScript in `tools/pocket-link/` stays the
reference implementation and the test peer** of both the C client and Hub's
endpoint (§12).

### What runs on the link

| Group | Initiator | Content |
| --- | --- | --- |
| Admission | device | beacon, the handshake of a paired device (§2, §3). Pairing itself is written to the device's storage, not sent on the link (§3.2) |
| Runtime operations | Hub | status, push a `.pocket`, install a `.3dsx`, launch, screenshot, logs (§6.2) |
| Installed applets | device | the applets the device holds, sent after `ready` and on change (§6.2 `runtime.apps`) |
| DevTools | both | the DevTools JSON-line protocol of `docs/DEVTOOLS.md` §4, eval included (§6.3) |
| Catalog and install | device | Hub's app offer and a `.pocket` streamed into a slot (§6.4) |
| `net.http` | device | an applet worker's HTTP request, performed by Hub (§6.5) |
| Agent | both | the agent's messages and streams of `contracts/spec/agent.ts`, the glyph atlas included (§6.6) |
| Applet channels | device opens | one channel per running applet: requests, replies, events and credited streams between the applet and its daemon on Hub (§7) |

### What does not run on the link

- **Media streams, in this version.** A service's `MediaSource` opens a separate TCP
  connection to the media provider (`docs/MEDIA.md` "Transport and
  ownership"), and **version 2 keeps that side connection: decided, not
  open**. It exists on the TCP carrier alone. The link as the only transport
  is the end state (§2.0); the side connection is a bulk path that the TCP
  carrier's own network already provides, opened with a one-use ticket that
  the service hands out over the link, so no device reaches media without
  the link. When media moves onto the link is §11, question 15.
  **The source's `host` keeps its
  meaning** ("Numeric IPv4 address of the paired companion's media
  endpoint", `contracts/spec/media.ts` `MediaSource`): in the link's terms,
  Hub fills it with **its own address on the device's link connection** (the
  local address of that TCP connection on Hub's side), the address the device
  is known to reach, and `port` with the media endpoint's port.
- **The first install and the pairing.** A 3DS without the runtime gets the
  program through ftpd or through files on the SD card; **Hub writes the
  pairing the same way** (§3.2). Hub does both outside the link.
- **Hub's local IPC** to its UI, CLI and daemons.
- **A second protocol inside an applet channel.** An earlier draft carried
  Pocket Relay records (PocketJS #437, #456) in opaque lanes. Version 2
  carries the link's own requests, events and streams in the channel (§7).
- **The SVC wire** (`PKNT`, `products/3ds/src/svcwire.c`, `contracts/spec/spec.ts`
  "SVC WIRE protocol") and the PSP USB carrier of version 1
  (`contracts/spec/link.ts` "USB carrier"). **Neither stays outside for
  good**: each becomes a carrier of this protocol or is retired (§2.0; §11,
  question 10).

### What version 2 retires

Pocket Link 1 (`contracts/spec/link.ts`, `tools/pocket-link/protocol.ts`,
`engine/host-services/link.c`, and Pocket Hub's version 1 endpoint):

| Version 1 | Version 2 |
| --- | --- |
| Beacon `PKLB` version 1 | Beacon `PKLB` version 2, same layout (§2.2) |
| Preamble `PKLK` v1, console to companion only | Preamble in both directions with a version range (§4.1) |
| 8-byte frame header (type, flags, reserved, length) | 12-byte header with an id (§4.2) |
| `ping` / `pong` (empty) | `PING` / `PONG` with a 4-byte echo (§4.6) |
| `ctrl` frame, one JSON object | `HANDSHAKE`, `REQUEST`, `REPLY`, `EVENT`, `CANCEL` frames, one JSON object each (§4.3, §5) |
| `data` frame, stream id in the first 4 payload bytes | `DATA` frame, stream id in the header, `END` flag (§5.6) |
| `hello` / `challenge` / `auth` / `ready` / `refused`, labels `pocket-link/1/…` | Same messages in `HANDSHAKE` frames, labels `pocket-link/2/…`; `hello` loses `v` and `mode`, gains `hostAbi`, `features` and `maxPayload` (§3.4) |
| Pairing: the `pocketlink://pair` URI as a QR code, the console's camera, the pairing window and secret, mode `pair`, `paired`, the masked key | Dropped: Hub writes the pairing files during the first install (§3.1, §3.2) |
| Refusal `version` | Hub's preamble with `selected` 0 (§4.1) |
| Refusals `unknown_device`, `bad_proof`, `pairing_closed` | `unknown_device` and `bad_proof` kept, `pairing_closed` dropped; `malformed` and `busy` added (§3.8) |
| One companion file holding the key and the last address, rewritten by the console at each link | A key file the device never writes, and a `.last` file for the address (§3.6) |
| `features` in `ready` only | `features` in `hello` and in `ready` (§3.4) |
| `clock` in `ready` / `paired` | Kept in `ready` |
| `net` with `"stream":true`, `net.head`, `net.credit`, `net.end`, `net.error`, `net.cancel` | `net.http` request, `net.head` event, `CREDIT` frame, `END` flag and reply, error reply, `CANCEL` frame (§6.5) |
| `net` without `stream` (feature `net`, whole response) | Dropped: it serves firmware from before the worker domain (`LINK_FEATURE.net` in `link.ts`) |
| `https://companion.pocket/<service>` answered over `net` | Replaced by applet channels and daemons; when Hub stops answering it is open (§11, question 5) |
| `catalog`, its reply, `catalog.changed` | `catalog` request and reply, `catalog.changed` event (§6.4) |
| `install`, `install.head`, `install.error` | `install` request, `install.head` event, stream, reply (§6.4) |
| `agent.*` ctrl messages and streams, companion stream ids with bit 31 | Same JSON in `EVENT` frames; every stream credited (§6.6) |
| `<feature>.*` messages of a product extension on Hub | Dropped: a product's computer side is a daemon behind an applet channel (§7) |
| Byte credit for `net.stream` only, sent as JSON per block | `CREDIT` frames for every stream, an applet channel's included (§5.6) |
| USB carrier (PSP), its own record format | Not in phase one; to become a carrier of this protocol or be retired (§2.0; §11, question 10) |
| Fixed frame limit of 32 KiB + 4 | A limit negotiated per connection, **16 KiB** by default on TCP (§4.4) |
| `globalThis.link` (status, pair, forget, catalog, install, remove, poll) | Kept as the guest API without `pair`; not a wire matter |

The development connection (`contracts/spec/pocket-runtime-wire.ts`,
`products/3ds/src/devserver.c`, `tools/3ds-runtime-client.ts`,
`tools/3ds-dev.ts`, and Pocket Hub's development bridge):

| Development connection | Version 2 |
| --- | --- |
| The 3DS listens on TCP 8131 | Dropped: the device connects to Hub; `devserver.c` is removed |
| UDP 8131 discovery (`PKRD` request, 64-byte reply) | Dropped: Hub knows its linked devices |
| `PKRT` hello carrying the raw 32-byte key, 24-byte ack | Dropped: the pairing handshake (§3) |
| `sdmc:/pocketjs/runtime/dev.key`, `tools/3ds-keys.ts`, `~/.pocketjs/3ds/keys/` | Retired; the link key of the pairing files, written the way `dev.key` was (§3.2, §3.6) |
| The `3ds:wire` lease (`tools/device-lease.ts`), one client at a time, Hub's 30 s idle disconnect | Retired: Hub holds the only connection; the device mutex arbitrates (§8) |
| Ack fields `hostAbi`, `generation`, `flags` (native), `activeHash` | `hello.hostAbi`, `hello.features` (`runtime.native`), the `runtime.status` event |
| `ping` / `pong` with a 4-byte payload | `PING` / `PONG` |
| `ctrl` frames as DevTools JSON lines | The DevTools stream (§6.3) |
| Cached shim `hello` replayed to each new client (`devserver.c` `hello_cache`) | Kept: first line of each new DevTools stream |
| `ctrlDropped` notice for an oversized line | Kept |
| `packageBegin` / `packageChunk` / `packageCommit` / `packageAbort` | `runtime.push` request, `DATA` stream, `CANCEL` (§6.2) |
| `nativeBegin` / `nativeChunk` / `nativeCommit` / `nativeAbort` | `runtime.native.install` request, `DATA` stream, `CANCEL` |
| `launch` (a `.3dsx`) | `runtime.launch` with `native` |
| `screenshotBegin` / `screenshotChunk` / `screenshotEnd`, requested by the line `{"t":"screenshot"}` through the guest's shim | `runtime.screenshot` request, served by the host without the guest |
| Dev menu `X`: screenshot to the connected client | Unsolicited `runtime.screenshot` event and stream |
| `statusRequest`, `runtime.status` record | `runtime.status` request, reply and event |
| `runtime.install` records | `runtime.install` events and the push reply |
| `runtime.native` records | `runtime.native` events and the install reply |
| `log` records (`devserver_report_log`, the shim's console bridge) | `log` events while `runtime.logs` is on (§6.2) |
| `eval`, `getTree`, `inspect`, `pause`, `resume`, `step`, `dumpTape`, `devStats`, `replay` | DevTools lines, unchanged |
| `ui.__dbgActive` / `ui.__dbgConnected` | The DevTools stream exists / `devtools.listen` is on |
| `pocket3d.packs` control lines (`products/3ds/src/packs_delivery.c`) | Not mapped: §11, question 8 |
| `bun run 3ds:dev pair / discover / push / install / launch / probe / dev` | A thin client of Hub's CLI: Hub's setup writes the pairing, Hub's device list, Hub's runtime operations |

## 2. Carriers and discovery

### 2.0 Carriers

**Pocket Link is the only transport between a device and Hub, whatever
joins them: Wi-Fi, Bluetooth or a UART.** The protocol of §3 to §8 is defined
over a **carrier**: one reliable, ordered, two-way byte stream between one
device and Hub. Everything from the preamble (§4.1) on is the same bytes on
every carrier. A carrier adapter on each side supplies the stream and three
things the protocol does not define for all carriers at once:

| A carrier defines | TCP over Wi-Fi (phase one) | Others |
| --- | --- | --- |
| The byte stream | one TCP connection, device to Hub | **UART**: the wire loses and corrupts bytes, so its adapter adds its own framing, a checksum and retransmission below the link and hands the link a clean stream. **Bluetooth**: depends on the mode; a stream mode (RFCOMM, an L2CAP channel) is a stream as it is, a GATT characteristic needs an adapter that segments and orders |
| Discovery: how the device finds Hub | UDP beacons and the direct try (§2.2, §2.3) | the carrier's own means: a cable has nothing to find, Bluetooth has its advertising |
| Admission: how the pairing reaches the device | files written through ftpd or onto the SD card (§3.2) | the carrier's own means; the handshake of §3.3 is the same everywhere |
| The largest frame | **16 KiB** by default (§4.4) | set by the carrier's speed |

**The maximum frame size is negotiated per connection** (`hello.maxPayload`
and `ready.maxPayload`, §3.4, §4.4), because a frame occupies the carrier for
its whole length and nothing overtakes it (§8.1). A **32 KiB frame at
115,200 baud** (11,520 bytes a second with start and stop bits) holds the
wire for **about 2.8 s**: a `PONG` queued behind it waits that long, close to
a third of the 10 s silence limit, and an applet's request waits with it. At
the **700–900 KB/s** measured on a New 3DS over Wi-Fi (§13) the same frame
takes about 40 ms. A carrier therefore offers a limit that keeps one frame's
wire time small against the keepalive and against an applet's patience; a
UART at that speed would offer **1 KiB** (about 90 ms).

**Phase one specifies the TCP carrier alone.** §2.1 to §2.4 are its
discovery. The other carriers are named here so that nothing in §3 to §8
depends on TCP: the handshake carries no address, no message carries a port,
and the limits that depend on speed are negotiated. What is undecided about
them is in §11, question 10.

### 2.1 Ports

| Port | Owner | Use |
| --- | --- | --- |
| UDP **8627** | device | receives Hub's beacons |
| TCP **8628** | Hub | the link listener. **A Hub that cannot bind 8628 listens on an ephemeral port**; its beacons carry the port in use, and a pairing file carries the port at the time of writing (kept from version 1) |

### 2.2 Beacon

Hub sends one **64-byte** datagram **once a second**. The layout is version
1's (`link.ts` "Beacon") with version 2 in byte 4:

```
off 0   u32     magic       'P','K','L','B'  (0x424c4b50 little-endian)
off 4   u8      version     2
off 5   u8      flags       0. Version 1 used bit 0 for an open pairing window
off 6   u16     tcpPort     little-endian, 1..65535
off 8   u8[16]  companion   Hub's id, 16 lowercase hex digits (ASCII)
off 24  u8[40]  name        UTF-8 display name, cut on a code point, NUL-padded
```

**A receiver drops a datagram that is not 64 bytes, has another magic or
another version, a port of 0 or an id that is not 16 lowercase hex digits.**
Version 1's C parser checks the version (`link_proto.c`
`link_parse_beacon`); its TypeScript decoder does not (`protocol.ts`
`decodeBeacon`). Both check it in version 2.

Targets, kept from version 1:
`255.255.255.255`, the broadcast address of each LAN interface (the list
read again every **10 s**), and unicast to the last address of every paired
device. macOS sends a `255.255.255.255` datagram out of the default route
alone, so the per-interface and unicast copies reach a device on a second
network.

### 2.3 What the device does with beacons

- The device listens on UDP 8627 while it holds at least one pairing (§3.1)
  and is not linked. While linked it drains the socket **every 30 frames** without
  acting on beacons (`link.c` `drain_beacons`).
- It follows a beacon only from a companion id it holds a key for and that
  is not under a refusal hold (§3.8). **The datagram's source address and the
  beacon's `tcpPort` are the connect target.**
- **Several Hubs.** A device keeps up to **8** pairings (`link.c`
  `LINK_MAX_COMPANIONS`). It links to one Hub at a time: **the first
  qualifying beacon wins**, and while linked it follows no other beacon. This
  is version 1's rule (`link.c` `poll_beacons`).
- **Direct try.** After **2.5 s** in the search state without a qualifying
  beacon, the device connects to a paired Hub's last address and port, one
  pairing per attempt in turn (`link.c` `try_direct`). LANs that filter
  broadcast still link. **A pairing that has never linked uses the address
  and port Hub wrote into its file** (§3.1).

### 2.4 Reconnect and backoff

| Event | Device action |
| --- | --- |
| TCP connect not complete in **4 s** | drop, back off |
| Handshake not complete **6 s** after connect | drop, back off. Hub closes an unfinished handshake after the same 6 s |
| Connection lost, `CLOSE` received, protocol error | back off |
| Backoff | **1 s, doubling to 8 s**; beacons are drained and not followed while it runs; a link that reaches `ready` resets it to 1 s |
| `refused` (any code), or the device's own `CLOSE` `auth` (§3.8) | hold that Hub for **30 s**: its beacons are ignored and no direct try goes to it |
| A stall of about **100 ms** in a socket call (§13) | none: every timer here is at least 1 s |
| `CLOSE` with `restart` sent by the device itself | the process exits; the next start searches at once |

All values are version 1's (`link.c`: `LINK_BACKOFF_MIN_MS`,
`LINK_BACKOFF_MAX_MS`, `LINK_REFUSED_HOLD_MS`, `LINK_CONNECT_TIMEOUT_MS`,
`LINK_HANDSHAKE_TIMEOUT_MS`).

**Hub keeps one link per device.** When a second connection of a device id
reaches `ready`, Hub closes the older one with `CLOSE` `replaced` (kept from
version 1), so a half-open connection left by a Wi-Fi drop does not block the
new one. **Hub accepts at most 32 connections at a time.**

**Two devices with one device id.** A card image restored onto a second
console gives two consoles the same `device.txt` and key; each reaches
`ready` and replaces the other about once a second. **Hub counts a
replacement only when the older connection is alive**: at the replacement it
sends the older connection a `PING` and waits **2 s** for the `PONG` before
it writes `CLOSE` `replaced`. **At the new connection's `ready` the older
connection's requests, streams and channels end** as they do at a
connection loss (§7.5: one close notice per channel to its daemon), and
frames that still arrive on the older socket are discarded; **only its
socket stays open, for the `PONG`**. A daemon therefore never holds two
generations of one applet of one device id. A
half-open connection left by a Wi-Fi drop answers nothing and is not
counted, so one console at the edge of its range is never taken for two.
**After 3 counted replacements of one device id within 30 s, Hub answers
that id's next `hello` with `refused` `busy`**, which holds the device for
30 s (above), and reports the duplicate id in its device status. The count
starts again after the hold.

## 3. Admission

**Hub writes the pairing onto the device's storage during the first install;
an HMAC-SHA256 handshake proves at every connection that both ends hold the
same 32-byte link key.** Version 1 paired through a QR code that the console
read with its camera (`link.ts` "Pairing URI"). **Version 2 has no pairing on
the wire: no QR code, no camera, no pairing window, no pairing secret and no
mode `pair`.** Phase one has no encryption (§3.9). **Hub writes the key
itself; no secret is exchanged on the wire to mint one.** §11, question 7
lists what this costs.

### 3.1 The pairing record

A pairing is **two files on the device and one record in Hub**:

| Where | File or record | Content |
| --- | --- | --- |
| Device | `device.txt` (3DS: `sdmc:/pocketjs/link/device.txt`) | the device id: 8 random bytes as **16 lowercase hex digits** and a newline |
| Device | `companions/<hub id>.txt` (3DS: `sdmc:/pocketjs/link/companions/`) | lines `key=` (the link key, 64 lowercase hex digits), `name=` (Hub's display name), `address=` (an IPv4 address of Hub at the time of writing), `port=` (Hub's link port at that time). **Hub writes this file; the device reads it and never opens it for writing** (§3.6) |
| Hub | one record per device | the same device id and key, with the fields of §3.6 |

The file formats are version 1's (`link.c` `save_companion`,
`load_device_id`), so the device reads them with the parser it has. **The link
key is 32 random bytes that Hub mints for one device**; Hub never gives two
devices the same key. `address` and `port` serve the direct try (§2.3) until
the first link; from then on the device keeps the last address in a file of
its own beside the key file (§3.6).

### 3.2 How Hub writes a pairing

Hub writes a pairing through the channel that puts the program on the
device, the one the development connection's `dev.key` travelled
(`products/3ds/README.md`, "In-process development connection"):

Hub runs **one procedure against the device's storage, reached over ftpd or
as the SD card mounted in the computer's reader**:

1. **Read `device.txt`.** A file that holds 16 lowercase hex digits and at
   most one newline is kept, and its id is the device's; a missing file or
   another content gets a new id, written with its folders.
2. **List `companions/`.** Hub counts the files the device would load
   (§3.6): a name of 16 lowercase hex digits and `.txt`, with a `key=` line
   of 64 hex digits. When **8** of them exist and none is this Hub's, Hub
   writes nothing and tells the owner to remove a computer on the device
   (`link.forget`) or to delete one of the files: the device reads at most 8.
   A leftover `<hub id>.new` of this Hub (step 4) is deleted here.
3. **Read `companions/<hub id>.txt`.** The read has three outcomes, and Hub
   tells them apart:
   - **The read failed** (the FTP data connection dropped, the transfer
     timed out, the card reported an I/O error): **the setup ends here,
     reported as failed, and Hub's record stays as it was.** A failed read
     says nothing about the file, so no candidate is discarded for it.
   - **The storage answered that the file is absent** (ftpd's reply to a
     missing file, "no such file" from the mounted card), or the file was
     read whole and holds no valid `key=` line: the file holds no
     candidate.
   - The file was read whole and holds a key.

   **After a completed read Hub discards every candidate of its record that
   the file does not hold**; a file that is absent or holds no candidate
   leaves the record without a key. When the file's key is the record's key,
   the key file is left alone: Hub compares the `address=` and `port=` the
   device would use (the `.last` file's when it exists and parses, else the
   key file's, §3.6) with its own. **Over ftpd, "its own" is the local
   address of the FTP connection**, the address this console reaches Hub at.
   **On a mounted card Hub cannot tell which of its interfaces faces the
   console, so it leaves `.last` alone when the address there is any of
   Hub's current interface addresses and the port matches**: that address
   may be the one a `ready` proved. Hub **writes
   `companions/<hub id>.last` with the name, address and port it has now**
   (to a temporary file renamed over the old one, then read back) only when
   the port differs or the address is none of them (over ftpd: when it is
   not the FTP connection's local address), so the device's next start
   tries an address Hub holds. **An address change never
   rewrites the key file**, so it cannot cost the pairing.
4. Otherwise Hub mints a key and **stores it in its record as a candidate
   before it writes** (below). **The write goes to `companions/<hub id>.new`,
   which Hub reads back and compares byte for byte; only after a match does
   it delete `companions/<hub id>.last`, then delete `<hub id>.txt` and
   rename `.new` to it**, then read `<hub id>.txt` and `device.txt` back
   once more. A match makes the candidate the record's key. **The new key
   file carries Hub's current address, and `.last` goes before the key file
   is replaced** (§3.6): a cut after the rename then leaves no stale last
   address to shadow the new file. The device never loads a `.new` file (its
   name does not end in `.txt`), so a transfer cut midway leaves the old key
   file whole.

**A setup without a matching final readback is reported to the owner as
failed**, with the step that failed, and Hub's device status shows the
device as "setup not confirmed" until a `ready` or a later setup settles it.

**A write whose outcome Hub cannot read back leaves two candidate keys.**
What a power cut or a lost connection leaves on the card, by the step it
falls in:

| Cut during | The card holds | Result |
| --- | --- | --- |
| the write of `<hub id>.new` | the old key file whole (or none, at a first setup), and a partial `.new` | the pairing is unchanged; the next setup's step 2 removes the `.new` |
| after `.last` is deleted, before the key file is | the old key file whole, a whole `.new`, no `.last` | the pairing is unchanged; the device's direct try uses the old key file's address until a beacon or a `ready` writes `.last` again; the next setup's step 2 removes the `.new` |
| between the delete and the rename | no `<hub id>.txt`, no `.last`, and a whole `.new` | **no pairing with this Hub until the next setup**, whose step 2 removes the `.new` and whose step 4 writes again; this setup is reported as failed |
| after the rename | the new key, no `.last` | the two candidates settle at the first `ready` (below) |

Hub's record keeps both keys meanwhile: the key it had, when it had one,
and the candidate.

- At a connection of that device Hub proves with **one** candidate, the
  newer first.
- **When the device answers `CLOSE` `auth`, Hub proves with the other
  candidate at that device's next connection**, and alternates from there.
  The device holds Hub for 30 s after its own `CLOSE` `auth` (§3.8), so the
  second try comes 30 s after the first.
- **The first `ready` settles it**: the key that passed is the record's key
  and the other candidate is deleted. A later setup that reads the file
  settles it as well: step 3 keeps the candidate the file holds and drops
  the rest before anything is minted, so no rerun adds a third key.

A record with a single key behaves as before: a `CLOSE` `auth` changes
nothing in Hub.

- **There is no folder of files for the owner to copy.** A copy that merges
  folders can keep the card's `device.txt` and take the new companion file,
  which was minted for another id, and Hub cannot read the result back. The
  SD-card path is the procedure above on the mounted card.
- **The program reads the pairing files when it starts.** A program that
  runs while Hub writes them links after its next start. The first install
  writes the files before the program has run once.
- **The transfer is not protected.** ftpd speaks plain FTP, and the SD card
  holds the key as text (version 1 stored it the same way). §3.9 says what
  that gives an observer of the setup.

A carrier other than TCP brings its own way to place the two files (§2.0);
the files and the handshake are the same.

### 3.3 Order of a connection

```
device                                   Hub
  | -- TCP connect ----------------------> |
  | -- preamble (8 bytes) ---------------> |
  | -- HANDSHAKE hello ------------------> |   same write: the device speaks one version (§4.1)
  | <------------------ preamble (8 bytes) |   selected version 2, or 0 and close
  | <------------- HANDSHAKE challenge     |   or refused
  |   device checks challenge.proof        |
  | -- HANDSHAKE auth -------------------> |
  | <------------------ HANDSHAKE ready    |   or refused
  |   link up: §5 frames in both ways      |
```

Before `ready`, only `HANDSHAKE`, `PING`, `PONG` and `CLOSE` are valid; any
other frame type closes the connection with `protocol`. `HANDSHAKE` frames
carry id 0 and one JSON object of at most **1,024 bytes**
(LINK_MAX_HANDSHAKE), on every carrier: the smallest receive buffer a device
may offer (§4.4) holds every handshake message. **A `HANDSHAKE` frame after
`ready` closes the connection with `protocol`.**

### 3.4 Handshake messages

**hello** (device to Hub):

| Field | Type | Limit | Content |
| --- | --- | --- | --- |
| `t` | string | | `"hello"` |
| `device` | string | 16 hex | the device id (§3.1) |
| `companion` | string | 16 hex | the Hub id the device means: the id in its pairing file's name |
| `nonce` | string | 32 hex | nD: 16 random bytes, fresh per connection |
| `name` | string | 64 bytes | the device's display name (3DS: the CFG user name) |
| `model` | string | 32 bytes | e.g. `"New Nintendo 3DS XL"` |
| `target` | string | 15 bytes | the build target, e.g. `"3ds-dev"`; Hub's catalog filters on it |
| `hostAbi` | integer | u32 | the runtime's host ABI (`POCKETJS_HOST_ABI`), which a pushed package must match |
| `features` | string[] | 16 entries of 24 bytes | the groups the device serves or uses (§6.1) |
| `maxPayload` | integer | 1,024 to 32,768 | the largest frame payload the device accepts on this carrier (§4.4) |

Version 1's `v` field is dropped: the preamble carries the version. Version
1's `mode` is dropped: every connection is the connection of a paired
device. `hostAbi` and `features` replace the development connection's ack
fields (`pocket-runtime-wire.ts` `decodePocketRuntimeAck`).

**challenge** (Hub to device): `{"t":"challenge","nonce":<nC, 32 hex>,"proof":<64 hex>}`.

**auth** (device to Hub): `{"t":"auth","proof":<64 hex>}`.

**ready** (Hub to device):

| Field | Type | Content |
| --- | --- | --- |
| `t` | string | `"ready"` |
| `name` | string | Hub's full display name (≤ 64 bytes) |
| `features` | string[] | the groups Hub serves (§6.1) |
| `maxPayload` | integer | the largest frame payload Hub accepts on this carrier, 1,024 to 32,768 (§4.4). **A device that reads a value outside that range closes with `CLOSE` `protocol`**; Hub answers a `hello.maxPayload` outside it with `refused` `malformed` |
| `clock` | object | `{"utc": <epoch ms>, "local": <epoch ms>}`: Hub's wall clock at sending, and the same instant in its zone (`local - utc` is its UTC offset). Kept from version 1 (`link.ts` "Handshake"): a device whose clock is unset shows Hub's time, also after the link drops |

**refused** (Hub to device, in place of `challenge` or of `ready`):
`{"t":"refused","code":<§3.8>,"message":<text ≤ 160 bytes>}`. Hub closes the
connection after writing it.

### 3.5 HMAC inputs

The HMAC is **HMAC-SHA256**. **Its key is the raw 32 bytes of the link
key.** Its message is the UTF-8 string built from the label, the nonces as
sent (32 lowercase hex digits each) and the ids as sent (16 lowercase hex
digits each), joined by `\n` (0x0A), with no trailing newline:

```
challenge.proof = HMAC(linkKey, "pocket-link/2/companion" \n nD \n nC \n device \n companion)
auth.proof      = HMAC(linkKey, "pocket-link/2/console"   \n nD \n nC \n device \n companion)
```

| Label | Use |
| --- | --- |
| `pocket-link/2/companion` | Hub's proof |
| `pocket-link/2/console` | the device's proof |
| `pocket-link/2/session` | **reserved** for the session key of a later encrypted version (§3.10); unused in phase one |

The string format, the raw-byte key and the hex conventions are version 1's
(`protocol.ts` `proofMessage`, `linkHmac`); the labels change, and version
1's `pocket-link/1/key` mask has no successor because no key travels. Proofs
travel as 64 lowercase hex digits; **both sides compare them in constant
time** (`protocol.ts` `proofEquals`, `link.c` `constant_time_equal`). **The
device checks `challenge.proof` before it sends `auth`**, so a Hub without
the key learns no proof it can replay.

### 3.6 What each side stores

| Side | Record | Content |
| --- | --- | --- |
| Device | `device.txt` | the device id (§3.1). A device that starts without the file makes one, as version 1 does; Hub's setup reads it before it writes a pairing (§3.2) |
| Device | `companions/<companion id>.txt`, at most 8 | `key=` (64 hex), and the `name=`, `address=`, `port=` Hub knew when it wrote the file. **Written by Hub's setup alone; the device opens it for reading only** |
| Device | `companions/<companion id>.last` | `name=`, `address=` (last IPv4), `port=`: what the last `ready` gave. **The device writes it only when a value changed**, to a temporary file that it renames over the old one. Its values replace the key file's when it exists and parses; a missing or damaged `.last` falls back to the key file's. **Hub's setup writes it with Hub's current name, address and port when the device would use another address** (§3.2 step 3), so a stale last address never outlives a setup, and a new key file's write (§3.2 step 4) deletes it |
| Hub | its id | 8 random bytes as 16 lowercase hex digits, made once |
| Hub | one record per paired device, in a file of mode **0600** | `id`, `name`, `model`, `key` (64 hex), a second candidate key while a setup is unconfirmed (§3.2), `target`, `hostAbi`, `lastAddress`, `lastSeen` |
| Hub | one counter for the whole Hub, stored beside the records | `lastGeneration` (§7.4) |

**No key appears in a log line, a status answer or the IPC.**

**The device never writes a key file.** Version 1's client rewrote the whole
companion file at each `ready` by removing the old file and renaming a
temporary one over it (`link.c` `save_companion`, `write_atomic`); a power
cut between the two steps left no file, and the repair was a new QR scan.
Version 2 has no pairing on the wire, so a lost key file would need ftpd or
a card reader again. **This is a change to the C client's behaviour**: the
values that change at a link move to the `.last` file, whose loss costs only
the last address.

**A device reads at most 8 key files** (`link.c` `LINK_MAX_COMPANIONS`): the
`.txt` files of `companions/` in directory order, as `load_companions` does,
and no file of another suffix (a `.new` left by an interrupted setup is not
a pairing);
it reads no modification time, which would depend on a console clock that
may be unset. **A ninth `.txt` file is a setup error**: the device ignores
it and reports "more than 8 computers" in its link status. Hub's setup
refuses to write a ninth (§3.2), so the case arises only from files copied
by hand.

### 3.7 Connect, a second computer, forgetting

- **Connect.** Hub looks up `hello.device`; if `hello.companion` is not Hub's
  own id or it holds no key for the device, it answers `refused`
  `unknown_device` without a challenge. On `ready`, both sides update the
  stored address, port and name.
- **A second computer.** Its Hub runs the procedure of §3.2 over ftpd or on
  the mounted card: it keeps the device's `device.txt` and writes its own
  `companions/<hub id>.txt`, so the two pairings do not touch each other.
  **Pairing another computer needs ftpd running on the device, or the SD
  card in a reader, again.**
- **Forgetting on Hub.** Hub deletes its record and closes the connection
  with `CLOSE` `forgotten`; the device's next connection gets `refused`
  `unknown_device`, and the device shows that this computer has to set it up
  again. The file on the device stays until the device forgets it or a setup
  overwrites it.
- **Forgetting on the device.** `link.forget` deletes the companion file and
  closes the link when it is the linked one. No message tells Hub (as in
  version 1); Hub's record stays until its owner removes it, and a later
  setup finds no file and mints a new key.
- **A new device id** arises only when `device.txt` is missing or damaged
  at a setup, or was replaced by hand. It makes every earlier pairing of
  that card unusable: the other Hubs answer `unknown_device` and set the
  device up again, and their old records stay until their owners remove
  them.
- **A card moved to another console** carries its device id and keys with
  it: Hub sees the same device with another `model`. Two consoles running
  copies of one card are the duplicate of §2.4.

### 3.8 Refusals

| Code | Sent instead of | When |
| --- | --- | --- |
| `unknown_device` | `challenge` | Hub holds no key for `device`, or `companion` names another Hub |
| `bad_proof` | `ready` | `auth.proof` does not verify |
| `malformed` | `challenge` | a field is missing, has the wrong type or breaks its limit. Version 1 closed without a code |
| `busy` | `challenge` | Hub is at its connection limit |

**The device treats every refusal as an answer**: it closes and holds that
Hub for 30 s (§2.4). A version mismatch is not a refusal; it is answered in
the preamble (§4.1). Version 1's `pairing_closed` has no use without a
pairing window.

When `challenge.proof` does not verify, the device sends `CLOSE` `auth` and
closes: the Hub at that address does not hold this device's key, or holds
two candidates and tried the other one (§3.2). **The device holds that Hub
for 30 s after its own `CLOSE` `auth`**, as after a refusal, so a key
mismatch costs two connections a minute instead of one every 1 to 8 s.

### 3.9 What an attacker on the same LAN can do

**After the handshake every frame is plaintext and unauthenticated.**
Version 1 made the same assumption of the owner's LAN (`link.ts` "Trust");
version 2 does not change it in phase one.

A **passive** observer on the network reads:

- every package, `.3dsx`, screenshot, log line, DevTools line, eval source
  and result;
- every `net.http` request and response between device and Hub, including
  URLs, cookies and authorization headers an applet sends: Hub reaches the
  site over TLS, the link leg is plaintext;
- the agent's microphone audio, transcripts, replies and screen frames;
- every applet channel message and stream.

**It does not learn the link key from a connection**: the key never travels
on the link, and the proofs are HMACs over fresh nonces. **It learns the key
when it observes the setup**: the pairing file crosses the LAN in plain FTP
(§3.2), and anyone who reads the SD card reads the key. Version 1 sent the
key masked with an HMAC of a secret shown in the QR code, so an observer
needed the screen as well as the network; version 2 gives that up with the
camera, on the same assumption of a trusted LAN that leaves the frames in
plaintext (§11, question 7). The development connection's `dev.key` crossed
the LAN the same way and then travelled in every hello.

An **active** attacker (ARP spoofing, a hostile access point) can, after a
real handshake has passed:

- take over the connection and send any frame to the device as Hub: **push a
  package, write and start a `.3dsx` (native code on the console)**, eval in
  the running applet, read screenshots;
- send any frame to Hub as the device: `net.http` requests on the device's
  behalf (Hub's destination policy still refuses private addresses, §6.5),
  catalog installs, and applet channels asserting any applet id;
- relay a fresh handshake between the real device and the real Hub and then
  do the above;
- forge beacons and deny service. A forged Hub cannot pass the device's
  proof check, so it learns nothing and the device refuses it.

It cannot complete a handshake of its own without the key. **Compared with the development connection, version 2 sends
no key on the wire**: the development connection's hello carried the 32-byte
key itself (`pocket-runtime-wire.ts` `encodePocketRuntimeHello`, checked by
`dev_protocol.c` `pocket_runtime_verify_hello`), so one observed connection
gave an observer native-code access to the console for good.

**Phase one accepts this on the owner's LAN.** The link serves a console on
a home network, and encryption is left to a later version (§3.10).

### 3.10 Where encryption fits later

A later version can add encryption without a new frame format:

1. `hello` offers ciphers (`"enc": [...]`) and `ready` selects one.
2. Both sides derive `sessionKey = HMAC(linkKey, "pocket-link/2/session" \n nD \n nC)`.
3. Every frame after `ready` keeps its 12-byte header in clear as associated
   data, sets flag bit 7 (**0x80, reserved on every frame type now**), and
   carries an AEAD-sealed payload with a 16-byte tag; the nonce is a
   per-direction frame counter. `length` counts the tag, so the wire limit
   becomes the negotiated payload limit + 16.
4. The handshake should then also bind the `hello` and `challenge` bytes
   into the key derivation; in phase one an active attacker can change any
   frame anyway, so binding them now buys nothing.

## 4. Framing

All integers are **little-endian**, as in version 1, the development
connection and the 3DS's ARM11.

### 4.1 Preamble and version negotiation

Each side sends an 8-byte preamble before its first frame, the device first:

```
off 0  u32  magic     'P','K','L','K'  (0x4b4c4b50 little-endian)
off 4  u8   highest   the highest version the sender speaks
off 5  u8   lowest    the lowest version the sender speaks
off 6  u8   selected  device: 0. Hub: the version both will use, or 0 for none
off 7  u8   reserved  0
```

Hub selects the highest version inside both ranges. **With no common
version Hub sends its preamble with `selected = 0` and closes**, without
reading further; the device reports "Hub speaks Pocket Link
`lowest`–`highest`". The device closes when `selected` is outside its own
range or the magic is wrong. A version-1 console's preamble
(`PKLK`, 1, 0, 0, 0) reads as `highest = 1` and gets `selected = 0`.

**When the device sends its `hello` depends on its range**, because the frame
format and the `hello` belong to a version:

- **A device whose range is one version (`lowest = highest`) sends its
  preamble and its `hello` in the same write.** Only that version can be
  selected, so the `hello` is in the right format whatever Hub answers. A
  version-2 device sends `highest = 2, lowest = 2, selected = 0` this way.
- **A device whose range spans several versions (`lowest < highest`) sends
  its preamble alone, waits for Hub's preamble, and then sends the `hello` of
  the selected version.** This costs one round trip, and only for such
  devices.
- **Hub reads nothing after the device's preamble until it has sent its own.**
  The bytes that follow are then read as frames of the selected version. A
  several-version device that did not wait and sent a `hello` of another
  version fails that version's frame checks (§4.7) like any malformed
  frame. Hub cannot tell from a socket whether a byte arrived before or
  after its own preamble left, so no rule rests on that order.
- **Every later version keeps this 8-byte preamble and these rules
  unchanged**, so a version-3 Hub can still serve a version-2 device and a
  device that speaks versions 2 and 3 can still reach a version-2 Hub.

Pipelining the `hello` of the device's highest version instead, and having
Hub discard it when it selects a lower one, would need Hub to find the end of
a message in a format it does not speak; waiting costs less.

Version 1 sent a preamble from the console alone and answered a version
mismatch with a JSON `refused` frame in version 1's own format, which a
console of another version may not parse. The
two-way preamble answers before any frame format is assumed.

### 4.2 Frame header

Every frame after the preamble, in both directions:

```
off 0  u8   type      §4.3
off 1  u8   flags     per type; bit 7 (0x80) reserved for encryption
off 2  u16  reserved  0
off 4  u32  length    payload bytes that follow the header
off 8  u32  id        request, stream or channel id (§5.1); 0 where the type says so
off 12 ...  payload
```

**The header is 12 bytes, and every frame carries its id there.** Version 1
put a stream id in the first 4 bytes of a `data` payload and a request id
inside the JSON of a `ctrl` frame (`link.ts` "Connection"), so the device
parsed JSON to route a reply. Version 2 routes every reply, stream chunk
and credit grant by the header, and 12 bytes keep the payload
4-byte aligned in a 4-byte aligned buffer.

**A receiver closes the connection with `CLOSE` `protocol` when** `reserved`
is not 0, a flag bit is set that the type does not define, `id` breaks the
type's rule, or the payload breaks the type's size rule; with `CLOSE`
`too_large` when `length` exceeds the payload limit in force (§4.4; it does
not read the payload).

### 4.3 Frame types

| Type | Name | `id` | Flags | Payload |
| --- | --- | --- | --- | --- |
| 0x01 | `PING` | 0 | none | 4 bytes, opaque |
| 0x02 | `PONG` | 0 | none | the 4 bytes of the `PING` it answers |
| 0x03 | `CLOSE` | 0 | none | u16 code (§4.8), u16 0, UTF-8 reason of at most 120 bytes |
| 0x04 | `HANDSHAKE` | 0 | none | one JSON object, at most 1,024 bytes (§3.4); before `ready` only |
| 0x10 | `REQUEST` | the request id, never 0 | 0x02 `APP`, 0x04 `BODY` (§7.2). **`BODY` without `APP` is an undefined flag** (§4.7): a system request's section says whether a body follows | one JSON object with string `t`; with `APP`, a u32 channel id before it |
| 0x11 | `REPLY` | the request id | 0x01 `ERROR` | one JSON object |
| 0x12 | `EVENT` | 0; or the id of a stream this event opens; or the id of an open request or channel it belongs to | 0x02 `APP` (§7.2) | one JSON object with string `t`; with `APP`, a u32 channel id before it |
| 0x13 | `CANCEL` | the request id | none | empty |
| 0x20 | `DATA` | the stream id | 0x01 `END` | 1 byte to the payload limit; 0 bytes only with `END` |
| 0x21 | `CREDIT` | a stream id, or an applet channel's id | none | u32, at least 1: bytes granted on a stream; **events granted when the id is a channel's** (§5.6) |
| 0x22 | `RESET` | the stream id | none | u16 code (§5.6), u16 0 |

**There is no frame type of its own for applet traffic.** An applet channel
uses `REQUEST`, `REPLY`, `EVENT`, `CANCEL`, `DATA`, `CREDIT` and `RESET` as
the system messages do; the `APP` flag and the channel id mark the two
frames that start something (§7.2).

A JSON payload is one UTF-8 JSON object with no byte-order mark and no
trailing newline. Integers in it are at most 2^53 − 1; 64-bit hashes travel as
16 lowercase hex digits, as version 1's catalog and the development
connection's records do. **Receivers ignore unknown JSON fields.**

### 4.4 Sizes

| Constant | Value | Why |
| --- | --- | --- |
| LINK_PREAMBLE_BYTES | **8** | version 1's size |
| LINK_HEADER_BYTES | **12** | §4.2 |
| LINK_MAX_HANDSHAKE | **1,024** | the largest handshake message is `hello`, about 800 bytes at every limit; this limit holds before `ready` on every carrier and equals the smallest buffer a device may offer |
| LINK_PAYLOAD_CEILING | **32,768** | no carrier negotiates more. The device keeps one receive buffer that holds a whole frame (`link.c` `LINK_RX_BYTES`, comment in `pump_rx`), and version 1's link already allocates 32 KiB + header there. **A 64 KiB write stalled one socket call for 660 ms** on the 3DS (§13), and the development connection's 64 KiB frame cost `devserver.c` a static 64 KiB receive buffer |
| LINK_TCP_PAYLOAD | **16,384** | what both sides offer on the TCP carrier (below) |
| LINK_MIN_PAYLOAD | **1,024** | the least a carrier may offer. The handshake, the two paged row lists (§6.2, §6.4) and a `log` event fit it. **`net.http` does not**: it is in use from a payload limit of **12,288** up (§6.5). The other messages of §6 have not been checked against the floor field by field (§11, question 13) |

**The payload limit of a connection is `min(hello.maxPayload,
ready.maxPayload)`**, each between LINK_MIN_PAYLOAD and LINK_PAYLOAD_CEILING,
and it applies to every frame after `ready` in both directions. This page
calls it LINK_MAX_PAYLOAD. A `REQUEST`, `REPLY` or `EVENT` JSON object fits
one frame of that size (LINK_MAX_CTRL = LINK_MAX_PAYLOAD; with the `APP`
flag the 4-byte channel id comes out of it, §7.2); the device parses it in
place in its receive buffer. **Every size limit of a JSON field on this page
counts the bytes of its encoded form in the frame**, escapes included, so a
limit read off the wire is the limit checked.

**Why 16 KiB on TCP.** Throughput on the 3DS does not depend on the write
size: **700–900 KB/s for writes of 1 KiB to 32 KiB** in both directions
(§13), so a smaller frame costs no speed; the header is 12 of 16,396 bytes
(0.07 %). What the frame size sets is how long one bulk frame holds the
write queue ahead of a small message (§8.1): at about 800 KB/s a **16 KiB
frame occupies the connection for about 20 ms**, a 32 KiB frame for about
40 ms, against a round trip of **about 8 ms** for a small message. 16 KiB
keeps the wait behind one chunk near two round trips and halves the device's
receive buffer. An 8 KiB limit would halve the wait again and leave less
room for one-frame control messages; the two row lists that can exceed a
frame are paged (§6.2, §6.4).

### 4.5 No fragmentation

**No message spans frames.** A JSON message fits one frame; a byte stream is
cut by its sender at any boundary into `DATA` frames. Content larger than
one frame travels as a stream, an applet's included (§7.2): a DevTools
tree dump, which runs past 16 KiB on an app of a few hundred nodes
(`pocket-runtime-wire.ts` `POCKET_RUNTIME_MAX_CTRL_BYTES` comment), rides the
DevTools stream (§6.3), not a control frame. Fragmented messages would need a
reassembly buffer per open message on the device.

### 4.6 Keepalive

- **The device sends `PING` every 3 s** while linked; the payload is a 4-byte
  counter of its choice. Hub may also ping.
- The receiver of a `PING` answers `PONG` with the same 4 bytes. The echo lets
  the device measure the round trip with pings outstanding (`link.c` reports
  `rttMs`).
- **Either side closes with `CLOSE` `silence` after 10 s without receiving a
  frame of any type.** Any frame counts, so a long transfer keeps the link
  alive in both directions: the receiver of a stream sends `CREDIT` frames.

The intervals are version 1's (`LINK_PING_MS`, `LINK_SILENCE_MS`; the 10 s
covers a 5.7 s stall measured on a small companion, `link.ts`
`LINK_USB_SILENCE_MS` comment). **They hold against the stall of about
100 ms that every measured run on the 3DS showed** (§13): one stall delays a
`PONG` by a thirtieth of the ping interval and a hundredth of the silence
limit. A measured round trip reads about 8 ms and about 100 ms when it
meets a stall, so a reader of `rttMs` takes a minimum or a median over
several pings, not one sample. **The device queues `PONG` and `PING` in a
reserve of its send buffer that no other frame uses (§8.2).** The
development connection answered a heartbeat only once its send queue was
empty (`devserver.c` `send_client`), so a `.3dsx` upload held answers off for
most of a minute and its client had to allow 180 s of silence.

### 4.7 Unknown and oversized frames

| Case | Receiver |
| --- | --- |
| Unknown frame type after `ready` | skips `length` bytes (kept from version 1) |
| Any type but `HANDSHAKE`, `PING`, `PONG`, `CLOSE` before `ready` | `CLOSE` `protocol` |
| `length` > LINK_MAX_PAYLOAD | `CLOSE` `too_large`, without reading the payload |
| Undefined flag bit (`BODY` without `APP` among them), non-zero `reserved`, bad id, bad payload size | `CLOSE` `protocol` |
| `HANDSHAKE` after `ready` | `CLOSE` `protocol` |
| `REQUEST` whose payload is not a JSON object with string `t` | `REPLY` `ERROR` `malformed` |
| `REQUEST` with an unknown `t` | `REPLY` `ERROR` `unknown_message`. Version 1 ignored unknown `t` values (`link.c` `handle_ctrl`), which left the requester waiting for its timeout |
| `EVENT` with an unknown `t`, or unparsable | ignored; **when its header id is a fresh id of the sender's range, the receiver answers `RESET` `refused` for that id**, so a sender that opened a stream with it does not wait for credit (§5.3) |
| `REPLY`, `CANCEL`, `DATA`, `CREDIT`, `RESET` for an id the receiver does not hold | ignored (a cancelled or closed id, or one of a closed channel); `DATA` past credit for a held id closes with `flow` |
| `EVENT` without `APP` whose non-zero id is of the receiver's own range and names nothing held | ignored whatever its `t`: late progress, for instance one that crossed a `channel.close` (§5.3, step 3) |
| `EVENT` of a channel past the event units its receiver granted | `channel.close` `overflow` for that channel; the link stays (§5.6) |
| `REQUEST` with `APP` naming a channel that is not open | `REPLY` `ERROR` `no_channel` |
| `EVENT` with `APP` naming a channel that is not open | ignored; when it opens a stream, `RESET` `refused` |
| `REQUEST` or `EVENT` with `APP` whose JSON object is over LINK_APP_MSG (§7.6) | the request gets `REPLY` `ERROR` `too_large`; the event is dropped, and `RESET` `refused` answers the stream it opens |

### 4.8 Closing the link

The side that ends the link sends `CLOSE`, stops writing, and closes the
socket once the peer closes or **1 s** later. The receiver of `CLOSE` closes.
**A closed connection fails every open request, stream and channel on both
sides; nothing is replayed on the next connection** (kept from version 1).

| Code | Name | Sent by | When |
| --- | --- | --- | --- |
| 1 | `going_away` | either | the sender stops: the device powers off or sleeps, Hub quits |
| 2 | `protocol` | either | a frame broke a rule of §4 or §5 |
| 3 | `too_large` | either | `length` over the limit |
| 4 | `silence` | either | 10 s without a frame |
| 5 | `flow` | either | `DATA` bytes past credit, or a grant over the cap (§5.6) |
| 6 | `auth` | device | `challenge.proof` did not verify |
| 7 | `replaced` | Hub | a newer connection of the same device reached `ready` |
| 8 | `forgotten` | Hub | the owner forgot the device |
| 9 | `restart` | device | the device exits to start a `.3dsx` (§6.2); it reconnects when the new program runs |
| 10 | reserved | | version 1's `pairing`: a pairing started on the device. Version 2 has none (§3) |
| 11 | `handshake_timeout` | either | 6 s without completing the handshake |

A receiver treats an unknown code as `going_away`.

## 5. Requests, replies, events and streams

### 5.1 Ids

| Range | Allocated by |
| --- | --- |
| `0x00000001`–`0x7fffffff` | the device |
| `0x80000001`–`0xffffffff` (bit 31 set) | Hub |
| `0`, `0x80000000` | never allocated and **in neither range**; `0` means "no id" in `PING`, `PONG`, `CLOSE`, `HANDSHAKE` and id-less `EVENT` frames. A receiver that tests bit 31 to find an id's range tests for `0x80000000` first: a frame that carries it has a bad id (§4.7) |

The bit-31 rule is version 1's for streams the companion opens
(`contracts/spec/agent.ts` `AGENT_COMPANION_STREAM`), extended to every id Hub allocates.
**Each side allocates request ids and ids of streams it opens by an event
from one counter, an applet channel's requests and streams included; the
device takes channel ids from the same counter, and never reuses an id within a connection**, so an
id names at most one thing on a connection and `CREDIT` needs no type field.
**The order in which a side queues the first frames of its ids is free**: a
stream id that a process allocated before a later request's id may reach
the wire after it (the agent's stream ids travel inside JSON composed ahead
of the frame, §6.6), and no receiver rule depends on ids growing.
A side that exhausts its 2^31 − 1 ids closes with `going_away` and
reconnects. Version 1's device took request and stream ids from one sequence
too (`link.c` `take_id`).

### 5.2 Requests and replies

- A `REQUEST` names its operation in `t`. **It ends with one `REPLY` with the
  same id, never two.** A `REPLY` without the `ERROR` flag carries the result;
  with `ERROR` its payload is
  `{"code": <string>, "message": <text ≤ 240 bytes>, ...}`.
- Before the `REPLY`, the responder may send `EVENT` frames whose header id is
  the request id (progress), and the request's stream carries the request id
  as its stream id (§5.6).
- **The responder queues the `REPLY` after every `EVENT` and `DATA` frame of
  the request**, so a `REPLY` read means nothing more arrives for that id.
  **The requester therefore reads the request's stream before the `REPLY`,
  not after it**: bytes longer than one window arrive only while the
  requester grants credit, and the `REPLY` waits behind them. A responder
  that sends bytes announces them in a progress event first (`install.head`,
  `net.head`, `runtime.screenshot`; an applet's head event, §7.2).
  Two requests are the exception: the `REPLY` of `devtools.open` (§6.3) and
  of `channel.open` (§7.1) opens a stream or channel that keeps the request's
  id until the connection or the channel ends.
- A responder holds a bounded number of open requests from its peer (§9). One
  over the bound gets `REPLY` `ERROR` `busy` at once.
- Both sides send requests. Hub's requests are the runtime operations; the
  device's are catalog, install, `net.http`, `devtools.open` and
  `channel.open`. **Inside an applet channel both the applet and its daemon
  send requests** (§7.2).

Error codes every group uses:

| Code | Meaning |
| --- | --- |
| `malformed` | the payload is not the message's shape or breaks a limit |
| `unknown_message` | the responder does not know `t` |
| `unsupported` | the responder does not serve the group (§6.1), or this device cannot do it |
| `busy` | a bound is reached or the resource is held; retrying later can succeed |
| `cancelled` | the requester sent `CANCEL` |
| `timeout` | the responder waited 30 s on a stream of the request |
| `too_large` | a declared size is over its limit |
| `not_found` | the named app, file or package does not exist |
| `rejected` | the device checked the content and refused it; `message` says why |
| `transfer` | the stream ended short, long, or out of order |
| `storage` | the device could not write or flush |
| `no_channel` | an `APP` request names a channel that is not open (§7.2) |
| `changed` | a paged request names a revision that is no longer current; the requester starts again from the first page (§6.4) |
| `internal` | anything else |

`closed` is not sent: it is what a side reports on its own side for requests open
when the connection ends.

### 5.3 Events

An `EVENT` is one message without a reply. Its header id is 0 for a
standalone event (`catalog.changed`, `runtime.status`, `log`, the agent's
messages), the id of an open request for progress, the id of a channel for
`channel.close`, or **a fresh id of the sender when the event opens a stream**
(`agent.screen`, `agent.glyphs`, `agent.audio`, `agent.shot`, an unsolicited
`runtime.screenshot`).

**A receiver reads an `EVENT` in four steps, the header id first:**

1. **The header id is an open request of an applet channel** (a request an
   `APP` frame started, in either direction, with no `REPLY` yet): the event
   is that request's progress, **whatever its `t`**. The name belongs to the
   applet (§7.2), and a progress event named `log` or `features` is the
   applet's and is never read as the system event of that name.
2. **The frame carries the `APP` flag**: it is read by its flag and its
   channel id (below).
3. **The header id is a non-zero id of the receiver's own range (§5.1) and
   names nothing the receiver holds (no open request or channel): the event
   is ignored, whatever its `t`.** This is a late frame: progress for a
   request the receiver sent and has released, by a reply, a cancel or a
   `channel.close` that crossed it. Its `t` may be an applet's name that
   equals a system event's (`log`, `features`), so the receiver must not
   reach step 4 with it. **One test of the id's range decides it; the
   receiver keeps no mark and no per-id memory.** Every late progress event
   carries an id of the receiver's own range, because progress travels on
   the id of a request the receiver allocated. **An id of the sender's range
   that names nothing held goes on to step 4**: the sender never reuses an
   id (§5.1), so it is fresh and can open a stream, in whatever order the
   sender queued its first frames.
4. **Otherwise the event is a system event and its `t` defines what its
   header id means:**

| Header id | Events | Rule |
| --- | --- | --- |
| 0 | `features`, `catalog.changed`, `runtime.status`, `runtime.apps`, `log`, `devtools.listen`, the agent messages that open no stream | the id is 0 |
| an open request's id | `runtime.install`, `runtime.native`, `install.head`, `net.head`, `runtime.screenshot` answering a request | a request the receiver sent and that has no `REPLY` yet |
| a channel's id | `channel.close` | a channel open on the connection |
| a fresh id of the sender | `agent.audio`, `agent.shot`, `agent.screen`, `agent.glyphs`, an unsolicited `runtime.screenshot` | **an id from the sender's own range (§5.1) that the sender has not used on this connection**; the event opens a stream under it |

**An `EVENT` with the `APP` flag is read by its flag and not by `t`**, which
belongs to the applet: id 0 is a standalone event of the channel named in
its payload, any other id is a fresh id of the sender and opens a stream
(§7.2).

`runtime.screenshot` is the one system event with two kinds, **told apart by
the range of its header id** (§5.1): an id of the receiver's own range names
a `runtime.screenshot` request the receiver sent, and the event is its
progress; an id of the sender's range is fresh and opens an unsolicited
stream. A progress event for a request the receiver has released (replied,
or past the cancel grace of §5.4) is ignored like any late frame.

What a receiver does with an id that breaks the rule:

- **A stream-opening event whose id is 0, outside the sender's range, or
  already in use on the connection: `CLOSE` `protocol`.** The sender's id
  allocation is broken, and taking the event would mix two streams. This is
  the "bad id" row of §4.7.
- An event that reached step 4, of a kind that requires id 0, with a held
  id or a fresh id of the sender: `CLOSE` `protocol`, for the same reason.
  An id of the receiver's own range that names nothing held never reaches
  this rule: step 3 ignored the event.
- An event naming a request id that the receiver no longer holds
  (cancelled, replied, closed with its channel): **ignored** (step 3), as
  §4.7 treats late frames for a released id. A `channel.close` whose id
  names no open channel reaches step 4 when the id is of the sender's range
  (the device's close crossing Hub's) and is **ignored** there as well: the
  channel is already closed.
- A system event with an unknown `t`: ignored. **When its header id is a
  fresh id of the sender's range, the receiver also sends `RESET` `refused`
  for that id**: the sender may have opened a stream with the event, and
  without the `RESET` it would hold the stream's bytes and wait for credit.

### 5.4 Cancellation

The requester sends `CANCEL` with the request id. The responder stops the
operation, drops what it would still send on the request's stream, and sends
the final `REPLY`: `ERROR` `cancelled`, or its normal reply if it had
finished. The requester discards `EVENT` and `DATA` frames for the id after
`CANCEL` and frees the id at the `REPLY`, or **10 s** after `CANCEL` when no
reply comes. Version 1 had `net.cancel` for HTTP alone and no answer to it
(`link.ts` "Requests").

**For a request of an applet channel, the endpoint next to the responder
answers the `CANCEL` itself.** Hub, on a `CANCEL` for a request it forwarded
to a daemon, sends `REPLY` `ERROR` `cancelled` at once, frees the request's
place in the channel's bound (§7.6), tells the daemon, and drops what the
daemon still sends for it; the device's host does the same for a daemon's
request to the guest. A daemon or a guest that never answers therefore
cannot hold a place: without this rule the requester would free the id
after 10 s and the forwarding endpoint never, and eight such requests would
leave the channel at `busy`.

### 5.5 Timeouts

- **A requester fails a request with `timeout` when 30 s pass without a frame
  for its id** (`EVENT`, `REPLY`, `DATA`, or `CREDIT` for its stream), and
  sends `CANCEL`. Version 1 used the same 30 s for catalog replies and install
  streams (`link.c` `LINK_REQUEST_STALL_MS`).
- A responder that waits on its peer's stream answers `ERROR` `timeout` after
  30 s without a `DATA` frame on it.
- Operations whose result takes longer send progress events (§6.2), which
  reset the requester's timer.
- **The sender of a stream gives up after 30 s without a `CREDIT` for it
  while it holds bytes to send.** For a request's stream that is the
  `timeout` above. For a stream an event opened, the sender sends `RESET`
  `cancelled` and frees what it held: an unsolicited screenshot that Hub
  never grants would otherwise keep 518 KB of linear buffers and answer
  `busy` to every later screenshot.
- **The DevTools stream is exempt.** It belongs to no open request and no
  event, and a guest at a breakpoint grants nothing for as long as it is
  paused. A line Hub has held for 30 s without credit is dropped and the
  eval it carried fails with `timeout` on Hub's side; **the stream stays
  open** and later lines are sent when credit comes (§6.3).
- **The stall timer runs on a request until its `REPLY`.** The ids of
  `devtools.open` and `channel.open` stay in use after their `REPLY`
  (§5.2); no timer runs on them from then on, and the keepalive of §4.6 is
  what detects a dead peer.

### 5.6 Streams and credit

A stream is an ordered byte sequence in one or both directions, named by a
stream id:

- **A `REQUEST` opens a stream with its own id**; the message's section says
  which directions carry bytes and how many.
- **An `EVENT` whose header id is a fresh id of its sender opens a stream** in
  the sender-to-receiver direction.
- The last `DATA` frame of a direction carries `END`. A direction declared
  with `bytes: N` ends with `END` when N bytes have been sent; anything else is a
  `transfer` error for the request, or a `RESET` `length` for an event's
  stream.
- `RESET` abandons the stream in both directions at once. Codes: 1
  `cancelled` (the sender stops), 2 `refused` (the receiver will not take
  it), 3 `length`, 4 `storage`, 5 `superseded` (a newer stream replaces it).
  A request whose stream is reset still ends with its `REPLY`.

**Every stream direction is credited in bytes, a system stream and an
applet's alike.**

- **Credit starts at 0.** The receiver grants with `CREDIT` (u32 bytes). It
  may grant before the first byte, in the same write as the message that
  opens the stream.
- The sender sends `DATA` payload bytes up to the bytes granted and not yet
  used. **Bytes past credit close the connection with `flow`.**
- A grant that raises the outstanding credit of one direction above
  **16 MiB** closes the connection with `flow`.
- Headers, `EVENT`, `REPLY`, `END` with an empty payload, `RESET`, `CREDIT`,
  `PING`, `PONG` and `CLOSE` take no byte credit. Control frames are bounded
  by the open-request bounds and their size; an applet channel's events are
  bounded by a count of their own (below).
- A receiver grants credit when it has written the bytes on (to storage, to
  a guest queue, to a daemon), so credit tracks capacity, not delivery
  (`stream-credit.ts`: "Credit denotes capacity, never delivery").

Recommended windows (bytes outstanding at a time), against the measured
**700–900 KB/s** and **8 ms** round trip of the TCP carrier (§13):

| Receiver | Stream | Window | Why |
| --- | --- | --- | --- |
| device | `runtime.push`, `runtime.native.install`, `install` | **64 KiB** | four 16 KiB frames, about 80 ms of bytes at 800 KB/s and ten round trips of slack, so the sender does not run dry waiting for a `CREDIT`; the device writes at most 64 KiB to storage per pump (`link.c` `LINK_RX_BUDGET`) |
| device | `agent.screen`, `agent.glyphs` | the declared `bytes` | the device holds the whole frame or atlas (`agent.c` `own_pixels`, `glyph_bytes`) |
| device | `net.http` response body | **8 KiB** | `link_http.c` `LINK_HTTP_WINDOW` (8 × 1 KiB worker slots) |
| device | DevTools stream | free bytes in its line ring | §6.3 |
| device | each inbound stream of an applet channel | **16 KiB per stream** (LINK_APP_STREAM_WINDOW): the bytes granted and not yet received plus the bytes the host holds for the guest never exceed 16 KiB on one stream | one frame; the guest takes at most 16 KiB of stream bytes per frame (§7.3), so a larger window would sit in the host's buffer. **The host grants a stream credit only against a `read` the guest has pending on that stream** (§7.3), for at most what that `read` asked for and what keeps the stream inside its window, and the window opens again as the guest takes bytes. **Each stream has its own window; streams share nothing.** A stream nobody reads is granted nothing, and a `read` left pending on a stream whose sender has nothing to send holds that stream's own 16 KiB of credit and no other stream's, so neither starves a stream the applet is reading. With the 4 inbound streams of §7.6 the device holds **at most 64 KiB** of stream bytes per channel |
| Hub | any device stream | **256 KiB**, refilled as it consumes | about 320 ms of bytes at 800 KB/s; Hub's memory is not the limit |

**A window below about 16 KiB caps throughput on this carrier**: with an
8 ms round trip, a sender that waits for one `CREDIT` per window moves at
most window ÷ 8 ms, which is 1 MB/s for 8 KiB and falls under the carrier's
speed when a stall of 100 ms delays the grant. The `net.http` window stays
8 KiB because its consumer is the worker's slots, not the carrier.

**An applet stream runs under the carrier's speed, by this arithmetic and
not by a measurement.** Its grants follow the guest's reads, and the guest
reads once per frame: a grant, its bytes and the guest's next turn make a
cycle of one round trip plus the wait for a frame, about **33 ms** at
8 ms and a 60 Hz loop. A stream then moves about 16 KiB ÷ 33 ms =
**490 KB/s**, against the carrier's 800 KB/s. **Several streams read
together share that figure**: the guest takes 16 KiB of stream bytes per
frame across all of them (§7.3), so four streams move about 490 KB/s
between them, not each. A host that regrants within a turn as the guest
drains (several grants per frame) raises the figure toward the carrier's.
The window, the per-frame hand-over and the regrant timing are values to
calibrate on a device (§13.5); bulk transfers that need the carrier's
speed are the system streams above, not applet streams.

**Applet events are credited by count.** `EVENT` frames take no byte
credit, and an applet channel's events have no request bound of their own,
so a daemon could queue them faster than a guest takes them. **Each
direction of a channel has an event window, counted in units:**

- **Every `EVENT` that belongs to a channel is counted**: an `EVENT` `APP`
  (standalone or stream-opening, §7.2) and a progress event on the id of
  one of the channel's requests. `channel.close` is not counted.
- **An event costs one unit per started 512 bytes of its JSON object**: 1
  unit up to 512 bytes, 16 units for an object of 8,192. The unit makes the
  count a bound on memory as well: a window of N units holds at most
  N × 512 bytes of JSON.
- **A `CREDIT` frame whose id is the channel id grants units, not bytes.**
  No stream carries a channel id (§5.1), so the frame is unambiguous.
- Credit starts at 0. **Hub queues its first grant after the `REPLY` of
  `channel.open`, never before it**: a `CREDIT` on that id ahead of the
  `REPLY` would name a request still open and read as byte credit on it.
  The device sends its own grant right after it reads that `REPLY`.
- **The device grants 48 units** (LINK_APP_EVENT_WINDOW, 24 KiB of JSON at
  most). Hub grants **256 units**.
- **A receiver regrants an event's units when the event leaves its queue,
  for any reason**: the guest or daemon took it, the endpoint discarded it
  (a progress event for a request already cancelled, §5.4; an event of a
  channel that closed), or the endpoint refused it (an object over
  LINK_APP_MSG, §4.7; a stream-opening event with no handler, §7.2). The
  sender spent the units when it sent the event, so a unit that returned
  only on "taken" would leak with every cancelled request and leave the
  daemon without units on an open channel. The device batches its regrants
  into one `CREDIT` per turn of its loop.
- A sender with too few units for an event keeps it on its own side: Hub
  stops reading that daemon's events from its IPC, and the device's host
  reports "full" to the guest's `emit` or `progress` (§7.3). **A guest that
  is paused or hung therefore slows its daemon and loses nothing**; no event
  is dropped and the channel stays open.
- **An event past the granted units closes the channel with `channel.close`
  `overflow`** (§7.5), not the link: only a sender that ignores credit gets
  there.

The device's window holds what a carrier stall releases at once: a daemon
that emits 200 events of 200 bytes a second has about 20 waiting after a
100 ms stall (§13), under the 48 units, and the guest takes 4 messages a
frame, 240 a second (§7.3).

**Why credit on every stream.** Version 1 credited `net.stream` alone, with a
JSON `net.credit` message per released block (`link_http.c` `control`), and
let installs and agent streams wait on the socket's `drain`. On one TCP connection shared by several streams,
TCP backpressure from one slow consumer (an SD write during an install)
stops every other stream and the pings behind it. With credit, the bytes in
flight on one stream are bounded by its window, and the frames of other
streams and channels pass. `CREDIT` is a 16-byte binary frame, not JSON.

### 5.7 Ordering

TCP delivers bytes in order, and each side writes frames in the order it
queues them (§8). The guarantees:

1. **Frames one producer queues arrive in that order.** A message queued
   after a stream's `END` arrives after the whole stream. The agent relies on
   this: Hub sends a glyph atlas before the first message that needs it, and
   the device loads the atlas when its stream completes
   (`contracts/spec/agent.ts` "Glyphs").
2. A `REPLY` arrives after every `EVENT` and `DATA` frame of its request.
3. Messages and stream bytes one side queues for an applet channel arrive
   in that order, and `channel.close` after every frame queued before it.
   Bytes an applet or daemon wrote that were not yet in a queued `DATA`
   frame when the channel closed are not sent (§7.5).
4. Frames of different producers interleave in queue order; a stream's
   chunks do not hold the queue (§8.1). There is no ordering promise between
   independent producers beyond that.

## 6. System messages

### 6.0 How control is encoded

**Control messages are JSON objects in `REQUEST`, `REPLY` and `EVENT`
frames; everything that repeats per chunk is binary in the frame header.**
`DATA`, `CREDIT`, `RESET`, `PING`, `PONG` and `CLOSE` carry no JSON. The choice weighs three encodings against the device's cost
and against debugging:

| Fact | Source | Bearing |
| --- | --- | --- |
| The device firmware already links a bounded JSON reader and writer, `engine/host-services/jscan.c` (**351 lines**). The reader walks one object's top-level members and returns spans: no tree, no allocation | `jscan.h` | JSON control costs the C client no new code and no heap |
| Version 1's C client reads every control message with it (`json_find_string` on `t`, then the fields) and the build machine tests it | `link.c` `handle_ctrl`, `tests/3ds-link.test.ts` | the parser is exercised and known |
| DevTools lines and agent messages are JSON made and read by guest JavaScript: the shim sends `JSON.stringify` output, the agent's guest API passes JSON through `agent.send` | `framework/src/devtools.ts` `send`, `contracts/spec/agent.ts` "Guest namespace" | a binary encoding would make the C client translate two groups in both directions |
| The development connection's binary begin records (package 12 bytes, `.3dsx` 76, launch 68, screenshot 24) each needed a C parser and a TS encoder, **274 lines** of `dev_protocol.c`, and its answers came back as JSON records anyway (`runtime.install`, `runtime.native`, built with `snprintf`) | `pocket-runtime-wire.ts`, `dev_protocol.c`, `devserver.c` | these messages occur once per operation; binary saved nothing measurable there |
| Version 1's per-block costs were JSON: one `net.credit` object per released HTTP block, and the stream id inside the `data` payload | `link_http.c` `control`, `link.ts` "Connection" | version 2 moves these into the binary header |
| A JSON payload reads as text in a packet capture, in Hub's log and in a test vector | | debugging |
| `json_find` is linear in the object for each key looked up. **On a New 3DS XL a scan to the last key takes 6 µs at 286 bytes, 32 µs at 1.7 KiB, 237 µs at 13 KiB and 489 µs at 26 KiB**, about 19 ns a byte | §13 | a control message of a few hundred bytes costs a few microseconds per key; an Old 3DS is slower and unmeasured, and has two orders of magnitude of room inside a 16.7 ms frame |
| The guest's `JSON.parse` takes **0.1 ms at 300 bytes, 0.6 ms at 2 KiB, 4.8 ms at 16 KiB** | §13 | messages that guest code reads stay small; bulk goes on streams (§7.2) |

The options were all-JSON (version 1), all-binary TLV, or the split. The
split keeps JSON where messages are per operation and made or read by guest
code, and binary where cost scales with bytes moved. Conventions: field names
in lower camel case; strings UTF-8 with the stated byte limits; 64-bit hashes
as 16 lowercase hex digits; unknown fields ignored. The tables below list
each message's fields; a field marked `?` may be absent.

### 6.1 Features

`hello.features` lists what the device serves or uses; `ready.features`
lists what Hub serves. **A group is in use only when both current lists name
it.** A request of a group the responder does not list gets `ERROR`
`unsupported`.

| Feature | Device lists it when | Hub lists it when |
| --- | --- | --- |
| `runtime` | it answers `runtime.status`, `runtime.push`, `runtime.launch` (app), `runtime.screenshot`, `runtime.logs` | always (Hub sends them) |
| `runtime.native` | it installs and starts `.3dsx` files (the development connection's ack flag `NATIVE`) | always |
| `devtools` | the guest's DevTools shim is reachable | it relays DevTools |
| `catalog` | it reads Hub's catalog | it offers one |
| `install` | it installs from Hub | it streams packages |
| `net.http` | it has a worker HTTP provider | it performs requests |
| `agent` | it runs the agent stage | the agent is available |
| `channel` | it opens applet channels (§7) | it routes them to daemons |
| `apps` | it reports its installed applets (§6.2 `runtime.apps`) | it wants them |

#### Changes after admission

**Either side's list can change on a live link.** The side whose list
changes sends `EVENT` `features` (id 0) `{features: [...]}` with its **whole
current list**, at most 16 entries of 24 bytes as in `hello`. The new list
replaces the one from the handshake or from the previous `features` event.
A `features` event over these limits, or without a `features` array, closes
the connection with `CLOSE` `protocol`: the receiver can no longer tell which
groups are in use.
**A side sends at most one `features` event a second**; a change inside the
second goes out at its end, with the list as it stands then. Hub sends one
when, for example, its agent becomes available or unavailable; the device
sends one when a guest switch brings a guest with or without the DevTools
shim, so `devtools` follows the running guest instead of the moment of
connecting.

**A group leaves use when either list drops it, and comes into use when both
name it again.** The side that drops a group first ends its own part in it,
and queues all of this before its `features` event, so the peer reads it
first (§5.7):

1. `REPLY` `ERROR` `unsupported` to each open request of the peer in the
   group;
2. `CANCEL` for each of its own open requests in the group;
3. `RESET` `cancelled` for each stream of the group that belongs to no
   request (the DevTools stream, agent streams);
4. `channel.close` `feature` for each channel, when the group is `channel`.

The receiver of a `features` event that drops a group stops sending
requests, events and streams of the group, answers a request of the group
that crosses the event with `ERROR` `unsupported`, and ignores events of the
group that arrive after it. When a group comes into use again, its
connection-start steps run again: the device sends `devtools.open` for
`devtools` (§6.3), `runtime.apps` for `apps`, and `channel.open` for the running
applet for `channel` (§7.1).

**The agent stage.** When `agent` leaves use, the device does what it does
today when the agent's channel goes away: the guest receives
`{"t":"link","available":false}`, and the microphone and an open shot stop
(`agent.c` `agent_pump`, which polls `link_feature_ready("agent")`). When
`agent` comes into use again, the guest receives `available: true` and sends
`agent.hello`, as after the link comes up (`contracts/spec/agent.ts`
`agent.hello`). Hub sends the glyph atlas again after that `agent.hello`, as it
does after every `agent.hello` (`contracts/spec/agent.ts` "Glyphs").

### 6.2 Runtime operations

Hub sends these to a device that lists `runtime`. **`runtime.push`,
`runtime.native.install`, `runtime.launch` and eval change device state and
take Hub's device mutex (§8.3); the others take no lock.** The device also
refuses a second state-changing request while one is open (`busy`): it has one
package staging file and one `.3dsx` staging file (`devserver.c`,
`native.h`).

The runtime state's `generation` in these messages counts package commits
(`PocketRuntimeState`); it is not the channel generation of §7.4.

#### runtime.status

Request `{}`. Reply, and an `EVENT` `runtime.status` (id 0) that the device
sends **once after `ready` and at every runtime phase change**
(`devserver_set_runtime` call sites in `main.c`):

| Field | Type | Content |
| --- | --- | --- |
| `phase` | string | the runtime phase: `starting`, `candidate`, `booted`, `accepted`, `recovered`, … |
| `target` | string | build target |
| `hostAbi` | integer | host ABI |
| `slot` | string | 16 hex: the running guest's slot |
| `address` | string | the device's IPv4 address |
| `generation` | integer | runtime state generation |
| `active`, `lastGood`, `running` | string | 16-hex package hashes |
| `frame` | integer | frame counter |
| `app` | object or null | `{id, output, title}` of the running applet |

The fields are the development connection's `runtime.status` record
(`devserver.c` `send_status`) without `ip`/`port` (renamed `address`; the
device has no port) and with `app`.

#### runtime.apps

**Requires `apps`, not `runtime`**: a device that serves no development
operation still reports its applets. Hub uses the set to match its daemons
to the applets a linked device holds.

`EVENT` `runtime.apps` (id 0), device to Hub, sent when `apps` comes into use
(after `ready`, or after a `features` event, §6.1) and **after every change
of the installed set**: a package committed as a slot's active package (a
catalog install, a push into another app's slot, an accepted push of the
running app), and a removal (`link.remove`). **At most one report a second**
(a report's pages go out together, below); a change inside the second goes
out at its end. **Each report carries the whole
set**, so a lost or late report is repaired by the next one and Hub keeps no
diff state. **A report is one event, or several pages when its rows do not
fit one frame of the connection's payload limit.**

| Field | Type | Content |
| --- | --- | --- |
| `set` | integer | u32 the device raises by one for each report on a connection, starting at 1 |
| `at` | integer | index of this page's first row in the report, **0** on the first page |
| `apps` | array | this page's rows, at least **1** unless the device holds no applet; **64** rows at most in a whole report |
| `more` | boolean | true when a further page of the same `set` follows |

Paging rules:

- **Rows keep the order of the launcher's table for the length of one
  `set`**, and `at` of a page equals the number of rows in the pages before
  it. The device fills each page with as many whole rows as the payload
  limit holds; a row never spans two pages, and one row at every limit
  (about 300 bytes) fits the smallest payload limit (1 KiB, §4.4).
- The pages of a `set` are consecutive `EVENT` frames of id 0 in the
  device's write queue; other frames may sit between them (§8.2).
- **Hub replaces the set it holds when the page with `more: false` arrives
  and every page of that `set` from `at` 0 arrived before it in order.**
  Until then it keeps the earlier set.
- **A change of the installed set while pages are still unsent ends that
  `set`**: the device sends no further page of it and starts the report
  again under the next `set` at `at` 0, within the one-a-second rule.
- **Hub keeps the highest `set` it has seen on the connection and one rule
  for every page that does not continue it:**
  - a page whose `set` is larger than the highest seen starts a new partial
    set when its `at` is 0, and drops the partial set Hub held;
  - a page whose `at` is not the row count Hub holds for its `set` (a first
    page with `at` above 0 included) makes Hub **drop that `set` and ignore
    every later page of it**;
  - a page whose `set` is at or below one that Hub completed or dropped is
    ignored.
  In each case Hub keeps the last complete set and waits for the next
  report. On an ordered carrier a wrong `at` can only be a device bug, so
  the link does not close for it.
- A report of more than 64 rows closes the link with `protocol`.

A row:

| Field | Type | Limit | Content |
| --- | --- | --- | --- |
| `id` | string | 128 bytes | manifest id |
| `output` | string | 64 bytes | build output name, the launcher key |
| `version` | string | 32 bytes | the app contract's version |
| `hash` | string | 16 hex | footer hash of the slot's active package |
| `home` | boolean? | | true for the launcher (the embedded guest) |

The 3DS's launcher holds at most **64** apps (`launcher.c`
`LAUNCHER_MAX_APPS`). A row's values take at most 240 bytes and its keys and
quotes about 60, so 64 rows at every limit take about 20 KB, which fits a
32 KiB frame and **not the 16 KiB of the TCP carrier**; rows of ordinary
size (an id of 30 bytes, an output of 12) take about 150 bytes, and 64 of
them about 10 KB. **A report of ordinary size is one page on TCP; one at
every limit takes two.** The device builds the list from the
launcher's cached table, which is rebuilt only after an install, a removal or
a routed push (`launcher.h` `launcher_invalidate`), so the event reads no
storage.

#### runtime.push

Push a `.pocket` to the device: it replaces the running guest when the
package is the running app, or is committed in its app's own slot and
launched there (`main.c` `route_upload`).

Request:

| Field | Type | Limit |
| --- | --- | --- |
| `bytes` | integer | 1 to **24 MiB** |
| `hash` | string | 16 hex: the package footer hash (FNV-1a64) |

Stream: Hub to device, `bytes` bytes, then `END`. The device checks that it
accepts packages, that no state-changing request is open and that it can open
the staging file, then grants credit; otherwise it answers at once with
`unsupported`, `busy`, `too_large` or `storage`.

Events (id = request id) `runtime.install`:
`{phase: "receiving" | "received" | "staged", hash, generation, message}`.

Reply: `{phase: "accepted", hash, generation, message, app: {id, output, title}}`,
sent when the device accepts the package (its first PICA command list
retired, `main.c`). Errors: `rejected` with `phase` (`rejected` or
`recovered`) and the admission's message; `transfer`; `storage`; `busy`;
`unsupported`; `too_large`.

The development connection's chunks carried an absolute offset
(`encodePocketRuntimeChunk`); version 2 drops it, since TCP order and the
byte count fix every byte's place.

#### runtime.native.install

Requires `runtime.native`. Request:

| Field | Type | Limit |
| --- | --- | --- |
| `name` | string | 6 to 64 bytes of `[A-Za-z0-9._-]`, ending in `.3dsx`, not starting with `.`: one file in `sdmc:/3ds/` itself, not in a folder below it (`dev_protocol.h`) |
| `bytes` | integer | **32 bytes to 32 MiB** |
| `crc32` | integer | zlib's CRC-32 of the file |
| `launch` | boolean | start the file after installing |

Stream: Hub to device, `bytes` bytes, then `END`. The device checks length,
CRC-32 and the `3DSX` magic and replaces `sdmc:/3ds/<name>`, keeping the old
file as `native-previous.3dsx`; a file that replaces the running `.3dsx` is
staged and installed as the process exits (`native.h`).

Events `runtime.native`: `{phase: "receiving", name}`.

Reply: `{phase: "installed" | "staged" | "launching", name, path}`. Errors:
`rejected` (length, CRC-32 or magic), `transfer`, `storage`, `busy`,
`unsupported`, and `launch` with `installed: true` when the file was written
and the start failed (outside the Homebrew Launcher, `hb:ldr` is absent).

**With `phase: "launching"` the device sends the `REPLY`, then `CLOSE`
`restart`, gives its send buffer up to 1 s to drain (`devserver_flush(1000)`
today) and exits into the file through `hb:ldr`.** Hub keeps the mutex until
the device links again or **60 s** pass.

#### runtime.launch

Request with one of these fields, never both:

| Field | Type | Effect |
| --- | --- | --- |
| `native` | string | a `.3dsx` name under `sdmc:/3ds/`, rules as above. Requires `runtime.native` |
| `app` | string | an installed applet's output name (≤ 64 bytes), switched to through the launcher (`launcher.h` `launcher_launch`) |

Reply for `native`: `{phase: "launching", name, path}`, then `CLOSE`
`restart` as above. Reply for `app`: `{phase: "switching", output}`; the
switch happens at the next frame boundary and a `runtime.status` event
follows. Errors: `not_found` (no such file or output), `busy`, `launch`.

#### runtime.screenshot

Request `{}`. **The host captures both screens at the next frame boundary
without the guest**: after the canonical tick it copies both PICA targets
into two linear buffers (`main.c`, `devserver_screenshot_begin`), sends an
`EVENT` `runtime.screenshot` (id = request id), streams the bytes and frees
the buffers.

| Event field | Type | Content |
| --- | --- | --- |
| `frame` | integer | the frame captured |
| `format` | string | `"bgr8-rotated"`: B, G, R bytes in the PICA target's rotated column-major order (`3ds-runtime-client.ts` `decodePocketRuntimeSurface`) |
| `surfaces` | array | `[{name: "top", width, height, bytes}, {name: "bottom", width, height, bytes}]`, `bytes = width × height × 3` |

Stream: device to Hub, the top surface's bytes then the bottom's, then `END`.
Reply: `{frame}`. Errors: `busy` (one screenshot at a time), `unsupported`,
`storage` (the linear buffers could not be allocated). Hub composes the PNG
(today `combinePocketRuntimeScreens`).

The development connection took the request as the DevTools line
`{"t":"screenshot"}`, which the guest's shim turned into `ui.__dbgShot()`
(`framework/src/devtools.ts`); a guest without the shim, or a hung one, gave
no screenshot. The dev menu's `X` (`main.c`, "SHOT QUEUED") sends the same
event unsolicited, with a fresh stream id in the header; Hub keeps it as the
device's latest screenshot. Both surfaces are about 518 KB, twice Hub's
suggested 256 KiB window, and take about 0.65 s at the measured 800 KB/s
(the development connection took about 2.1 s for the same bytes, §13); the
stream completes by refills, as every stream
longer than its window does (§5.6). **Hub may answer an unsolicited
screenshot's stream with `RESET` `refused`** when it keeps no latest
screenshot; the device then frees its buffers.

#### runtime.logs

Request `{on: boolean}`, reply `{}`. **Logs are off at every new connection.**
While on, the device sends `EVENT` `log` (id 0):

| Field | Type | Content |
| --- | --- | --- |
| `level` | string | `debug`, `info`, `warn`, `error` |
| `source` | string | `host` (the runtime's own lines, today `devserver_report_log`) or `guest` (the applet's `console` and the errors thrown from its frames) |
| `text` | string | at most **1 KiB**, and at most **the payload limit minus 96 bytes** (928 at the 1 KiB floor), counted as encoded; cut on a code point. The 96 bytes hold the other fields |
| `frame` | integer | the frame counter as a **u32**, wrapping to 0 after 2^32 − 1 (828 days at 60 frames a second); 10 digits at most, which the 96 bytes count |
| `dropped` | integer? | log events dropped since the last one sent, a u32 that stays at its maximum |

**The device drops a log event when its send buffer has no room for it**
(§8.2), and counts it in the next event's `dropped`. The
development connection dropped log records with no count. Guest lines need a host operation in the shim's console bridge;
today the bridge writes to the DevTools channel and only while a panel
listens (`docs/DEVTOOLS.md` §2–3). See §12.2.

### 6.3 DevTools

The DevTools protocol of `docs/DEVTOOLS.md` §4 (JSON lines between the
guest's shim and a panel) travels unchanged. **The device's C code does not
parse DevTools lines**; it moves bytes between the stream and the shim's
`ui.__dbgPoll` / `ui.__dbgSend`.

| Message | Direction | Content |
| --- | --- | --- |
| `devtools.open` | device → Hub, `REQUEST` `{}` | sent when `devtools` comes into use: after `ready`, or after a `features` event (§6.1). Hub replies `{}`. **The request id is the DevTools stream id for both directions until the connection ends or `devtools` leaves use** |
| DevTools stream | both | UTF-8 lines, each ended by `\n`, cut across `DATA` frames at any byte |
| `devtools.listen` | Hub → device, `EVENT` `{on: boolean}` (id 0) | the shim's `listening()` (today `ui.__dbgConnected`) returns `on`. Off at every new connection |

- **Device to Hub lines are at most 64 KiB.** A longer line is replaced by
  `{"t":"ctrlDropped","bytes":<n>,"cap":65536}`, as `devserver_send_ctrl`
  does. The device's first line on a new stream is the shim's last `hello`
  line, cached as `devserver.c` caches it.
- **Hub to device lines are at most 16 KiB (16,384 bytes) without their
  `\n`**; the device's line ring holds **4 × (16 KiB + 1)** bytes
  (`devserver.c` `CTRL_IN_BYTES`). The device
  grants credit for the free bytes in the ring and hands the shim whole lines
  only (`devserver_recv_ctrl`). **Hub holds a line until credit covers it;
  a line held 30 s is dropped, its eval fails with `timeout`, and the stream
  stays** (§5.5): a guest at a breakpoint or a full ring is no reason to
  reset a stream that only `devtools` leaving use would open again. A guest switch drops undelivered lines; the
  stream stays while the next guest has the shim, and is reset with `devtools`
  leaving use otherwise (§6.1). **When the drop lands inside a line** (its
  first bytes were in the ring and its `\n` has not arrived), **the host
  discards the stream's bytes up to and including the next `\n`**, so the
  tail of a line meant for the old guest never reaches the new guest's shim
  as a line of its own.
- **Eval** is the DevTools line `{"t":"eval","id":<string>,"code":<string>}`
  and its answer `{"t":"evalResult","id",…}`. **The whole line is at most
  16 KiB**, so the code is what remains after the other fields and the JSON
  escapes of the code itself (about 16,340 bytes of escaped code). Hub writes the line under its
  device mutex and reads the answer from the device's lines; Hub's ids start
  with `hub-`. The shim evaluates between frames in the applet's global scope.
  **The shim answers eval, and every explicit request, whether `devtools.listen`
  is on or off**: it polls its transport in every frame callback, and
  `listening()` gates only the tree and stats it sends unasked
  (`framework/src/devtools.ts`: `pollTransport` runs before each frame,
  `afterFrame` returns early when no panel listens; `docs/DEVTOOLS.md` §3). A
  guest whose frame callback does not run (a hung guest, a guest without the
  shim) answers nothing, and the eval ends at the 30 s timeout of §8.3.
- **Guest switch notice.** When the host tears a guest down, it appends the
  line `{"t":"guest.end","app":<id>,"output":<output>}` to the device-to-Hub
  stream, after every line the old guest's shim queued, and drops the
  undelivered Hub-to-device lines at the same moment. **Hub fails every eval
  still pending on that device when it reads `guest.end`**, instead of
  waiting 30 s for an answer the next guest will not give. Hub consumes the
  line and does not forward it to panels. The development connection had no
  such notice: the new guest's shim sends `hello` at its first poll, which
  arrives only once that guest runs, and never from a guest without the shim.
- A panel's `{"t":"screenshot"}` line is answered by Hub with
  `runtime.screenshot`, converted to the panel's PNG message; Hub does not
  forward it.
- `devStats` stays a line: the shim reads `ops.debugStats`
  (`products/3ds/src/instance.c` → `devserver_debug_stats`), whose `net`
  block reports the link's counters in version 2.
- `listening` off keeps the shim from serializing tree snapshots, which cost
  about **30 ms of JS on an Old 3DS** once per 30 frames (`docs/DEVTOOLS.md`
  §3). Hub turns it on only while a panel is attached.

### 6.4 Catalog and install

Device to Hub; kept from version 1 in version 2's frames (`link.ts`
"Requests", `catalog.ts`).

**catalog**: request `{after?, rev?}`. Reply `{apps: [LinkCatalogApp], rev,
more}`: every `.pocket` in Hub's apps folders with a variant for
`hello.target`, one per app id with the first folder winning, **the first 64
by `id`** when more qualify, **paged when the rows do not fit one frame**:

| Field | In | Type | Content |
| --- | --- | --- | --- |
| `after` | request | string? ≤ 128 bytes | the `id` of the last row of the page before; absent for the first page |
| `rev` | request | integer? | the `rev` of the page before; absent for the first page, required with `after` |
| `apps` | reply | array | the rows after `after`, as many whole rows as the payload limit holds |
| `rev` | reply | integer | u32 revision of Hub's offer, raised at every change that sends `catalog.changed` |
| `more` | reply | boolean | true when rows remain after this page's last row |

- **Rows are ordered by `id`, ascending by byte value**, so the order does
  not depend on Hub's folders and a cursor names one position.
- **Hub serves the pages of one fetch from a snapshot.** When it answers a
  first page (no `after`), Hub keeps the offer's rows at that `rev` for this
  connection, at most 64 rows, one snapshot per connection. A later page
  request with that `rev` is answered from the snapshot **whether or not the
  offer has changed since**, and each such request extends the snapshot's
  life to **30 s** from its arrival. A device that fetches while the offer
  keeps changing (a build loop writing packages) therefore completes its
  fetch; the `catalog.changed` events tell it to fetch again afterwards.
- **A page request whose `rev` Hub holds no snapshot for** (it expired, a
  newer first page replaced it, or the connection is new) **is answered with
  the error `changed`**; the device discards the pages it holds and asks for
  the first page again. An `after` that names no row of the snapshot is
  `malformed`.
- Each page is its own request, counted in the 4 open requests below; the
  device asks for the next page after it has consumed the one before, so
  pages are not in flight together.
- **A device runs one catalog fetch at a time on a connection.** A fetch
  starts with a first-page request and ends with a page whose `more` is
  false, an error, or the device giving it up; a `link.catalog` call or a
  `catalog.changed` that arrives meanwhile is served by the running fetch's
  result or starts the next fetch after it. Hub keeps one snapshot per
  connection, so two fetches at once would replace each other's snapshot
  and answer each other `changed`.
- **Every page holds at least one row.** Each field of a row is bounded
  (below), so a row at every limit takes about 520 bytes and fits the
  smallest payload limit (1 KiB) beside the reply's own fields. Hub cuts
  `title` and `summary` to their limits on a code point and **leaves out an
  app whose `id`, `output` or `version` is over its limit**, which the
  device could not install or show under that name.

A row, with limits in encoded bytes:

| Field | Type | Limit | Content |
| --- | --- | --- | --- |
| `id` | string | 128 bytes | manifest id, the install key and the page cursor |
| `title` | string | 64 bytes | |
| `version` | string | 32 bytes | |
| `summary` | string | 120 bytes | may be empty |
| `output` | string | 64 bytes | build output name, the launcher key once installed |
| `hash` | string | 16 hex | the file's footer hash (FNV-1a64) |
| `bytes` | integer | 24 MiB | file size |

Version 1's `catalog.ts` sorts by title and then keeps 64, bounds `summary`
alone, and has no revision; version 2 changes all three (§12.1).

**catalog.changed**: `EVENT` (id 0), Hub to device, after the offer changes.

**install**: request `{app: <id ≤ 128 bytes>}`. Hub sends `EVENT`
`install.head` (id = request id) `{app, hash, bytes}` with `bytes` at most
**24 MiB**, then the file verbatim on the stream (Hub to device) under the
device's credit, then `END`, then the reply `{bytes}`. Size and hash come
from the open file descriptor, so a file replaced mid-install streams one
consistent version. Errors: `not_found`, `too_large`, `busy`.
The device writes to `apps/<slot>/link-upload.pocket`, checks the footer hash
against `install.head.hash`, admits the package for its target and ABI, and
commits it (`link.c` `finish_install`); on a local failure it sends `CANCEL`.

At most **4** catalog and install requests are open per connection, and two
installs never target one slot (`link.c` `LINK_MAX_REQUESTS`,
`link_install`). An install keeps streaming across a guest switch
(`link_reset_guest`). Installs are device-initiated and take no Hub mutex; a
`runtime.push` to a slot with an install streaming gets `busy`, and the
reverse.

### 6.5 net.http

An applet worker's `io.http` resource (`contracts/spec/net.ts`): **Hub
performs the request with its own HTTP and TLS stack and streams the
response.** Device to Hub.

Request:

| Field | Type | Limit |
| --- | --- | --- |
| `app` | string | the applet's manifest id: **the runtime's assertion**, taken from the running package, never from the guest, as for `channel.open` (§7.1) |
| `url` | string | `http:` or `https:`; at most **2 KiB** as encoded in the frame |
| `method` | string | `GET HEAD POST PUT PATCH DELETE OPTIONS` (`NET_METHODS`) |
| `headers` | object | string values; at most 32 headers, and **the encoded `headers` object is at most 8 KiB** |
| `timeoutMs` | integer? | at most **120,000**; default 30,000 |
| `maxBytes` | integer? | at most **256 KiB**; default 128 KiB |
| `bytes` | integer | request body length, at most **64 KiB** |

**`app` is what Hub's service checks rest on** while Hub still answers
`https://companion.pocket/<service>` (§11, question 5): Hub checks that the
applet named by `app` declares the service, so the field must come from the
runtime and not from guest code.

Streams, both on the request id: the request body, device to Hub (Hub grants
credit for `bytes` on receipt); the response body, Hub to device (the device
grants its window, 8 KiB today, in the same write as the request).

`EVENT` `net.head` (id = request id): `{status, url, headers, truncated?}`; header names
lower case, hop-by-hop headers dropped, `content-encoding` and
`content-length` dropped when the body was decompressed, several
`set-cookie` joined with `\n`; at most 32 headers, the encoded `headers`
object at most 8 KiB, `url` (the final URL after redirects) at most 2 KiB.

**Limits are on the encoded object, and both messages fit one frame.** With
a 2 KiB URL, 8 KiB of headers and its other fields, a request is at most
about 10.5 KiB and a `net.head` about 10.3 KiB, under the 16 KiB of the TCP
carrier. Version 1 allowed an 8 KiB URL beside 8 KiB of headers in a 32 KiB
frame (`fetch.ts`), which at 16 KiB no longer fits (over 16.6 KiB at both
limits), and a header value grows when encoded: a `set-cookie` of 3,599
bytes joined with `\n` takes 5,415.

- **`net.http` is in use on a connection whose payload limit is at least
  12,288 bytes.** Under that, the device's host fails a worker's request
  locally with `unavailable` and Hub answers one that arrives with
  `unsupported`, whatever the two `features` lists say. A carrier that slow needs a paged or streamed form
  of the request head, which this version does not define (§11,
  question 13).
- The device's host checks the request against these limits and fails it
  locally with `invalid_request` before it queues a frame.
- **When a response's head does not fit**, Hub drops response headers, the
  last received first, until the encoded `headers` object is within 8 KiB,
  **and sets `truncated: true` in `net.head`**, which the worker's response
  carries to the applet; the field is absent when every header was sent;
  when the final URL alone is over 2 KiB, Hub ends the request with the
  error `response_too_large` and sends no `net.head`.

Reply after the body's `END`: `{bytes}`, the body length. Errors use
`NET_ERROR` codes: `unavailable`, `invalid_request`, `busy`, `dns`,
`connect`, `tls`, `timeout`, `redirect`, `response_too_large`, `protocol`,
`cancelled`, `other`. **The device keeps the body prefix received before an
error** (version 1).

Hub's policy is version 1's (`fetch.ts`, `docs/POCKET-LINK.md` at
`becc0e21`): redirects followed by hand, at most **3**, each hop resolved and
checked; **every destination address checked** (loopback, link-local, RFC
1918, CGNAT `100.64/10`, multicast, unique-local and reserved addresses
refused with `invalid_request` unless Hub runs with private destinations
allowed); `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY`, copied from the macOS
proxy settings when unset. At most **8** `net.http` requests are open per
connection (kept from version 1).

Changes from version 1: `"stream": true` and the whole-response `net` mode are
gone; credit is `CREDIT` frames; the end is `END` plus the reply instead of
`net.end`. `DATA` frames may be any size within credit; version 1 limited
response blocks to **1 KiB** (`link.ts`), and `link_http.c` splits frames
into its 1 KiB worker slots instead (§12.2).

### 6.6 Agent

The agent's messages are those of `contracts/spec/agent.ts`
(`AgentClientMessage`, `AgentServerMessage`), **unchanged as JSON**, in
`EVENT` frames. The agent keeps its own message protocol on the link in phase
one; it is not request/reply. Every message is at most LINK_MAX_CTRL
(16 KiB on TCP).

| Message | Direction | Header id | Stream |
| --- | --- | --- | --- |
| `agent.hello`, `agent.turn`, `agent.audio.end`, `agent.cancel`, `agent.reset`, `agent.result` | device → Hub | 0 | |
| `agent.audio` | device → Hub | the JSON `id` (a fresh device id) | microphone PCM, s16le at 16,360 Hz, at most **30 s**; ends with `END`, then `agent.audio.end` carries `send` |
| `agent.shot` | device → Hub | the JSON `id` | **153,600** bytes of RGB565 (320 × 240) |
| `agent.state`, `agent.transcript`, `agent.request`, `agent.delta`, `agent.step`, `agent.tool`, `agent.usage`, `agent.done`, `agent.error` | Hub → device | 0 | |
| `agent.screen` | Hub → device | the JSON `stream` (a fresh Hub id, bit 31) | **153,600** bytes of RGB565 |
| `agent.glyphs` | Hub → device | the JSON `stream` | a font atlas of at most **333,616** bytes (16 + 1,200 × 8 + 1,200 × 15 × 18, `agent.c` `GLYPHS_MAX_BYTES`) |

- The device grants the declared `bytes` of `agent.screen` and `agent.glyphs`
  at once, or answers `RESET` `refused` when it cannot hold them. Hub grants
  the microphone and shot streams.
- **Hub queues a message whose text needs new glyphs only after the atlas
  stream's `END` is written** (kept from version 1), so §5.7 keeps glyphs
  ahead of text.
- Hub starts an `agent.screen` stream only after the previous one ended
  (kept from version 1); a superseded frame may end before its last byte with
  `RESET` `superseded`.

## 7. Applet channels

**An applet channel joins one running applet on the device to that applet's
daemon on Hub. It carries the link's own primitives, scoped to the channel:
requests with replies, events, cancellation and credited byte streams.**
Hub's endpoint routes them between the device and the daemon and reads none
of their content. **No second protocol runs inside a channel**: the frames,
ids, credit, timeouts and ordering are those of §4 and §5.

An earlier draft carried Pocket Relay records in opaque "lanes". Relay
brings a session layer of its own (a length prefix and a 48-byte header per
record, sequence numbers, a heartbeat, credit, streams); with the link as
the only transport on every carrier (§2.0), each of those repeats what the
link already does. Its endpoint also ran in guest JavaScript, where work per
byte costs what §13 shows. What applets need from it beyond the link's
primitives is a convention (§7.8), not a wire format.

### 7.1 Open

When an applet's guest starts and its package declares the channel
capability (its name is set in the PocketJS spec, §11 question 2), the device
runtime sends:

`REQUEST` `channel.open`, **header id = the channel id**:

| Field | Type | Content |
| --- | --- | --- |
| `app` | string, ≤ 128 bytes | the applet's manifest id |
| `hash` | string | 16 hex: the running package's footer hash |

**The applet id is the runtime's assertion**: the device takes it from the
package it booted (today `launcher_current_app_id`), never from a value the
guest supplies. Hub cannot check it beyond trusting the authenticated device
runtime (§3.9 for what an attacker can do).

Hub answers:

- `REPLY` `{generation}`: a u32 (§7.4). The channel is open.
- `REPLY` `ERROR`, with the device's retry rule:

| Code | Meaning | The device may open again for the same applet |
| --- | --- | --- |
| `no_daemon` | Hub has no daemon for this applet id; retrying changes nothing until something changes on Hub | not during this applet run; a new run (applet start, realm reset) or a new connection opens again |
| `busy` | the daemon exists but could not start in time, or the connection has LINK_MAX_CHANNELS channels | after **2 s**, doubling at each further `busy` to **60 s**; the wait resets when a channel opens |
| `rejected` | Hub's policy refuses the applet id | not during this applet run |
| `unsupported` | Hub does not list `channel` | when `channel` comes into use again (§6.1) |
| `malformed` | the request breaks its shape | not during this applet run |

**Neither side sends a frame of the channel before the `REPLY`.** The
channel id outlives the `REPLY`: unlike other requests, `channel.open`'s
reply opens the channel rather than ending activity on the id.

**Hub may hold the `REPLY` while it starts the daemon**, which can take
about 10 s for a program Hub starts on demand. **Hub answers within
LINK_CHANNEL_OPEN_MS (20 s)**, with `busy` if the daemon is not connected by
then; that stays inside the requester's 30 s stall (§5.5), so the device
never times out an open that Hub is still serving. Meanwhile the link carries
everything else as usual, and the host answers the guest's own requests on
the channel with `no_channel` (§7.3). When the applet exits or its realm
resets before the `REPLY`, the device sends `CANCEL` for the `channel.open`
and Hub answers `cancelled` and stops the daemon it was starting. If Hub's
accepting `REPLY` crosses the `CANCEL` (§5.4), the device closes the new
channel at once with `channel.close` `exit`.

### 7.2 Messages and streams in a channel

A channel uses the link's frames. **Two frames start something and carry the
`APP` flag (0x02); their payload begins with the u32 channel id, and the JSON
object follows it:**

| Frame | Flags | Header id | Payload |
| --- | --- | --- | --- |
| `REQUEST` | `APP`; `BODY` (0x04) when a request body follows | a fresh id of the sender (§5.1) | u32 channel id, then one JSON object with string `t` |
| `EVENT` | `APP` | 0, or a fresh id of the sender when the event opens a stream | u32 channel id, then one JSON object with string `t` |

Every other frame is unchanged and **belongs to the channel through its
id**: a `REPLY`, a `CANCEL`, an `EVENT` of progress, `DATA`, `CREDIT` and
`RESET` carry the id of a request or stream that an `APP` frame started.
Each endpoint keeps, per id, the channel it belongs to. **A progress event
carries no `APP` flag and no channel id, and a receiver recognises it by its
header id before it looks at `t`** (§5.3, step 1), so an applet may name its
progress events as it likes.

- **Both sides send requests and events**: the applet to its daemon, the
  daemon to the applet. Ids come from each side's range (§5.1), so the two
  directions never collide.
- **`t` is the applet's own operation name** (at most 64 bytes of
  `[a-z0-9._-]`). The link gives it no meaning. A name the receiving applet
  or daemon does not know is answered by that receiver with `ERROR`
  `unknown_message`.
- **A request ends with one `REPLY`**, after any progress events and stream
  bytes (§5.2). Progress events count against the channel's event window
  (§5.6). The error codes of §5.2 apply; a code the applet and its
  daemon define between them (at most 32 bytes of `[a-z0-9._-]`) passes
  through unread.
- **`CANCEL` and the 30 s stall of §5.5 apply as they do to system
  requests**, and the endpoint next to the responder answers a `CANCEL`
  itself (§5.4). A responder whose work takes longer than 30 s sends
  progress events, which reset the requester's timer.
- **Streams.** A request with `BODY` is followed by the requester's bytes on
  the request id, ended with `END`. The responder may send bytes on the same
  id before its `REPLY`, ended with `END`. An `EVENT` with a fresh id opens a
  stream from its sender to the receiver; **when the receiving applet or
  daemon has no handler for that event's `t`, its endpoint answers `RESET`
  `refused`** for the id, so the sender does not hold the bytes for 30 s. Every direction starts at credit 0
  and is granted by its receiver (§5.6); `RESET` abandons a stream, and a
  request whose stream is reset (`refused` when the channel is at its stream
  bound, §7.6) still ends with its `REPLY`.
- **The head step.** **A responder that sends bytes on a request sends a
  progress event first**, as `net.head` and `install.head` do for the system
  requests; its JSON says what the bytes are. **The head event is mandatory:
  the receiving endpoint hands the requester the response stream at the
  first progress event of the request and never waits for the `REPLY` to do
  so.** A response stream is granted credit only once the requester reads
  it (§5.6, §7.3), and the requester can read only what it was handed, so a
  responder that sent no progress event would hold its bytes at credit 0
  until the 30 s limit of §5.5. **The endpoint next to the responder
  therefore refuses the bytes before they reach the wire**: Hub fails a
  daemon's write on a request it has sent no progress event for, and the
  device's host fails the guest's `call.respond()` the same way. The `REPLY`
  is queued after the stream's `END` (§5.2) and acts as the trailer. Without this step a response longer than the 16 KiB window would
  never complete: the responder would wait for credit, the requester for the
  `REPLY` that sits behind the bytes, and the request would end at the 30 s
  stall.
- **Sizes.** A JSON object in a channel is at most **LINK_APP_MSG =
  min(8,192, LINK_MAX_PAYLOAD − 4)** bytes: the 4 bytes are the channel id
  that an `APP` frame carries before the object, so the object is at most
  1,020 bytes at the 1 KiB floor. **Anything larger travels as a stream.**
  **The sender's own endpoint refuses an object over the limit before it
  queues a frame**: the device's host fails the guest's call with
  `too_large`, and Hub fails the daemon's. A receiver that still meets one
  answers a request with `REPLY` `ERROR` `too_large` and drops an event
  (§4.7); it checks the frame's length and parses nothing for that. The
  guest parses 2 KiB in about 0.6 ms and
  16 KiB in about 4.8 ms on a New 3DS (§13), against a worker turn of 5 ms
  (`products/3ds/README.md` "Worker scheduling"); a message is meant to stay
  under 2 KiB (§11, question 1).
- A frame for a channel that is not open, or for an id of a closed channel,
  follows §4.7: an `APP` request gets `ERROR` `no_channel`, the rest is
  ignored.

**What Hub does with these frames.** For an `APP` frame from the device, Hub
checks that the channel is open on this connection, records the id against
the channel, and hands the frame to the channel's daemon; for the daemon's
requests and events it allocates the id from its own range. It forwards
`REPLY`, `CANCEL`, `DATA`, `CREDIT` and `RESET` by id. **Hub does not parse
the JSON object beyond finding `t`**, which it may log.

### 7.3 What the guest sees, and where the work runs

**Framing, id tables, credit, the channel id and every per-byte step run in
the host's C code. Guest JavaScript sees whole messages and byte chunks.**
On a New 3DS a JavaScript loop over 32 KiB of bytes takes **52 ms**, a
`memcpy` of the same bytes in C **0.083 ms** and an FNV-1a pass **0.59 ms**
(§13), and `recv` hands the host about one segment (1.5 KiB) per call, some
**550 calls a second at 800 KB/s**. A protocol endpoint in the guest would
spend the frame budget on bookkeeping.

The guest API is small. Its names are set with the capability (§11,
question 2); its shape:

| Guest call | Link |
| --- | --- |
| `request(t, args, {body?, onProgress?})` returns a call at once: `call.reply`, a promise of the reply's value or of an error `{code, message}`, and `call.cancel()` | `REQUEST` `APP` (with `BODY` when a body is given), the `REPLY`, `CANCEL` |
| `onProgress(t, args, stream?)`, called for each progress event of the call; `stream` is the response stream, present from the head step on (§7.2) | `EVENT` on the request id; `DATA` on it |
| `on(t, handler)` for the daemon's requests; the handler gets `(args, call)` and its result is the reply. `call.progress(t, args)` sends a progress event, `call.respond()` returns the stream to write response bytes to after a progress event, `call.body` is the request's body stream | the daemon's `REQUEST` `APP`; the guest's `EVENT`, `DATA` and `REPLY` on its id |
| `emit(t, args)` and `onEvent(t, handler)`; a handler for an event that opens a stream gets `(args, stream)` | `EVENT` `APP` with id 0, or with a fresh id and its stream; `CREDIT` on the channel id as the guest takes events |
| a stream handle with `read(into)` / `write(bytes)` / `close()` | `DATA`, `END`, `RESET`; **the host grants `CREDIT` for a stream only while a `read` is pending on it**, for at most the bytes that `read` asked for and the stream's 16 KiB window allows (§5.6) |
| `state()`: `closed`, `opening`, `open`, with the close reason | `channel.open`, `channel.close` |

- **`call.reply` resolves at the `REPLY`, after the response stream's last
  byte**; an applet that wants the bytes reads them from `onProgress`'s
  `stream` as they come. A call whose response stream the applet does not
  read receives no bytes: no `read` is pending, so no credit is granted,
  and the call ends at the 30 s limit of §5.5. Its stream holds no bytes
  meanwhile. **A `read` left pending on an idle stream (a log tail the
  daemon has nothing to send on) holds that stream's own window and
  nothing of another's**, so a response the applet reads beside it still
  gets credit.
- **A stream the applet has no handler for is reset.** When an event that
  opens a stream names a `t` with no `onEvent` handler, or a handler that
  takes no stream, the guest library closes the stream at once and the host
  sends `RESET` `refused` (§7.2).
- **The host hands the guest, per frame, at most 4 messages or 8 KiB of
  JSON, whichever comes first, and at most 16 KiB of stream bytes**, and
  takes as much from it. **The host shares the per-frame stream bytes among
  the streams with a pending `read` in turn**: the stream served first
  changes each frame, so one saturating stream cannot keep another's held
  bytes untaken until its sender gives up (§5.5). A first message is handed over whatever its size.
  `emit`, `progress` and `write` report "full" when the event window or the
  16 KiB outbound queue has no room, and the applet tries again in a later
  frame.
  8 KiB of JSON costs the guest about 2.4 ms of `JSON.parse` on the measured
  New 3DS (§13) against a worker turn of 5 ms; 4 messages of 8 KiB each
  would cost about 9.6 ms.
- **Three bounded queues hold what waits, per channel** (§7.6), and each
  has a rule for "full":
  - **Stream bytes** sit in each stream's own 16 KiB window, granted
    against pending reads (§5.6); a stream the guest does not read gets no
    credit, and 4 inbound streams hold at most 64 KiB.
  - **Events** are bounded by the channel's event window (§5.6): the host
    regrants units as events leave its queue (taken, discarded or refused,
    §5.6), so a daemon that outruns the
    guest waits on Hub's side. **A paused or hung guest keeps its channel**;
    its daemon's events wait at Hub. `channel.close` `overflow` (§7.5)
    answers only an event sent past the granted units.
  - **Requests from the daemon** are bounded at 8 open, and those not yet
    handed to the guest at **8 KiB of JSON together** (one request is held
    whatever its size); **a request that finds either bound reached gets
    `REPLY` `ERROR` `busy`** from the host.
  The host never drops an event in silence and never stops reading the
  connection for a channel's sake, which would stall every other group and
  end in `silence`. Hub applies the same three rules toward a daemon.
- **Stream bytes cross as `ArrayBuffer` contents the host copies**, never as
  text and never through JSON. The applet does not hash, checksum or
  reassemble them: the carrier delivers the bytes in order and whole.
- While the channel is not open, `request` fails at once with `no_channel`
  and `emit` drops the event; the applet reads `state()` to show that its
  computer side is away.

### 7.4 Generation

`generation` is a **u32 that Hub assigns from one counter for the whole
Hub, larger than every generation it gave before, to any device, across
connections and Hub restarts**; Hub stores the last value beside its device
records (`lastGeneration`, §3.6), not inside one. A counter per device
record would start again at 1 when the owner forgets a device and sets it up
again with the same device id, and a daemon keyed on that id would meet a
generation it has seen. **Hub
writes the new `lastGeneration` to its store before it sends the `REPLY`
that carries it**, so a crash between the two cannot hand the same
generation out twice; a generation stored and never sent is skipped. A
generation names one channel's life to the daemon: **nothing of a generation
is delivered after that generation's close**, and a new open always gets a
larger number. Hub assigns it so the device keeps no counter across reboots.

### 7.5 Close

`EVENT` `channel.close`, header id = the channel id, `{reason}`, from either
side. **It ends the channel in both directions; no reply.** The sender
queues it behind the channel's frames that are already in its write queue
(§5.7, rule 3) and queues nothing of the channel after it: **bytes an applet
or daemon wrote that are not yet in a queued `DATA` frame, and messages
still in a queue toward the wire, are dropped.** Each
side fails its open requests of the channel with `closed` on its own side
and drops the channel's streams; no `REPLY`, `CANCEL` or `RESET` is sent for
them. Frames for the channel's ids that arrive afterwards are discarded.
Channel ids are never reused on a connection, so a late frame cannot reach a
new channel.

| Reason | Sent by | When |
| --- | --- | --- |
| `exit` | device | the applet exits or is switched away, or a push replaces it; sent before the guest is torn down |
| `reset` | device | the applet's realm is reset; a `channel.open` for the new realm follows |
| `daemon` | Hub | the channel's daemon ended or failed to start |
| `policy` | Hub | the owner or Hub's policy ended the channel |
| `overflow` | either | an event arrived past the units its receiver had granted (§5.6): the sender's endpoint does not keep to credit. A guest or daemon that is slow to take its events never causes it |
| `feature` | either | `channel` left use (§6.1) |

**After a close by either side that leaves the applet running** (Hub's
`daemon`, `policy` or `overflow`, or the device's own `overflow`), the
device opens a new channel for the same applet run only when the applet
uses the channel again, **at most once a second**.

**Connection loss closes every channel, with no `channel.close` and no
resumption.** After the next `ready` the device sends `channel.open` for the
applet that is running, which gets a new generation. Phases:

| Event | Channel |
| --- | --- |
| Applet starts | `channel.open` → generation g |
| Realm reset | `channel.close` `reset`, `channel.open` → g + n |
| Applet exits or is switched, push replaces it | `channel.close` `exit` |
| Link drops and comes back | channel gone; `channel.open` after `ready` → a new generation |
| Hub's daemon stops | `channel.close` `daemon` from Hub |

### 7.6 Limits

| Limit | Value |
| --- | --- |
| Channels per connection | **4** (LINK_MAX_CHANNELS). A 3DS runs one applet at a time and opens at most one |
| Open requests per channel, each direction | **8**; one more gets `ERROR` `busy` (§5.2) |
| Open streams per channel, each direction | **4**, counting every stream that carries bytes in that direction: request bodies, response streams and streams opened by events. One more gets `RESET` `refused`; a request whose body or response stream is refused still ends with its `REPLY` (the daemon's or applet's own, or `busy`) |
| JSON object in a channel | LINK_APP_MSG = **min(8,192, the payload limit − 4)** bytes |
| Event window toward the guest, per channel | **48 units** (LINK_APP_EVENT_WINDOW) of one unit per started 512 bytes of JSON, at most 24 KiB held; regranted as events leave the host's queue, taken, discarded or refused; an event past it closes the channel with `overflow` (§5.6) |
| Event window toward the daemon, per channel | **256 units**, regranted as events leave Hub's queue for that daemon |
| Daemon requests not yet handed to the guest, per channel | **8 KiB** of JSON together, one request whatever its size; one more gets `ERROR` `busy` |
| Stream bytes held for the guest, per channel | **16 KiB per inbound stream** (LINK_APP_STREAM_WINDOW, §5.6), granted against pending reads; **64 KiB at most** with 4 inbound streams. Streams share no window |
| Bytes and messages queued from the guest toward the wire, per channel | **16 KiB**; `write` and `emit` report "full" to the guest past it |
| Operation name `t` | **64 bytes** |
| Credit | §5.6; outstanding at most 16 MiB per direction |

### 7.7 What Hub guarantees to the daemon

**A daemon is the computer side of one applet: one process per daemon,
connected to Hub's core over local IPC.** Hub starts it when a device opens
its applet's channel and stops it when it is idle. Toward it Hub guarantees:

1. **One new local connection per accepted channel**, labelled with the
   device id (authenticated by the handshake), the applet id (asserted by the
   device runtime), the generation, and the grants Hub derives from them.
2. Requests, replies, events and stream bytes **unmodified and in the order
   their sender queued them** (§5.7), each at most once.
3. **One close notice per channel, never two**, with its reason; connection
   loss is one.
4. Nothing of a closed generation after its close notice.
5. Backpressure: Hub stops granting the device credit on a stream and
   units of the event window while the daemon does not read, stops reading
   the daemon's events while the device grants none, and bounds the requests
   it holds for a daemon that does not answer (§7.6).
6. **No confidentiality and no integrity against an attacker on the LAN in
   phase one** (§3.9).

### 7.8 Conventions above the channel

**The link defines no caching, revalidation or delivery guarantee for
applets; an applet and its daemon agree on them in their messages.** The
pattern for content the device keeps (a map tile, a glyph page, a timeline
page): the applet names what it holds in the request's arguments, and the
daemon answers that nothing changed.

```
REQUEST  tile.get   {"z":12,"x":3301,"y":1612,"have":"r41"}

REPLY               {"same":true}                 nothing changed, nothing to send

EVENT    tile.head  {"rev":"r42","bytes":18244}   or: the head step (§7.2), on the request's id
DATA                18,244 bytes under the applet's credit, the last frame with END
REPLY               {"rev":"r42"}                 the trailer, after the last byte
```

The applet reads the tile from the stream that `onProgress` hands it at
`tile.head`; the 18,244 bytes pass the 16 KiB window because the applet
takes them while they arrive.

A change the daemon wants the applet to learn of is an event
(`{"t":"tile.stale","z":12,…}`). An operation that must not run twice
carries an id the daemon remembers. These are fields of the applet's own
messages; Hub reads none of them.

## 8. Arbitration

### 8.1 Hub's write queue

**Hub writes to a device connection from one FIFO queue.** Frames leave in
the order they were queued; no frame overtakes another. Fairness without
priorities comes from one rule for producers:

- **A stream producer has at most one `DATA` frame in the queue at a
  time**, and only within credit. It queues the next chunk after
  the previous one has been written to the socket.
- Control frames (`REQUEST`, `REPLY`, `EVENT`, `CANCEL`, `CREDIT`, `RESET`,
  `PING`, `PONG`, `CLOSE`) are queued when produced.

So a frame queued now waits behind at most **one chunk of at most the
payload limit per active stream**, plus the control frames already queued:
on TCP, 16 KiB and about 20 ms of wire time per active stream (§4.4). A 24 MiB
push and a `net.http` reply share the connection chunk by chunk; the push
does not hold the queue for its whole length. Per-producer order (§5.7) holds
because each producer's frames enter the one queue in its own order.

**Hub reads a connection whatever the length of its write queue.** Its
reader never waits for room to queue an answer: the bounds of §9 limit what
it can owe (open requests, credit, event units), and its queue holds that.
A Hub whose reader waited on a bounded write queue could stop draining the
device at the moment the device waits for Hub to drain it.

### 8.2 The device's send buffer

The device has one send buffer (version 1: `link.c` `tx_buffer`, 48 KiB) and
the same producer rule: each stream queues one chunk at a time.
**LINK_TX_RESERVE (64 bytes) of the buffer is kept for `PING`, `PONG` and
`CLOSE` alone**: one `PING` and one `PONG` (16 bytes each) and a `CLOSE`
with a short reason always fit, whatever else is queued, so the keepalive
never waits on bulk data or on a reply. **Every other frame waits for room
outside the reserve**: a `DATA` chunk, and `REPLY`, `EVENT`, `REQUEST`,
`CANCEL`, `CREDIT` and `RESET` as well. A reserve meant to hold a `REPLY`
would have to hold the largest one (an applet's, 8,204 bytes with its
header) and could be filled by replies ahead of a `PONG`. Room comes back as
the socket takes bytes, about 16 KiB every 20 ms at the measured rate; a
`log` event that finds no room is dropped and counted (§6.2), and a frame
of an applet channel that finds none stays in the channel's queue (§7.6).

**The device stops reading the connection while a frame it must answer has
no room** (a `REQUEST` whose `REPLY` or a `PING` beyond the reserve it could
not queue): it leaves further bytes in the socket and reads again when the
send buffer has drained. The answers it owes are thereby bounded by one
receive buffer, and the pause ends as fast as Hub reads, which §8.1
guarantees. **A pending grant is a counter per stream or channel, not a
queued frame**, so credit owed while the buffer is full is merged into one
`CREDIT` when room returns and cannot be lost.

### 8.3 State-changing requests and the device mutex

**On the wire:**

| State-changing | Not state-changing |
| --- | --- |
| `runtime.push`, `runtime.native.install`, `runtime.launch`, eval (§6.3) | `runtime.status`, `runtime.screenshot`, `runtime.logs`, other DevTools lines, catalog and install (device-initiated), `net.http`, agent, applet channels, `runtime.apps` |

- **Hub has at most one state-changing request open per device.** It sends
  the next one only after the previous one's `REPLY`, or after the
  connection that carried it has closed. For eval, the `evalResult` line
  stands for the `REPLY`; a `guest.end` line (§6.3) or 30 s without an
  answer (§5.5) end the eval.
- **After a reply with `phase: "launching"`, Hub sends no state-changing
  request to that device until the device links again or 60 s pass**: the
  device is exiting into another program (§6.2).
- **The device keeps one slot for state-changing requests** and answers a
  second one with `ERROR` `busy` (§6.2). This catches a Hub that breaks the
  rule above, and a second Hub process that should not exist.
- Not state-changing requests take no lock on either side.

**Inside Hub.** Hub keeps the rule above with a mutex per device that its
own clients (its UI, its CLI, `3ds:dev`, the studio relay, the agent) take
before Hub sends a state-changing request; the holder is visible in Hub's
device status for the UI, and the mutex is released at the request's
`REPLY`, at the end of the `launching` hold, when the connection closes, or
when the holder's local client goes away (Hub then sends `CANCEL` for its
open request). The device never sees the mutex. **What Hub does with a second
client while the mutex is held — refuse it at once with `busy` and the
holder, or let it wait in a bounded queue and report the holder on timeout —
is Hub's own choice and not part of this protocol** (§11, question 14).
Pocket Hub's development bridge answers `busy` with the holder today.

Priorities, in-flight slots per client and quotas are deferred until
contention shows; the write queue of §8.1 and the one-request rule above are
phase one.

## 9. Limits and budgets

| Name | Value | Rationale |
| --- | --- | --- |
| Beacon port (UDP) | **8627** | kept from version 1 |
| Link port (TCP) | **8628**, ephemeral when taken | kept; beacons carry the port in use |
| Beacon size | **64 bytes** | kept layout, version byte 2, flags 0 |
| Beacon interval | **1 s** | kept; the device's 2.5 s direct try covers a lost beacon |
| Broadcast address list refresh | **10 s** | listing interfaces every second cost a small companion a tenth of a core (Pocket Hub's version 1 endpoint) |
| Direct try after | **2.5 s** without a beacon | kept (`link.c` `LINK_SEARCH_DIRECT_MS`) |
| Backoff | **1 s doubling to 8 s** | kept |
| Refusal hold | **30 s**, also after the device's own `CLOSE` `auth` | kept; the `auth` case is new (§3.8) |
| Duplicate device id | **3** replacements of a connection that answered Hub's `PING` within **2 s**, within **30 s**, then `refused` `busy` | two consoles running one card image; a half-open connection is not counted (§2.4) |
| Connect timeout | **4 s** | kept |
| Handshake timeout | **6 s** | kept |
| Connections held by Hub | **32** | kept from version 1 |
| Pairings per device | **8** key files; a ninth is a setup error that Hub's setup refuses to write | `LINK_MAX_COMPANIONS`; the device reads in directory order and writes no key file (§3.2, §3.6) |
| Link key | **32 bytes**, minted by Hub per device, written to the device's storage | §3.1, §3.2 |
| Nonce | **16 bytes** | kept |
| Ids (device, Hub) | **16 hex digits** | kept |
| Preamble | **8 bytes** | §4.1 |
| Frame header | **12 bytes** | §4.2 |
| LINK_MAX_PAYLOAD | negotiated: **16,384 bytes** on TCP, **1,024 to 32,768** on any carrier | §4.4: throughput is flat from 1 KiB to 32 KiB writes, a 16 KiB frame holds the connection about 20 ms at 800 KB/s |
| LINK_MAX_CTRL | the payload limit | one JSON object per frame |
| LINK_APP_MSG | **min(8,192, LINK_MAX_PAYLOAD − 4) bytes** | a JSON object in an applet channel beside its 4-byte channel id (§7.2); guest parse time (§13) |
| LINK_MAX_HANDSHAKE | **1,024 bytes** | `hello` at every limit is about 800 bytes; equals the smallest receive buffer (§3.3) |
| `CLOSE` reason | **120 bytes** | one status line |
| Error `message` | **240 bytes** | |
| `features` list | **16** entries of **24** bytes | as in `hello` |
| `features` events | at most **1 a second** per side | a flapping agent sign-in does not flood the link |
| `runtime.apps` | **64** rows in a report, reports at most **1 a second**, pages of whole rows | `LAUNCHER_MAX_APPS`; a report that does not fit one frame is paged with `set`, `at`, `more` (§6.2) |
| `catalog` | the first **64** rows by `id`, pages of whole rows, one page per request; a row at most about **520 bytes** | paged with `after`, `rev`, `more` (§6.4) |
| Catalog fetch | **one at a time** per connection | Hub keeps one snapshot per connection (§6.4) |
| Catalog snapshot | one per connection, kept **30 s** from the last page request on it | a fetch completes while the offer changes; `changed` only for a `rev` with no snapshot (§6.4) |
| Ping interval | **3 s** | kept |
| Silence | **10 s** | kept; covers a measured 5.7 s stall on a small companion and the 100 ms stalls of the 3DS (§13) |
| Close drain | **1 s** | `devserver_flush(1000)` before a `.3dsx` start |
| Request stall | **30 s** | kept (`LINK_REQUEST_STALL_MS`) |
| Cancel grace | **10 s** | frees an id when no reply follows `CANCEL` |
| Hub requests open at the device | **8**, of which **1** state-changing and **1** screenshot | the device holds one staging file of each kind and one pair of screenshot buffers |
| Device requests open at Hub | **8** `net.http`, **4** catalog and install, **1** `devtools.open`, **4** channels, **8** per channel | kept from version 1 (`LINK_MAX_REQUESTS` in `link.ts`), §6.3, §7.6 |
| Outstanding credit per stream direction | **16 MiB** | bounds arithmetic and a peer's buffering |
| Device receive window, bulk | **64 KiB** | four frames on TCP; `LINK_RX_BUDGET` |
| Device receive window, `net.http` | **8 KiB** | `LINK_HTTP_WINDOW` |
| Device receive window, applet streams | **16 KiB per stream** (LINK_APP_STREAM_WINDOW), **64 KiB per channel** with 4 inbound streams | one frame per stream; the guest takes 16 KiB of stream bytes per frame across its streams (§7.3); a window of its own keeps a pending read on an idle stream from holding another stream's credit (§5.6) |
| Stream sender without credit | gives up after **30 s**; the DevTools stream is exempt: Hub drops the held line and keeps the stream | §5.5, §6.3 |
| LINK_APP_EVENT_WINDOW | **48 units** granted by the device per channel, **256** by Hub; one unit per started 512 bytes of an event's JSON, returned when the event leaves the receiver's queue for any reason | holds the about 20 events a 100 ms stall releases at 200 events a second; bounds the device's event memory at 24 KiB (§5.6) |
| Hub receive window | **256 KiB** | about 320 ms at 800 KB/s |
| Device received bytes per pump | **64 KiB** | kept (`LINK_RX_BUDGET`): bounds a frame's link work and SD writes |
| Device receive buffer | **12 + 16,384 bytes** on TCP | one whole frame of the payload limit it offers |
| Device send buffer | **12 + 16,384 + 16 KiB** on TCP | one chunk and room for control frames |
| LINK_TX_RESERVE | **64 bytes** of the send buffer | `PING`, `PONG` and `CLOSE` alone; every other frame waits for room (§8.2) |
| DevTools line ring (in) | **4 × (16 KiB + 1)** | kept (`CTRL_IN_BYTES`) |
| DevTools out buffer | **64 KiB** | holds one maximal line until credit and buffer room let it out |
| DevTools line, device → Hub | **64 KiB** | the development connection's frame limit, which tree dumps need |
| DevTools line, Hub → device | **16 KiB** without its `\n` | kept (`POCKET_RUNTIME_MAX_CTRL_BYTES`) |
| Eval | the whole line **16 KiB**; the code is what remains, about 16,340 escaped bytes | one Hub → device line (§6.3) |
| `runtime.push` | **1 byte to 24 MiB** | kept |
| `.3dsx` | **32 bytes to 32 MiB**, name **6–64** bytes | kept |
| `install` | **24 MiB**, **64** catalog rows | kept |
| `net.http` | body **64 KiB**, response **256 KiB**, **32 headers**, encoded `headers` **8 KiB**, encoded `url` **2 KiB**, timeout **120 s**, **3** redirects; in use from a payload limit of **12,288** | kept (`net.ts`) but for the URL, 8 KiB in version 1, and the limits now counting encoded bytes (§6.5) |
| Log text | **1 KiB**, and at most the payload limit − 96; `frame` and `dropped` are u32 | §6.2 |
| Agent shot and screen | **153,600 bytes** | 320 × 240 RGB565 |
| Agent atlas | **333,616 bytes** | `GLYPHS_MAX_BYTES` |
| Microphone | **30 s** at **16,360 Hz** s16le | `AGENT_MIC_MAX_MS`, `AGENT_MIC_RATE` |
| Channels per connection | **4**; 3DS opens **1** | one applet at a time on a 3DS |
| Per channel | **8** open requests and **4** streams each direction; an event window of **48 units** (24 KiB) and **8 KiB** of waiting daemon requests toward the guest; guest hand-over **4 messages or 8 KiB of JSON, and 16 KiB of stream bytes, a frame** | §7.3, §7.6 |
| Channel generation | **u32** from one counter for the whole Hub, larger than every earlier one | §7.4 |
| LINK_CHANNEL_OPEN_MS | **20 s** | Hub's longest wait before answering `channel.open`: about 10 s for a daemon started on demand, inside the 30 s stall |
| `channel.open` retry after `busy` | **2 s doubling to 60 s** | a daemon that failed to start is not restarted in a loop |

Device memory for the link on a 3DS, against version 1's link (`link.c`:
32 KiB receive, 48 KiB send) plus the development connection (`devserver.c`:
64 KiB receive, 64 KiB line ring, 64 KiB send): **about 16 + 32 + 64 + 64 =
176 KiB of buffers on TCP instead of about 272 KiB** (receive, send, the
DevTools line ring and its out buffer). **Each open applet channel adds
at most 112 KiB**: 64 KiB of stream bytes (4 inbound streams of 16 KiB),
24 KiB of events under the event window, 8 KiB of daemon requests waiting
for the guest and 16 KiB queued from the guest (§7.6). A 3DS opens one
channel, so the link holds **at most about 288 KiB** with it, against the
272 KiB of version 1's link and the development connection together; a
channel with one inbound stream open holds 64 KiB and the link 240 KiB.
Four channels, the connection's bound, would hold up to 624 KiB, which is
why a device that runs one applet opens one. The stream windows are
allocated as streams open, not with the channel. **A stream whose window
the host cannot allocate is answered `RESET` `refused`**, as a stream past
the channel's bound is (§7.6); its request still gets its `REPLY`. The screenshot's linear
buffers come on top while a capture is in flight, as today.

## 10. Conformance and test vectors

The reference implementation ships vectors as JSON files in
`tests/vectors/pocket-link-2/`, generated by `tools/pocket-link/vectors.ts`
from fixed inputs and checked by three suites: the TypeScript codec and
console client (`tests/pocket-link.test.ts`), the device's socket-free C
compiled on the build machine (`tests/3ds-link.test.ts`), and Hub's Rust
endpoint (from the PocketJS submodule). **Bytes are given in hex; each
transcript step names its sender.** For handshake frames and binary frames the
sender's bytes must match byte for byte; for JSON control messages the vectors fix
one byte form (no whitespace, keys in the order listed in §6), receivers must
accept any key order and whitespace, and tests compare parsed values.

| File | Contents |
| --- | --- |
| `beacon.json` | beacons with a 40-byte name, a name cut inside a multi-byte character; refused datagrams: 63 and 65 bytes, wrong magic, version 1, port 0, an uppercase id; a beacon with flag bit 0 set, which a version-2 receiver accepts and whose flag it ignores |
| `pairing-files.json` | a `device.txt` and a `companions/<hub id>.txt` as Hub writes them, byte for byte; files the device accepts (a missing final newline, fields in another order) and refuses (a 63-digit key, an uppercase id, a missing `key=`); Hub's decision for a card with and without `device.txt`, and for a companion file whose key matches and does not match its record, for a `companions/` folder that holds 8 files of other Hubs (nothing written), and for a write whose readback fails (two candidates kept, the setup reported as failed) (§3.2); a transfer cut before the rename, which leaves a `.new` and the old key file whole, and the next setup that removes the `.new`; a setup that finds a file holding neither candidate and discards both before it mints; a file whose key matches and whose address differs, rewritten with the `.last` deleted; a folder with 8 loadable key files and two files the device would not load, which does not count the two; a `.last` file, a damaged one that falls back to the key file, and nine key files of which the device reads eight and reports the error |
| `preamble.json` | the device's preamble; Hub selecting 2; Hub answering a range 3–4 with `selected` 0; a version-1 console preamble and Hub's answer; a device with range 2–3 sending its preamble alone, Hub selecting 2, then the device's version-2 `hello`; the same device sending a version-3 `hello` without waiting, and the `CLOSE` `protocol` that version 2's frame checks give it |
| `frames.json` | one encoding per frame type and flag, the `APP` frames with their channel id; refused headers: non-zero `reserved`, an undefined flag, `length` one over the negotiated limit (16,385 and 1,025), `REQUEST` with id 0, `DATA` of 0 bytes without `END`, `CREDIT` of 0, `PING` of 3 bytes, `REQUEST` with `BODY` and no `APP`, a `HANDSHAKE` after `ready` |
| `handshake.json` | a full transcript from fixed ids, key and nonces: each frame's bytes, the two HMAC message strings and both proofs; `maxPayload` 16,384 and 1,024 offered and the limit each pair gives |
| `handshake-refusals.json` | `unknown_device` (no key; another companion id), `bad_proof`, `malformed` (a `maxPayload` of 512 among them), `busy`; the device's `CLOSE` `auth` after a wrong `challenge.proof` and its 30 s hold; a `ready` with `maxPayload` 512 and the device's `CLOSE` `protocol`; Hub with two candidate keys proving with the newer, then with the other after a `CLOSE` `auth`, and keeping the one that reaches `ready`; a third replacement within 30 s of a connection that answered Hub's `PING`, and the `refused` `busy` that follows; three replacements of connections that answered nothing, after which the device still links; a frame of type `DATA` before `ready` |
| `requests.json` | a request with progress events and a reply; an error reply of each generic code; `unknown_message`; `CANCEL` answered by `cancelled`; `CANCEL` crossing a finished reply; ids with bit 31 |
| `streams.json` | a `runtime.push` of 100,000 bytes under 64 KiB credit with `END`; bytes past credit and the `CLOSE` `flow`; a grant over 16 MiB; `RESET` `refused` of an `agent.glyphs` stream; a stream short of its declared bytes; an event with an unknown `t` and a fresh id answered `RESET` `refused`; an event stream never granted and its sender's `RESET` `cancelled` at 30 s; a DevTools line held 30 s without credit, dropped with its eval failed and the stream kept |
| `channel.json` | a channel's life: `channel.open`, the reply with generation 7; a request from the applet with a reply; a request from the daemon with a reply; an event each way; a request with `BODY`; **a response of 18,244 bytes: the head event, `DATA` under the stream's 16 KiB window, a second grant after the guest's read, `END`, then the `REPLY`**; the same response completing while a `read` of 16 KiB stays pending on an idle event stream, which holds its own window and none of the response's; four streams read together with at most 64 KiB held; a request cancelled with its head event on the wire, the event discarded and its unit regranted; a progress event on an id of the receiver's range that names nothing held, ignored; `agent.glyphs` queued after a daemon request with a larger id and its stream still opened; a progress event named `log` and one named `features` read as progress; an event that opens a stream; a fifth stream refused with `RESET` `refused` and the request's `REPLY` after it; `CANCEL` answered `cancelled` by Hub for a daemon that does not answer; a JSON object of 8,193 bytes answered `too_large`, and one of 8,189 bytes refused on a connection whose payload limit is 8,192 (LINK_APP_MSG 8,188); the event window: `CREDIT` on the channel id for 48 units, an event of 600 bytes costing 2, progress events counted, the regrant after the guest takes events, a daemon held back with no units and no close, and an event past the units answered `channel.close` `overflow`; a progress event named `log` that crosses the applet's `channel.close` and is ignored; a stream-opening event with no handler answered `RESET` `refused`; two response streams of which the applet reads one, which completes while the other gets no credit; a daemon's bytes refused before any progress event; a daemon request refused `busy` with 8 KiB of requests waiting; a ninth open request answered `busy`; an `APP` request for a channel that is not open answered `no_channel`; `channel.close` `reset` with a request open and the reopen with generation 8; frames for the closed channel's ids discarded; a fifth channel refused with `busy`; a reconnect and the reopen with a larger generation; `no_daemon` and `busy` refusals with the device's retry times; a `REPLY` held 10 s; a `CANCEL` crossing an accepting `REPLY` and the device's `channel.close` `exit` |
| `features.json` | Hub dropping `agent` with a microphone stream open (the `RESET` before the `features` event) and adding it back; the device dropping `devtools` (stream reset) and adding it back (a new `devtools.open`); Hub dropping `channel` with a channel open (`channel.close` `feature`); a request of a dropped group crossing the event and answered `unsupported`; a second change inside one second sent at its end; a list of 17 entries closing with `protocol` |
| `keepalive.json` | `PING` / `PONG` echo; a timeline with timestamps where a side closes with `silence` at 10 s, one where a 100 ms gap changes nothing, and one where `DATA` alone keeps the link up |
| `messages.json` | one golden JSON per message of §6 (requests, replies, events, errors), with each field at its limit and one past it; a `runtime.apps` report of 64 rows of ordinary size in one 16 KiB frame, one with every field at its limit in two pages, one cut short by a change and restarted under the next `set`, a page with a wrong `at` after which Hub ignores the rest of that `set`, and a page of an older `set` ignored; a catalog of 64 rows fetched in pages with `after` and `rev` while the offer changes (served from the snapshot), a page request 31 s after the last one answered `changed`, and an offer of 70 apps of which the first 64 by `id` are served; a DevTools stream with a pending eval, then `guest.end`; a Hub-to-device line cut by a guest switch whose tail is discarded up to its `\n`; a `net.http` request and a `net.head` at their encoded limits, a response whose headers Hub drops to fit with `truncated: true`, a `log` event at the 1 KiB floor with `frame` at 2^32 − 1, and a second catalog fetch asked for while one runs, started after it |

The C client builds a POSIX variant of `link.c` on the build machine and runs
the transcripts against itself; Hub's tests run its endpoint against the
TypeScript console client, as Hub's version 1 tests do with
`console-client.ts`.

## 11. Open questions

1. **The size limit of a JSON object in an applet channel.** §7.2 sets
   8 KiB and aims at 2 KiB, from parse times on a New 3DS (§13). The worker
   realm's turn is 5 ms and an Old 3DS is slower by a factor nobody has
   measured, so 8 KiB may cost more than a turn there. Options: keep 8 KiB;
   lower it to 4 KiB; let the device state its limit in `channel.open`.
   *Recommendation:* keep 8 KiB until the Old 3DS number exists (question 3).
2. **The channel capability's name and the guest API's names**, set in the
   PocketJS spec and added to the applet whitelist. §7.3 fixes the shape.
   *Recommendation:* capability `link.channel`, beside `link.companion`; the
   API under `globalThis.link.channel`.
3. **No Old 3DS measurement.** Every number of §13 comes from a New 3DS XL.
   The limits that rest on guest speed (LINK_APP_MSG, the 4 messages or
   8 KiB of JSON and the 16 KiB of stream bytes handed over per frame) and on socket-call cost (about 550 `recv`
   calls a second at full speed) need the same runs on an Old 3DS.
   *Recommendation:* run the probe of §13 on an Old 3DS before the C client
   merges.
4. **The cause of the 100 ms stall** (§13) is not known. It appears as the
   worst single socket call in every run, in both directions. Nothing here
   depends on its cause, only on its size. A stall of that length does bound
   how responsive an applet can promise to be: a round trip is about 8 ms
   and now and then about 100 ms. *Recommendation:* find the cause when the
   C client is rebuilt; if a socket or power option removes it, set it.
5. **`https://companion.pocket/<service>` over `net.http`.** Applet channels
   and daemons replace this path, and `net.http` then reaches the internet
   alone; until an applet's daemon exists, an applet that uses a service
   loses it if Hub stops answering the origin. Options: keep answering it in
   phase one; drop it with version 2. *Recommendation:* keep it until the
   first daemons run; removing it is one check in Hub. Applets whose needs
   are a request and a reply may keep this shape for good: whether it stays
   beside channels is undecided.
6. **Guest log lines.** `runtime.logs` needs the shim's console bridge to
   emit through a host operation regardless of a panel
   (`framework/src/devtools.ts`). Option: leave guest lines inside the
   DevTools stream and have Hub filter `{"t":"log"}` lines, which means
   keeping `listening` on and paying the tree snapshots (§6.3).
   *Recommendation:* add the host operation (for example `ui.__dbgLog`) in
   the same change as the 3DS client.
7. **Pairing without the camera: decided.** The QR scan with the console's
   camera goes away, and Hub writes the pairing, the key included, during
   the first install (§3.1, §3.2). A variant in which Hub writes a one-time
   secret and the first connection mints the key was considered and
   declined: the LAN is trusted in this version (§3.9), and the variant
   keeps a pairing mode in the C client. What the decision costs:
   - **Pairing another computer, or pairing again after a forget, needs ftpd
     running on the device or the SD card in a reader.** Version 1 needed
     the camera and Hub's screen.
   - **The key crosses the LAN in plain FTP during the setup** (§3.9).
     Version 1's key was masked with the secret in the QR code.
   - The device loses `link.pair`, `quirc` and the camera path of pairing;
     `camera.qr` as an applet capability is not affected.
   - A carrier without a file channel (a UART on a device with no storage
     access from the computer) needs another way to place the two files.
   **Still open:** that way for a carrier without a file channel, decided
   with the carrier (question 10).
8. **Pocket3D pack delivery.** `products/3ds/src/packs_delivery.c` takes
   `pocket3d.packs` control lines over the development connection, pumps
   `devserver_poll` while it fetches pieces from a temporary HTTP endpoint on
   the computer, and gives up when `devserver_connected()` turns false
   (`tools/pocket3d-delivery.ts`). `products/3ds` itself does not call it.
   Options: three Hub-to-device requests (`packs.piece`, `packs.manifest`,
   `packs.prune`) streaming the bytes over the link; an applet channel of
   the program that uses the packs; leave it out of version 2.
   *Recommendation:* leave it out of phase one and carry it on that
   program's channel when it moves to version 2.
9. **Other users of version 1's C client.** pocket-m5's M5Stack Tab5 firmware
   compiles `engine/host-services/link.c` (`engine/host-services/README.md`
   "Programs") and sends `companion.pocket` over the whole-response `net`
   mode (`docs/WORKER.md`). How Hub writes a pairing to it is not defined. *Recommendation:* replace `link.c` in place;
   pocket-m5 pins a PocketJS commit before the change until it moves, and
   its way to receive the pairing files is decided with its carrier.
10. **The carriers beyond TCP.** §2.0 says the link is the only transport,
    and phase one specifies TCP. Still outside it, and each to become a
    carrier of this protocol or be retired:
    - **The PSP's USB carrier** (`link.ts` "USB carrier"): files in a
      PSPLINK share with its own records. As a carrier it needs an adapter
      that turns the share into an ordered byte stream, and a payload limit
      for its polling rate. Undecided: adapt it or retire it with version 1.
    - **The SVC wire** (`PKNT`, UDP 8621 and its TCP connection), which the
      3DS pumps every frame as a third connection to a computer. Its users
      would move to an applet channel. Undecided: who moves them and when.
    - **`io.offload` over TCP 8741** and the PSP's USB offload provider
      (`docs/OFFLOAD.md`): a per-app connection from the computer to the
      device with its own key. An applet channel covers the same ground.
      Undecided: whether offload becomes a channel or stays for worker
      compute.
    - **The Vita's USB share** (`docs/VITA-USB.md`), which carries updates,
      status and captures and is no link host today.
    - **Bluetooth and UART** themselves: no adapter is specified, and the
      UART adapter's framing, checksum and retransmission are not designed.
    *Recommendation:* leave all of them as they are in the change that lands
    the TCP carrier, and write each adapter when a device needs it.
11. **Ports.** Keeping 8627 and 8628 means a version-1 Hub and a version-2
    Hub on one computer collide (the second takes an ephemeral port, its
    beacons say so). *Recommendation:* keep them; there is no migration.
12. **Which Hub a device prefers.** With several paired Hubs answering, the
    first beacon wins. Option: prefer the Hub linked last.
    *Recommendation:* keep the first-beacon rule until an owner with two Macs
    reports a problem.
13. **Control messages larger than the payload limit.** The two row lists
    are paged: `runtime.apps` with `set`, `at`, `more` (§6.2) and the
    catalog with `after`, `rev`, `more` (§6.4), so no carrier loses rows.
    The JSON cost is settled as well: scanning in C takes microseconds
    (§13), so no message moves to a binary payload. `net.http` and
    `net.head` are bounded on their encoded size and fit 16 KiB; **they do
    not fit under 12,288 bytes, and `net.http` is out of use there** (§6.5).
    **Still open:** the
    other control messages are bounded by their fields and fit 16 KiB, and
    whether each fits the 1 KiB floor has not been checked field by field
    (an `agent` message and a `runtime.status` reply are the candidates);
    a carrier that negotiates a limit under their size, or under 12,288 with
    applets that need `net.http`, needs either a higher floor or a paged or
    streamed form of the message. *Recommendation:* check them when the
    first carrier under 4 KiB is designed, and raise the floor before
    paging a third message.
14. **Hub's device mutex: refuse or queue.** §8.3 leaves to Hub what it does
    with a second client while a state-changing request is open; the wire
    looks the same either way. Options: refuse at once with `busy` and the
    holder (Pocket Hub's development bridge today); a bounded FIFO wait,
    reporting the holder when the wait times out. The studio relay pushes in
    the background and would otherwise poll. *Recommendation:* the bounded
    FIFO wait, reporting the holder on timeout; it costs the device nothing.
15. **When media moves onto the link.** Version 2 keeps the side TCP
    connection (§1, decided). It exists on the TCP carrier alone, so a
    device on Bluetooth or a UART has nothing to play from until media is a
    credited stream of the link, at the link's rate shared with everything
    else (700–900 KB/s on the measured 3DS, §13). *Recommendation:* decide
    with the second carrier, and measure a media stream beside an install
    on one link before moving it.
16. **Programs built on record formats of their own.** pocket-map and
    pocket-term have pilots on Pocket Relay (PocketJS #456) and ship on
    `io.offload` records today. With no Relay in the link they move to an
    applet channel and the conventions of §7.8, or stay on offload
    (question 10). Who ports them, and what becomes of #456, is the
    owner's and its author's decision and is not made here.

## 12. Implementation notes

Three implementations follow this page on the branch that carries it; the
spec, the reference client, the vectors and the 3DS client merge together,
since `tests/3ds-link.test.ts` checks the C client against the TypeScript
contract.

### 12.1 TypeScript reference (this repository)

1. `contracts/spec/link.ts`: version-2 constants (ports, preamble, header,
   frame types, flags, close codes, labels, limits of §9), the message types
   of §6 and §7, the features. The USB carrier's records stay until question
   10 is decided. The pairing URI's constants go.
2. `tools/pocket-link/protocol.ts`: the version-2 codec. **Reuse** the
   beacon and HMAC functions with the new labels and version; replace the
   frame decoder (12-byte header, the negotiated limit, the checks of §4.7)
   and add the preamble exchange. **Remove** `buildPairUri`, `maskKey` and
   the pairing-window code; add the reader and writer of the two pairing
   files (§3.1).
3. `tools/pocket-link/vectors.ts` and `tests/vectors/pocket-link-2/` (§10);
   `tests/pocket-link.test.ts` against them.
4. `tools/pocket-link/console-client.ts`: the device side in TypeScript —
   the handshake from a pairing record, credit, requests in both directions,
   a runtime operation responder with fakes, the DevTools stream, applet
   channels with requests, events and streams — for Hub's tests and desktop
   hosts. **It is the reference peer**: the C client and Hub's Rust endpoint
   are each tested against it and against the vectors.
5. `stream-credit.ts`: lift the 1–8,192 byte capacity bound to the windows of
   §5.6. `fetch.ts`: the URL limit drops from 8 KiB to 2 KiB and the header
   limit counts encoded bytes (§6.5); the rest is kept, and Hub's Rust
   endpoint ports its policy. **`catalog.ts` changes**: rows ordered by `id`
   in byte order before the cut to 64 (today by title, then 64), a limit on
   `title`, `version`, `output` and `id` beside the one on `summary`, a
   revision counter, and pages with `after`, `rev`, `more` from a snapshot
   (§6.4). `qr.ts` is no longer part of the link.
6. Retire with the 3DS client: `contracts/spec/pocket-runtime-wire.ts`,
   `tools/3ds-runtime-client.ts`, `tests/3ds-runtime-wire.test.ts`,
   `tools/3ds-keys.ts` and the `3ds:wire` lease. `tools/3ds-dev.ts` becomes
   a client of Hub's CLI.

### 12.2 3DS C client (`engine/host-services`, `products/3ds`)

1. `link_proto.c/h`: version-2 constants, preamble, header read and write,
   beacon, proofs; the URI parser goes; tested from the vectors in `tests/3ds-link.test.ts`
   first.
2. `link.c`: **reuse** the phase machine (search, direct try, backoff), the
   companion files' reader, the install path into slot staging, the guest
   events and `link_status_json`. **Remove** mode `pair`: `link_pair`, the
   pairing across hosts, and the camera and `quirc` path that fed it.
   **`save_companion` no longer touches the key file**: it writes
   `<hub id>.last` (name, address, port) when a value changed, and
   `load_companions` reads the `.last` file over the key file's values,
   stops at 8 key files and reports a ninth (§3.6). `link.forget` removes
   both files. The device holds a Hub for 30 s after its own `CLOSE` `auth`
   (§3.8). Replace framing, add the preamble exchange, the
   negotiated payload limit, the id counter of §5.1, a table of open requests
   in both directions with each id's channel, per-stream credit, the
   send-buffer reserve and one-chunk rule (§8.2), `CLOSE`, features, and the
   channel module: `channel.open` / `channel.close`, the `APP` frames, the
   event lookup by header id and by the id's range, with no mark kept (§5.3), the
   mandatory head step, the event window with its `CREDIT` on the channel
   id, units returned when an event is taken, discarded or refused, and
   `overflow` past it, the 16 KiB window of each inbound stream granted against
   pending reads, the `busy` bound on waiting daemon requests, the read
   pause of §8.2, and the guest operations of §7.3. **All of it is C; the guest's part is the calls of
   §7.3.**
3. A runtime-operations module (for example `products/3ds/src/link_runtime.c`)
   taking from `devserver.c`: push staging and receipts as events and replies,
   `.3dsx` (`native.c` unchanged), launch, screenshot (linear buffers, the
   stream), status, logs, `devserver_debug_stats` / `devserver_debug_frames`,
   the DevTools line ring and out buffer, the dev menu snapshot
   (`devmenu.c`). `qjs.c`'s `__dbg*` operations call it. `packs_delivery.c`
   uses `devserver_poll` and `devserver_connected` (question 8).
4. Remove `devserver.c/h`, the `dev.key` load and UDP 8131. From
   `dev_protocol.c` keep the CRC-32 and `.3dsx` name check that `native.c`
   uses; drop the hello, ack, discovery and frame codecs.
5. `link_http.c`: `CREDIT` frames instead of `net.credit`, the response
   window granted with the request, frames up to its window split into its
   1 KiB worker slots, `CANCEL` instead of `net.cancel`.
6. `agent.c`: grant the declared bytes of `agent.screen` and `agent.glyphs`
   or `RESET` `refused`; send microphone and shot data within credit.
7. `framework/src/devtools.ts`: the console bridge's host operation for
   `runtime.logs` (question 6).

### 12.3 Hub's Rust endpoint

Hub's endpoint lives in Hub's resident core process and is written in Rust;
its daemons are separate processes, one per daemon, that reach the core
over local IPC (§7.7).

1. Codec and vectors first: preamble, header, frame types, handshake proofs,
   checked against `tests/vectors/pocket-link-2/` from the submodule.
2. Listener with the ephemeral fallback, beacon sender (targets of §2.2),
   the handshake with the negotiated payload limit, the device store (mode
   0600) with the Hub-wide `lastGeneration` beside it, one link per device
   and the duplicate-id refusal (§2.4). **The setup that writes a
   pairing** (§3.2): one procedure over ftpd or on the mounted SD card:
   read `device.txt`, list `companions/` and refuse at 8 loadable files,
   discard the candidates the key file does not hold, store the minted key
   as a candidate, write `<hub id>.new`, read it back, delete `.last`, delete and rename,
   read back again, report a setup without a final match
   as failed, end a setup whose read failed with the record untouched, write
   `.last` alone for an address that is none of Hub's own (over ftpd, not
   the FTP connection's local address); and the two-candidate handshake
   until the first `ready`. A new `ready` of a device id ends the older connection's requests, streams and channels at once; the duplicate-id count needs the `PING` to the
   replaced connection (§2.4). It runs beside the step that installs the
   program.
3. Keepalive and silence; the FIFO writer with the one-chunk rule; credit;
   request tables in both directions; `CANCEL`; `CLOSE`.
4. Runtime operations and the device mutex, the PNG composition that
   `combinePocketRuntimeScreens` does today, and the CLI that `3ds:dev`
   calls. This unblocks development on a 3DS.
5. Catalog and install through the `pocket-package` crate, keeping
   `catalog.ts`'s rules (target variants, footer hash, one row per
   id, folder watch, size and hash from the open descriptor) with the order,
   field limits, revision and per-connection snapshot of §6.4.
6. `net.http`: port `fetch.ts`'s destination policy, redirects, limits and
   macOS proxy settings.
7. DevTools relay to panels and CLI; agent messages and streams forwarded to
   the agent's process; applet channels mapped to one local IPC connection
   per generation, with the id table, the per-channel bounds of §7.6,
   credit and event units passed through to the daemon's reads, `CANCEL`
   answered by Hub itself (§5.4), the head step enforced on a daemon's
   writes, and a reader that never waits on the write queue (§8.1).
8. Tests: the endpoint against `console-client.ts` on loopback, and against
   the POSIX build of the C client (Hub's version 1 tests build `link.c` the
   same way, `engine/host-services/README.md`).

## 13. Measurements

**One device was measured: a New Nintendo 3DS XL (model 4) on Wi-Fi, on
2026-11-10, against a computer on the same LAN. An Old 3DS is slower and was
not measured** (§11, question 3). The numbers come from a test program built
from this repository's 3DS product with native test functions linked in as a
product extension and called from the guest; timings are the device's system
tick. Each row is one run or the range of a few; none is a statistic.

### 13.1 The carrier

Raw TCP between the device and the computer, **1 MiB each way**, no link
protocol in between:

| Write or read size | 3DS → computer | computer → 3DS |
| --- | --- | --- |
| 1 KiB | 714 KB/s | 839 KB/s |
| 4 KiB | 850 KB/s | 712 KB/s |
| 8 KiB | 835 KB/s | 712 KB/s |
| 16 KiB | 912 KB/s | 715 KB/s |
| 32 KiB | 881 KB/s | 741 KB/s |
| 64 KiB | 611 KB/s; one call took 660 ms | 767 KB/s |

- **Throughput is 700–900 KB/s in both directions and flat from 1 KiB to
  32 KiB.**
- **`recv` returns about one segment (1.5 KiB) per call whatever the buffer
  size**: 684 to 1,532 calls for 1 MiB.
- **The worst single call of every run took 95–105 ms**, in both directions
  and in the round trips below. The cause is not known (§11, question 4).

Round trip of a message (the device sends n bytes and reads n bytes back,
100 times):

| n | Mean | Worst |
| --- | --- | --- |
| 16 B | 7.7 ms | 94 ms |
| 256 B | 8.3 ms | 95 ms |
| 1 KiB | 8.7 ms | 95 ms |
| 4 KiB | 15 ms | 100 ms |

`TCP_NODELAY` made no difference (8.4 ms without it at 16 B).

### 13.2 Work on the device

| Work | Time |
| --- | --- |
| C: `json_find` to the last key of an object of 286 B | 6 µs |
| C: the same, 1.7 KiB | 32 µs |
| C: the same, 13 KiB | 237 µs |
| C: the same, 26 KiB | 489 µs |
| C: `memcpy` of 32 KiB | 0.083 ms |
| C: FNV-1a over 32 KiB | 0.59 ms |
| Guest (QuickJS, UI realm): `JSON.parse` of 300 B | 0.1 ms |
| Guest: `JSON.parse` of 2 KiB | 0.6 ms |
| Guest: `JSON.parse` of 16 KiB | 4.8 ms |
| Guest: `JSON.parse` of 32 KiB | 9.7 ms |
| Guest: `JSON.stringify` | about 1.4 times the parse of the same size |
| Guest: a JavaScript loop reading 32 KiB of bytes | 52 ms |

### 13.3 Today's channels, end to end

| Path | Rate |
| --- | --- |
| ftpd upload of a 4.06 MB `.3dsx` to the SD card | about 145 KB/s |
| Development connection, screenshot of both screens (518 KB) | about 250 KB/s (2.1 s) |

Both include work beside the carrier (SD writes, the capture), so they are
not the carrier's limit; they run at a fifth to a third of §13.1.

### 13.4 What this page takes from them

| Number | Used in |
| --- | --- |
| Flat throughput from 1 KiB to 32 KiB; 20 ms of wire time for 16 KiB at 800 KB/s | the 16 KiB payload limit on TCP (§4.4), the one-chunk wait (§8.1) |
| The 660 ms stall of a 64 KiB write | the 32 KiB ceiling (§4.4) |
| 8 ms round trip, 800 KB/s | the windows of §5.6 |
| 100 ms stalls | the keepalive check (§4.6), the timers of §2.4 |
| Microseconds per scan in C | JSON control messages stay (§6.0) |
| Guest parse times against a 5 ms worker turn | LINK_APP_MSG and the aim of 2 KiB (§7.2); the hand-over of 4 messages or 8 KiB of JSON a frame (§7.3) |
| 52 ms of JavaScript against 0.083 ms of C for 32 KiB; one segment per `recv` | the endpoint in C, whole messages to the guest (§7.3) |

### 13.5 Values to calibrate on a device

These values were chosen by arithmetic or kept from version 1; none was
tuned against a running client. An implementation measures each and changes
it in this page with its number.

| Value | Set at | What to measure |
| --- | --- | --- |
| The applet stream window and the per-frame hand-over | **16 KiB** per stream, **16 KiB** of stream bytes a frame (§5.6, §7.3) | throughput of one stream and of four read together, against the estimate of about 490 KB/s shared; whether regranting within a turn lifts it; the 112 KiB a channel can hold against the memory of an Old 3DS |
| The event window and its unit | **48** units from the device, **256** from Hub, **512 bytes** a unit (§5.6) | the largest burst a stall releases for a real daemon; device memory held |
| Daemon requests waiting for the guest | **8 KiB** of JSON per channel (§7.6) | how often two requests back to back meet `busy` (two of 5 KiB do) |
| The `PING` wait before a replacement counts | **2 s** (§2.4) | the longest `PONG` delay of a live device under load, against the 100 ms stall |
| Replacements before the duplicate-id refusal | **3 in 30 s** (§2.4) | reconnect rates of one console at the edge of its range |
| The catalog snapshot's life | **30 s** (§6.4) | the time a device takes to page a full catalog at the 1 KiB floor |
| The 30 s request stall and stream limit against a guest at a breakpoint | **30 s** (§5.5) | whether a paused guest's open requests should outlive the pause |
| Every limit that rests on guest speed | LINK_APP_MSG **8 KiB**, the hand-over of **4 messages or 8 KiB** a frame, **16 KiB** of stream bytes a frame (§7.3) | the same parse and copy times on an **Old 3DS**, which this section does not hold |

