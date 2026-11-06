# Pocket Link 2

Pocket Link is the one system link between a device's runtime and Pocket Hub
on its owner's computer. **The device opens one TCP connection to Hub; system
messages and one lane per running applet share it.** Version 2 replaces
Pocket Link 1 and absorbs the 3DS development connection (TCP 8131,
`products/3ds/src/devserver.c`). It is **not compatible with version 1**:
version 1's wire, the current 3DS firmware and the development connection
stop working against it.

This page is the specification. The wire constants and types move to
`contracts/spec/link.ts`, the reference codec, console client and test vectors
to `tools/pocket-link/` and `tests/vectors/pocket-link-2/`; until those land on
this branch, this page is the only definition. Statements about version 1 and
the development connection cite the code at `becc0e21`.

The first device is the Nintendo 3DS, the Old 3DS included (**64 MB RAM**, a
QuickJS guest, a worker realm with a **512 KiB heap**,
`products/3ds/README.md` "Worker scheduling"). Limits are chosen for it.

## 1. Scope and roles

| Side | Process | Sockets |
| --- | --- | --- |
| Device | the host runtime (3DS: `products/3ds` with `engine/host-services/link.c`) | UDP **8627** for beacons, one outgoing TCP connection. **No listening socket.** |
| Hub | Pocket Hub's Rust core (`pocket-hub`), the Pocket Link endpoint | TCP **8628** listener, UDP beacon sender |

The protocol keeps the role name `companion` for Hub in fields, labels and
URIs, as version 1 does.

### What runs on the link

| Group | Initiator | Content |
| --- | --- | --- |
| Admission | device | beacon, pairing, the handshake (§2, §3) |
| Runtime operations | Hub | status, push a `.pocket`, install a `.3dsx`, launch, screenshot, logs (§6.2) |
| DevTools | both | the DevTools JSON-line protocol of `docs/DEVTOOLS.md` §4, eval included (§6.3) |
| Catalog and install | device | Hub's app offer and a `.pocket` streamed into a slot (§6.4) |
| `net.http` | device | an applet worker's HTTP request, performed by Hub (§6.5) |
| Agent | both | the agent's messages and streams of `contracts/spec/agent.ts`, the glyph atlas included (§6.6) |
| Lanes | device opens | one ordered record channel per running applet; its payload is Pocket Relay's (§7) |

### What does not run on the link

- **Media streams.** A service's `MediaSource` opens a separate TCP
  connection to the media provider (`docs/MEDIA.md` "Transport and
  ownership"); phase one keeps that path.
- **The first install.** A 3DS without the runtime gets it through ftpd or
  through files on the SD card; Hub's core does that outside the link.
- **The lane payload format.** Pocket Relay's records are specified with
  Pocket Relay (PocketJS #437, #456). The link carries them as opaque bytes
  and depends on no Relay detail.
- **Hub's local IPC** to its UI, CLI and daemons.
- **The SVC wire** (`PKNT`, `products/3ds/src/svcwire.c`, `contracts/spec/spec.ts`
  "SVC WIRE protocol"), the PSP USB carrier (`contracts/spec/link.ts` "USB
  carrier") and other carriers. See §11, question 10.

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
| `hello` / `challenge` / `auth` / `ready` / `paired` / `refused`, labels `pocket-link/1/…` | Same messages in `HANDSHAKE` frames, labels `pocket-link/2/…`; `hello` loses `v`, gains `hostAbi` and `features` (§3.4) |
| Refusal `version` | Hub's preamble with `selected` 0 (§4.1) |
| Refusals `unknown_device`, `bad_proof`, `pairing_closed` | Kept; `malformed` and `busy` added (§3.8) |
| `features` in `ready` only | `features` in `hello` and in `ready` (§3.4) |
| `clock` in `ready` / `paired` | Kept |
| `net` with `"stream":true`, `net.head`, `net.credit`, `net.end`, `net.error`, `net.cancel` | `net.http` request, `net.head` event, `CREDIT` frame, `END` flag and reply, error reply, `CANCEL` frame (§6.5) |
| `net` without `stream` (feature `net`, whole response) | Dropped: it serves firmware from before the worker domain (`LINK_FEATURE.net` in `link.ts`) |
| `https://companion.pocket/<service>` answered over `net` | Open: §11, question 5 |
| `catalog`, its reply, `catalog.changed` | `catalog` request and reply, `catalog.changed` event (§6.4) |
| `install`, `install.head`, `install.error` | `install` request, `install.head` event, stream, reply (§6.4) |
| `agent.*` ctrl messages and streams, companion stream ids with bit 31 | Same JSON in `EVENT` frames; every stream credited (§6.6) |
| `<feature>.*` messages of a product extension on Hub | Dropped: product extensions become Relay daemons on Hub |
| Byte credit for `net.stream` only, sent as JSON per block | `CREDIT` frames for every stream and lane (§5.6) |
| USB carrier (PSP) | Not part of Pocket Link 2 (§11, question 10) |
| `globalThis.link` (status, pair, forget, catalog, install, remove, poll) | Kept as the guest API; not a wire matter |

The development connection (`contracts/spec/pocket-runtime-wire.ts`,
`products/3ds/src/devserver.c`, `tools/3ds-runtime-client.ts`,
`tools/3ds-dev.ts`, and Pocket Hub's development bridge):

| Development connection | Version 2 |
| --- | --- |
| The 3DS listens on TCP 8131 | Dropped: the device connects to Hub; `devserver.c` is removed |
| UDP 8131 discovery (`PKRD` request, 64-byte reply) | Dropped: Hub knows its linked devices |
| `PKRT` hello carrying the raw 32-byte key, 24-byte ack | Dropped: the pairing handshake (§3) |
| `sdmc:/pocketjs/runtime/dev.key`, `tools/3ds-keys.ts`, `~/.pocketjs/3ds/keys/` | Retired; the link key from pairing (§3.6) |
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
| `bun run 3ds:dev pair / discover / push / install / launch / probe / dev` | A thin client of Hub's CLI: QR pairing in Hub, Hub's device list, Hub's runtime operations |

## 2. Discovery

### 2.1 Ports

| Port | Owner | Use |
| --- | --- | --- |
| UDP **8627** | device | receives Hub's beacons |
| TCP **8628** | Hub | the link listener. **A Hub that cannot bind 8628 listens on an ephemeral port**; its beacons and pairing URIs carry the port in use (kept from version 1) |

### 2.2 Beacon

Hub sends one **64-byte** datagram **once a second**. The layout is version
1's (`link.ts` "Beacon") with version 2 in byte 4:

```
off 0   u32     magic       'P','K','L','B'  (0x424c4b50 little-endian)
off 4   u8      version     2
off 5   u8      flags       bit 0: a pairing window is open; bits 1-7: 0
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

- The device listens on UDP 8627 while it holds at least one pairing and is
  not linked. While linked it drains the socket **every 30 frames** without
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
  broadcast still link.

### 2.4 Reconnect and backoff

| Event | Device action |
| --- | --- |
| TCP connect not complete in **4 s** | drop, back off |
| Handshake not complete **6 s** after connect | drop, back off. Hub closes an unfinished handshake after the same 6 s |
| Connection lost, `CLOSE` received, protocol error | back off |
| Backoff | **1 s, doubling to 8 s**; beacons are drained and not followed while it runs; a link that reaches `ready` resets it to 1 s |
| `refused` (any code) | hold that Hub for **30 s**: its beacons are ignored and no direct try goes to it |
| `CLOSE` with `restart` sent by the device itself | the process exits; the next start searches at once |

All values are version 1's (`link.c`: `LINK_BACKOFF_MIN_MS`,
`LINK_BACKOFF_MAX_MS`, `LINK_REFUSED_HOLD_MS`, `LINK_CONNECT_TIMEOUT_MS`,
`LINK_HANDSHAKE_TIMEOUT_MS`).

**Hub keeps one link per device.** When a second connection of a device id
reaches `ready`, Hub closes the older one with `CLOSE` `replaced` (kept from
version 1), so a half-open connection left by a Wi-Fi drop does not block the
new one. **Hub accepts at most 32 connections at a time.**

## 3. Admission

Admission is version 1's pairing with version-2 labels. **A QR code gives
the device a one-time secret; an HMAC-SHA256 handshake proves that both ends
hold the same secret; pairing mints a 32-byte link key that every later
connection proves.** Phase one has no encryption (§3.9).

### 3.1 The pairing URI

Hub shows the URI as a QR code (byte mode, error correction level M,
`tools/pocket-link/qr.ts`):

```
pocketlink://pair?v=2&c=<companion id>&h=<ipv4>[,<ipv4>…]&p=<port>&s=<secret>&n=<name>
```

| Field | Content |
| --- | --- |
| `v` | `2`. A device refuses any other value |
| `c` | Hub's id, 16 lowercase hex digits |
| `h` | **1 to 3** non-internal IPv4 addresses, Ethernet and Wi-Fi first, tunnels and VM bridges left out; the device tries them in order |
| `p` | Hub's TCP port |
| `s` | the pairing secret, 32 lowercase hex digits (16 bytes) |
| `n` | Hub's name, percent-encoded (RFC 3986 unreserved characters literal) |

The fields are version 1's (`protocol.ts` `buildPairUri`). **The URI is
shorter than 160 bytes**: Hub shortens the name on a code point boundary to
fit, and the device receives the full name in `paired`. A one-address URI
encodes as QR **version 7 or 8** (122 or 152 bytes at level M), which a 3DS
outer camera reads from a laptop screen at arm's length (`link.ts` "Pairing
URI").

### 3.2 The pairing secret

| Rule | Value |
| --- | --- |
| Size | **16 random bytes** |
| Lifetime | the pairing window, **10 minutes** from opening |
| Use | **single**: a successful `paired` closes the window |
| Failures | **5** failed console proofs close the window |
| Windows | one per Hub; opening a window replaces the previous one and its secret |

All kept from version 1. The beacon's flag bit 0 shows an open window.

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
  | <------- HANDSHAKE ready | paired      |   or refused
  |   link up: §5 frames in both ways      |
```

Before `ready` or `paired`, only `HANDSHAKE`, `PING`, `PONG` and `CLOSE` are
valid; any other frame type closes the connection with `protocol`.
`HANDSHAKE` frames carry id 0 and one JSON object of at most **4 KiB**.

### 3.4 Handshake messages

**hello** (device to Hub):

| Field | Type | Limit | Content |
| --- | --- | --- | --- |
| `t` | string | | `"hello"` |
| `mode` | string | | `"connect"` (a paired device) or `"pair"` (from a scanned URI) |
| `device` | string | 16 hex | the device id (§3.6) |
| `companion` | string | 16 hex | the Hub id the device means: its pairing's id, or the URI's `c` |
| `nonce` | string | 32 hex | nD: 16 random bytes, fresh per connection |
| `name` | string | 64 bytes | the device's display name (3DS: the CFG user name) |
| `model` | string | 32 bytes | e.g. `"New Nintendo 3DS XL"` |
| `target` | string | 15 bytes | the build target, e.g. `"3ds-dev"`; Hub's catalog filters on it |
| `hostAbi` | integer | u32 | the runtime's host ABI (`POCKETJS_HOST_ABI`), which a pushed package must match |
| `features` | string[] | 16 entries of 24 bytes | the groups the device serves or uses (§6.1) |

Version 1's `v` field is dropped: the preamble carries the version.
`hostAbi` and `features` replace the development connection's ack fields
(`pocket-runtime-wire.ts` `decodePocketRuntimeAck`).

**challenge** (Hub to device): `{"t":"challenge","nonce":<nC, 32 hex>,"proof":<64 hex>}`.

**auth** (device to Hub): `{"t":"auth","proof":<64 hex>}`.

**ready** (Hub to device, mode `connect`):

| Field | Type | Content |
| --- | --- | --- |
| `t` | string | `"ready"` |
| `name` | string | Hub's full display name (≤ 64 bytes) |
| `features` | string[] | the groups Hub serves (§6.1) |
| `clock` | object | `{"utc": <epoch ms>, "local": <epoch ms>}`: Hub's wall clock at sending, and the same instant in its zone (`local - utc` is its UTC offset). Kept from version 1 (`link.ts` "Handshake"): a device whose clock is unset shows Hub's time, also after the link drops |

**paired** (Hub to device, mode `pair`): the fields of `ready` and `key`, the
new link key masked (§3.5), 64 hex digits.

**refused** (Hub to device, in place of `challenge` or of `ready`/`paired`):
`{"t":"refused","code":<§3.8>,"message":<text ≤ 160 bytes>}`. Hub closes the
connection after writing it.

### 3.5 HMAC inputs

The HMAC is **HMAC-SHA256**. **Its key is the raw bytes of the secret**: the
32-byte link key in mode `connect`, the 16-byte pairing secret in mode
`pair`. Its message is the UTF-8 string built from the label, the nonces as
sent (32 lowercase hex digits each) and the ids as sent (16 lowercase hex
digits each), joined by `\n` (0x0A), with no trailing newline:

```
challenge.proof = HMAC(secret, "pocket-link/2/companion" \n nD \n nC \n device \n companion)
auth.proof      = HMAC(secret, "pocket-link/2/console"   \n nD \n nC \n device \n companion)
mask            = HMAC(secret, "pocket-link/2/key"       \n nD \n nC)
paired.key      = linkKey XOR mask          (32 bytes, sent as 64 lowercase hex digits)
```

| Label | Use |
| --- | --- |
| `pocket-link/2/companion` | Hub's proof |
| `pocket-link/2/console` | the device's proof |
| `pocket-link/2/key` | the mask of the minted link key |
| `pocket-link/2/session` | **reserved** for the session key of a later encrypted version (§3.10); unused in phase one |

The string format, the raw-byte key and the hex conventions are version 1's
(`protocol.ts` `proofMessage`, `maskKey`, `linkHmac`); only the labels
change. Proofs travel as 64 lowercase hex digits; **both sides compare them
in constant time** (`protocol.ts` `proofEquals`, `link.c`
`constant_time_equal`). **The device checks `challenge.proof` before it sends
`auth`**, so a Hub without the secret learns no proof it can replay.

In mode `pair`, Hub mints the link key after the console proof verifies and
consumes the window in the same step; a window that expired or was used
between `hello` and `auth` gets `refused` `pairing_closed`.

### 3.6 What each side stores

| Side | Record | Content |
| --- | --- | --- |
| Device | `device.txt` (3DS: `sdmc:/pocketjs/link/device.txt`) | the device id: 8 random bytes as 16 lowercase hex digits, made at first start |
| Device | `companions/<companion id>.txt`, at most 8 | `key=` (64 hex), `name=`, `address=` (last IPv4), `port=`. A ninth pairing removes the oldest |
| Hub | its id | 8 random bytes as 16 lowercase hex digits, made once |
| Hub | one record per paired device, in a file of mode **0600** | `id`, `name`, `model`, `key` (64 hex), `target`, `hostAbi`, `lastAddress`, `lastSeen`, `lastGeneration` (§7.3) |

The device records are version 1's (`link.c` `save_companion`,
`load_device_id`). **No key appears in a log line, a status answer or the
IPC**.
Forgetting a device deletes Hub's record and closes its connection with
`CLOSE` `forgotten`; the device's next `connect` gets `refused`
`unknown_device`.

### 3.7 Connect of a paired device

Mode `connect` uses the same four messages with the link key as the secret.
Hub looks up `hello.device`; if `hello.companion` is not Hub's own id or it
holds no key, it answers `refused` `unknown_device` without a challenge. On
`ready`, both sides update the stored address, port and name.

### 3.8 Refusals

| Code | Sent instead of | When |
| --- | --- | --- |
| `unknown_device` | `challenge` | Hub holds no key for `device`, or `companion` names another Hub |
| `pairing_closed` | `challenge` or `paired` | no window is open, it expired, or its secret was used |
| `bad_proof` | `ready` / `paired` | `auth.proof` does not verify. In mode `pair` it counts toward the 5 failures |
| `malformed` | `challenge` | a field is missing, has the wrong type or breaks its limit. Version 1 closed without a code |
| `busy` | `challenge` | Hub is at its connection limit |

**The device treats every refusal as an answer**: it closes, holds that Hub
for 30 s (§2.4), and in mode `pair` ends the pairing without trying the next
address, since every address reaches the same Hub with the same secret
(`link.c` `handle_challenge`). A version mismatch is not a refusal; it is
answered in the preamble (§4.1).

When `challenge.proof` does not verify, the device sends `CLOSE` `auth` and
closes; a pairing fails with "the companion did not prove the pairing
secret".

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
- every lane record.

It does not learn the link key: the key never travels except masked with an
HMAC of the pairing secret, and the proofs are HMACs over fresh nonces. A
person who also saw the QR code (the secret) and recorded the pairing can
unmask the key.

An **active** attacker (ARP spoofing, a hostile access point) can, after a
real handshake has passed:

- take over the connection and send any frame to the device as Hub: **push a
  package, write and start a `.3dsx` (native code on the console)**, eval in
  the running applet, read screenshots;
- send any frame to Hub as the device: `net.http` requests on the device's
  behalf (Hub's destination policy still refuses private addresses, §6.5),
  catalog installs, and lanes asserting any applet id;
- relay a fresh handshake between the real device and the real Hub and then
  do the above;
- forge beacons and deny service. A forged Hub cannot pass the device's
  proof check, so it learns nothing and the device refuses it.

It cannot complete a handshake of its own without the key or an open
window's secret. **Compared with the development connection, version 2 sends
no key on the wire**: the development connection's hello carried the 32-byte
key itself (`pocket-runtime-wire.ts` `encodePocketRuntimeHello`, checked by
`dev_protocol.c` `pocket_runtime_verify_hello`), so one observed connection
gave an observer native-code access to the console for good.

### 3.10 Where encryption fits later

A later version can add encryption without a new frame format:

1. `hello` offers ciphers (`"enc": [...]`) and `ready`/`paired` selects one.
2. Both sides derive `sessionKey = HMAC(linkKey, "pocket-link/2/session" \n nD \n nC)`;
   in mode `pair` with the minted key.
3. Every frame after `ready` keeps its 12-byte header in clear as associated
   data, sets flag bit 7 (**0x80, reserved on every frame type now**), and
   carries an AEAD-sealed payload with a 16-byte tag; the nonce is a
   per-direction frame counter. `length` counts the tag, so the wire limit
   becomes LINK_MAX_PAYLOAD + 16.
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
  For a one-version device, the bytes that follow are that version's `hello`;
  for a several-version device, a byte that arrives before Hub's preamble is
  written is a protocol error, and Hub closes without a `CLOSE` frame (no
  frame format is agreed yet).
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
off 8  u32  id        request, stream or lane id (§5.1); 0 where the type says so
off 12 ...  payload
```

**The header is 12 bytes, and every frame carries its id there.** Version 1
put a stream id in the first 4 bytes of a `data` payload and a request id
inside the JSON of a `ctrl` frame (`link.ts` "Connection"), so the device
parsed JSON to route a reply. Version 2 routes every reply, stream chunk,
credit grant and lane record by the header, and 12 bytes keep the payload
4-byte aligned in a 4-byte aligned buffer.

**A receiver closes the connection with `CLOSE` `protocol` when** `reserved`
is not 0, a flag bit is set that the type does not define, `id` breaks the
type's rule, or the payload breaks the type's size rule; with `CLOSE`
`too_large` when `length` exceeds LINK_MAX_PAYLOAD (it does not read the
payload).

### 4.3 Frame types

| Type | Name | `id` | Flags | Payload |
| --- | --- | --- | --- | --- |
| 0x01 | `PING` | 0 | none | 4 bytes, opaque |
| 0x02 | `PONG` | 0 | none | the 4 bytes of the `PING` it answers |
| 0x03 | `CLOSE` | 0 | none | u16 code (§4.8), u16 0, UTF-8 reason of at most 120 bytes |
| 0x04 | `HANDSHAKE` | 0 | none | one JSON object, at most 4 KiB (§3.4) |
| 0x10 | `REQUEST` | the request id, never 0 | none | one JSON object with string `t` |
| 0x11 | `REPLY` | the request id | 0x01 `ERROR` | one JSON object |
| 0x12 | `EVENT` | 0; or the id of a stream this event opens; or the id of an open request or lane it belongs to | none | one JSON object with string `t` |
| 0x13 | `CANCEL` | the request id | none | empty |
| 0x20 | `DATA` | the stream id | 0x01 `END` | 1 to LINK_MAX_PAYLOAD bytes; 0 bytes only with `END` |
| 0x21 | `CREDIT` | a stream or lane id | none | u32 bytes granted, at least 1 |
| 0x22 | `RESET` | the stream id | none | u16 code (§5.6), u16 0 |
| 0x30 | `LANE` | the lane id | 0x02 reserved for record continuation (§11, question 2) | one record, 1 byte to the receiver's `maxRecord` |

A JSON payload is one UTF-8 JSON object with no byte-order mark and no
trailing newline. Integers in it are at most 2^53 − 1; 64-bit hashes travel as
16 lowercase hex digits, as version 1's catalog and the development
connection's records do. **Receivers ignore unknown JSON fields.**

### 4.4 Sizes

| Constant | Value | Why |
| --- | --- | --- |
| LINK_PREAMBLE_BYTES | **8** | version 1's size |
| LINK_HEADER_BYTES | **12** | §4.2 |
| LINK_MAX_PAYLOAD | **32,768** | The device keeps one receive buffer that holds a whole frame of the largest kind (`link.c` `LINK_RX_BYTES`, comment in `pump_rx`); version 1's link already allocates 32 KiB + header there, while the development connection's 64 KiB frame cost `devserver.c` a static 64 KiB receive buffer on top. A 32 KiB chunk also bounds how long one bulk frame holds the write queue ahead of a small message (§8.1). The header costs 12 of 32,780 bytes (0.04 %) |
| LINK_MAX_CTRL | **32,768** | a `REQUEST`, `REPLY` or `EVENT` JSON object fits one frame; the device parses it in place in its receive buffer |
| LINK_MAX_HANDSHAKE | **4,096** | the largest handshake message is `paired`, under 1 KiB |

### 4.5 No fragmentation

**No message spans frames.** A JSON message fits one frame; a byte stream is
cut by its sender at any boundary into `DATA` frames; a lane record is one
`LANE` frame. Content larger than one frame travels as a stream: a DevTools
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
`LINK_USB_SILENCE_MS` comment). **The device queues `PONG` and `PING` in a
reserve of its send buffer that bulk data does not use (§8.2).** The
development connection answered a heartbeat only once its send queue was
empty (`devserver.c` `send_client`), so a `.3dsx` upload held answers off for
most of a minute and its client had to allow 180 s of silence.

### 4.7 Unknown and oversized frames

| Case | Receiver |
| --- | --- |
| Unknown frame type after `ready` | skips `length` bytes (kept from version 1) |
| Any type but `HANDSHAKE`, `PING`, `PONG`, `CLOSE` before `ready` | `CLOSE` `protocol` |
| `length` > LINK_MAX_PAYLOAD | `CLOSE` `too_large`, without reading the payload |
| Undefined flag bit, non-zero `reserved`, bad id, bad payload size | `CLOSE` `protocol` |
| `REQUEST` whose payload is not a JSON object with string `t` | `REPLY` `ERROR` `malformed` |
| `REQUEST` with an unknown `t` | `REPLY` `ERROR` `unknown_message`. Version 1 ignored unknown `t` values (`link.c` `handle_ctrl`), which left the requester waiting for its timeout |
| `EVENT` with an unknown `t`, or unparsable | ignored |
| `REPLY`, `CANCEL`, `DATA`, `CREDIT`, `RESET`, `LANE` for an id the receiver does not hold | ignored (a cancelled or closed id); `DATA` and `LANE` past credit for a held id close with `flow` |

### 4.8 Closing the link

The side that ends the link sends `CLOSE`, stops writing, and closes the
socket once the peer closes or **1 s** later. The receiver of `CLOSE` closes.
**A closed connection fails every open request, stream and lane on both
sides; nothing is replayed on the next connection** (kept from version 1).

| Code | Name | Sent by | When |
| --- | --- | --- | --- |
| 1 | `going_away` | either | the sender stops: the device powers off or sleeps, Hub quits |
| 2 | `protocol` | either | a frame broke a rule of §4 or §5 |
| 3 | `too_large` | either | `length` over the limit |
| 4 | `silence` | either | 10 s without a frame |
| 5 | `flow` | either | `DATA` or `LANE` bytes past credit, or a grant over the cap (§5.6) |
| 6 | `auth` | device | `challenge.proof` did not verify |
| 7 | `replaced` | Hub | a newer connection of the same device reached `ready` |
| 8 | `forgotten` | Hub | the owner forgot the device |
| 9 | `restart` | device | the device exits to start a `.3dsx` (§6.2); it reconnects when the new program runs |
| 10 | `pairing` | device | `link.pair` started a pairing, which replaces this link |
| 11 | `handshake_timeout` | either | 6 s without completing the handshake |

A receiver treats an unknown code as `going_away`.

## 5. Requests, replies, events and streams

### 5.1 Ids

| Range | Allocated by |
| --- | --- |
| `0x00000001`–`0x7fffffff` | the device |
| `0x80000001`–`0xffffffff` (bit 31 set) | Hub |
| `0`, `0x80000000` | never allocated; `0` means "no id" in `PING`, `PONG`, `CLOSE`, `HANDSHAKE` and id-less `EVENT` frames |

The bit-31 rule is version 1's for streams the companion opens
(`contracts/spec/agent.ts` `AGENT_COMPANION_STREAM`), extended to every id Hub allocates.
**Each side allocates request ids, ids of streams it opens by an event, and
lane ids from one counter, and never reuses an id within a connection**, so an
id names at most one thing on a connection and `CREDIT` needs no type field.
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
  Two requests are the exception: the `REPLY` of `devtools.open` (§6.3) and
  of `lane.open` (§7.1) opens a stream or lane that keeps the request's id
  until the connection or the lane ends.
- A responder holds a bounded number of open requests from its peer (§9). One
  over the bound gets `REPLY` `ERROR` `busy` at once.
- Both sides send requests. Hub's requests are the runtime operations; the
  device's are catalog, install, `net.http`, `devtools.open` and `lane.open`.

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
| `internal` | anything else |

`closed` is not sent: it is what a side reports on its own side for requests open
when the connection ends.

### 5.3 Events

An `EVENT` is one message without a reply. Its header id is 0 for a
standalone event (`catalog.changed`, `runtime.status`, `log`, the agent's
messages), the id of an open request for progress, the id of a lane for
`lane.close`, or **a fresh id of the sender when the event opens a stream**
(`agent.screen`, `agent.glyphs`, `agent.audio`, `agent.shot`, an unsolicited
`runtime.screenshot`).

**An `EVENT`'s `t` defines what its header id means**, and a receiver reads
the id by `t`, not by its value:

| Header id | Events | Rule |
| --- | --- | --- |
| 0 | `catalog.changed`, `runtime.status`, `log`, `devtools.listen`, the agent messages that open no stream | the id is 0 |
| an open request's id | `runtime.install`, `runtime.native`, `install.head`, `net.head`, `runtime.screenshot` answering a request | a request the receiver sent and that has no `REPLY` yet |
| a lane's id | `lane.close` | a lane open on the connection |
| a fresh id of the sender | `agent.audio`, `agent.shot`, `agent.screen`, `agent.glyphs`, an unsolicited `runtime.screenshot` | **an id from the sender's own range (§5.1) that the sender has not used on this connection**; the event opens a stream under it |

`runtime.screenshot` is the one event with two kinds: the receiver reads it
as progress when the id is one of its own open `runtime.screenshot`
requests, and as an unsolicited stream otherwise.

What a receiver does with an id that breaks the rule:

- **A stream-opening event whose id is 0, outside the sender's range, or
  already in use on the connection: `CLOSE` `protocol`.** The sender's id
  allocation is broken, and taking the event would mix two streams. This is
  the "bad id" row of §4.7.
- An event of a kind that requires id 0 with another id, or an id of the
  wrong range for a request or lane it names: `CLOSE` `protocol`, for the
  same reason.
- An event naming a request or lane id from the right range that the
  receiver no longer holds (cancelled, replied, closed): **ignored**, as
  §4.7 treats late frames for a released id.
- An event with an unknown `t`: ignored whatever its id; the receiver does
  not track an id it cannot read.

### 5.4 Cancellation

The requester sends `CANCEL` with the request id. The responder stops the
operation, drops what it would still send on the request's stream, and sends
the final `REPLY`: `ERROR` `cancelled`, or its normal reply if it had
finished. The requester discards `EVENT` and `DATA` frames for the id after
`CANCEL` and frees the id at the `REPLY`, or **10 s** after `CANCEL` when no
reply comes. Version 1 had `net.cancel` for HTTP alone and no answer to it
(`link.ts` "Requests").

### 5.5 Timeouts

- **A requester fails a request with `timeout` when 30 s pass without a frame
  for its id** (`EVENT`, `REPLY`, `DATA`, or `CREDIT` for its stream), and
  sends `CANCEL`. Version 1 used the same 30 s for catalog replies and install
  streams (`link.c` `LINK_REQUEST_STALL_MS`).
- A responder that waits on its peer's stream answers `ERROR` `timeout` after
  30 s without a `DATA` frame on it.
- Operations whose result takes longer send progress events (§6.2), which
  reset the requester's timer.

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

**Every stream direction and every lane direction is credited in bytes.**

- **Credit starts at 0.** The receiver grants with `CREDIT` (u32 bytes). It
  may grant before the first byte, in the same write as the message that
  opens the stream.
- The sender sends `DATA` (or `LANE`) payload bytes up to the bytes granted
  and not yet used. **Bytes past credit close the connection with `flow`.**
- A grant that raises the outstanding credit of one direction above
  **16 MiB** closes the connection with `flow`.
- Headers, `EVENT`, `REPLY`, `END` with an empty payload, `RESET`, `CREDIT`,
  `PING`, `PONG` and `CLOSE` take no credit. Control frames are bounded by
  the open-request bounds and their size, not by credit.
- A receiver grants credit when it has written the bytes on (to storage, to
  a guest queue, to a daemon), so credit tracks capacity, not delivery
  (`stream-credit.ts`: "Credit denotes capacity, never delivery").

Recommended windows (bytes outstanding at a time):

| Receiver | Stream | Window | Why |
| --- | --- | --- | --- |
| device | `runtime.push`, `runtime.native.install`, `install` | **64 KiB** | two frames; the device writes at most 64 KiB to storage per pump (`link.c` `LINK_RX_BUDGET`) |
| device | `agent.screen`, `agent.glyphs` | the declared `bytes` | the device holds the whole frame or atlas (`agent.c` `own_pixels`, `glyph_bytes`) |
| device | `net.http` response body | **8 KiB** | `link_http.c` `LINK_HTTP_WINDOW` (8 × 1 KiB worker slots) |
| device | DevTools stream | free bytes in its line ring | §6.3 |
| device | lane | at least its `maxRecord` | §7.4 |
| Hub | any device stream | **256 KiB**, refilled as it consumes | Hub's memory is not the limit |

**Why credit on every stream.** Version 1 credited `net.stream` alone, with a
JSON `net.credit` message per released block (`link_http.c` `control`), and
let installs and agent streams wait on the socket's `drain`. On one TCP connection shared by several streams,
TCP backpressure from one slow consumer (an SD write during an install)
stops every other stream and the pings behind it. With credit, the bytes in
flight on one stream are bounded by its window, and the frames of other
streams and lanes pass. `CREDIT` is a 16-byte binary frame, not JSON.

### 5.7 Ordering

TCP delivers bytes in order, and each side writes frames in the order it
queues them (§8). The guarantees:

1. **Frames one producer queues arrive in that order.** A message queued
   after a stream's `END` arrives after the whole stream. The agent relies on
   this: Hub sends a glyph atlas before the first message that needs it, and
   the device loads the atlas when its stream completes
   (`contracts/spec/agent.ts` "Glyphs").
2. A `REPLY` arrives after every `EVENT` and `DATA` frame of its request.
3. Records of one lane arrive in order, and `lane.close` after the records
   queued before it.
4. Frames of different producers interleave in queue order; a stream's
   chunks do not hold the queue (§8.1). There is no ordering promise between
   independent producers beyond that.

## 6. System messages

### 6.0 How control is encoded

**Control messages are JSON objects in `REQUEST`, `REPLY` and `EVENT`
frames; everything that repeats per chunk or per record is binary in the
frame header.** `DATA`, `CREDIT`, `RESET`, `LANE`, `PING`, `PONG` and `CLOSE`
carry no JSON. The choice weighs three encodings against the device's cost
and against debugging:

| Fact | Source | Bearing |
| --- | --- | --- |
| The device firmware already links a bounded JSON reader and writer, `engine/host-services/jscan.c` (**351 lines**). The reader walks one object's top-level members and returns spans: no tree, no allocation | `jscan.h` | JSON control costs the C client no new code and no heap |
| Version 1's C client reads every control message with it (`json_find_string` on `t`, then the fields) and the build machine tests it | `link.c` `handle_ctrl`, `tests/3ds-link.test.ts` | the parser is exercised and known |
| DevTools lines and agent messages are JSON made and read by guest JavaScript: the shim sends `JSON.stringify` output, the agent's guest API passes JSON through `agent.send` | `framework/src/devtools.ts` `send`, `contracts/spec/agent.ts` "Guest namespace" | a binary encoding would make the C client translate two groups in both directions |
| The development connection's binary begin records (package 12 bytes, `.3dsx` 76, launch 68, screenshot 24) each needed a C parser and a TS encoder, **274 lines** of `dev_protocol.c`, and its answers came back as JSON records anyway (`runtime.install`, `runtime.native`, built with `snprintf`) | `pocket-runtime-wire.ts`, `dev_protocol.c`, `devserver.c` | these messages occur once per operation; binary saved nothing measurable there |
| Version 1's per-block costs were JSON: one `net.credit` object per released HTTP block, and the stream id inside the `data` payload | `link_http.c` `control`, `link.ts` "Connection" | version 2 moves these into the binary header |
| A JSON payload reads as text in a packet capture, in Hub's log and in a test vector | | debugging |
| `json_find` is linear in the object for each key looked up. **Its parse time on an Old 3DS is unmeasured** | `jscan.c` | §11, question 13 |

The options were all-JSON (version 1), all-binary TLV, or the split. The
split keeps JSON where messages are per operation and made or read by guest
code, and binary where cost scales with bytes moved. Conventions: field names
in lower camel case; strings UTF-8 with the stated byte limits; 64-bit hashes
as 16 lowercase hex digits; unknown fields ignored. The tables below list
each message's fields; a field marked `?` may be absent.

### 6.1 Features

`hello.features` lists what the device serves or uses; `ready.features`
lists what Hub serves. **A group is in use only when both lists name it.** A
request of a group the responder does not list gets `ERROR` `unsupported`.

| Feature | Device lists it when | Hub lists it when |
| --- | --- | --- |
| `runtime` | it answers `runtime.status`, `runtime.push`, `runtime.launch` (app), `runtime.screenshot`, `runtime.logs` | always (Hub sends them) |
| `runtime.native` | it installs and starts `.3dsx` files (the development connection's ack flag `NATIVE`) | always |
| `devtools` | the guest's DevTools shim is reachable | it relays DevTools |
| `catalog` | it reads Hub's catalog | it offers one |
| `install` | it installs from Hub | it streams packages |
| `net.http` | it has a worker HTTP provider | it performs requests |
| `agent` | it runs the agent stage | the agent is available |
| `lane` | it opens lanes for applets | it accepts lanes |

### 6.2 Runtime operations

Hub sends these to a device that lists `runtime`. **`runtime.push`,
`runtime.native.install`, `runtime.launch` and eval change device state and
take Hub's device mutex (§8.3); the others take no lock.** The device also
refuses a second state-changing request while one is open (`busy`): it has one
package staging file and one `.3dsx` staging file (`devserver.c`,
`native.h`).

The runtime state's `generation` in these messages counts package commits
(`PocketRuntimeState`); it is not the lane generation of §7.

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
device's latest screenshot.

#### runtime.logs

Request `{on: boolean}`, reply `{}`. **Logs are off at every new connection.**
While on, the device sends `EVENT` `log` (id 0):

| Field | Type | Content |
| --- | --- | --- |
| `level` | string | `debug`, `info`, `warn`, `error` |
| `source` | string | `host` (the runtime's own lines, today `devserver_report_log`) or `guest` (the applet's `console` and the errors thrown from its frames) |
| `text` | string | at most **1 KiB**, cut on a code point |
| `frame` | integer | the frame counter |
| `dropped` | integer? | log events dropped since the last one sent |

**The device drops a log event when its send buffer has no room outside the
control reserve**, and counts it in the next event's `dropped`. The
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
| `devtools.open` | device → Hub, `REQUEST` `{}` | sent once after `ready` when both list `devtools`. Hub replies `{}`. **The request id is the DevTools stream id for both directions until the connection ends** |
| DevTools stream | both | UTF-8 lines, each ended by `\n`, cut across `DATA` frames at any byte |
| `devtools.listen` | Hub → device, `EVENT` `{on: boolean}` (id 0) | the shim's `listening()` (today `ui.__dbgConnected`) returns `on`. Off at every new connection |

- **Device to Hub lines are at most 64 KiB.** A longer line is replaced by
  `{"t":"ctrlDropped","bytes":<n>,"cap":65536}`, as `devserver_send_ctrl`
  does. The device's first line on a new stream is the shim's last `hello`
  line, cached as `devserver.c` caches it.
- **Hub to device lines are at most 16 KiB**; the device's line ring holds
  **4 × (16 KiB + 1)** bytes (`devserver.c` `CTRL_IN_BYTES`). The device
  grants credit for the free bytes in the ring and hands the shim whole lines
  only (`devserver_recv_ctrl`). A guest switch drops undelivered lines; the
  stream stays.
- **Eval** is the DevTools line `{"t":"eval","id":<string>,"code":<≤ 16 KiB>}`
  and its answer `{"t":"evalResult","id",…}`. Hub writes the line under its
  device mutex and reads the answer from the device's lines; Hub's ids start
  with `hub-`. The shim evaluates between frames in the applet's global scope.
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

**catalog**: request `{}`. Reply `{apps: [LinkCatalogApp]}`: every `.pocket`
in Hub's apps folders with a variant for `hello.target`, at most **64** rows,
one per app id with the first folder winning. A row:

| Field | Type | Content |
| --- | --- | --- |
| `id` | string | manifest id, the install key |
| `title`, `version`, `summary` | string | `summary` may be empty |
| `output` | string | build output name, the launcher key once installed |
| `hash` | string | 16 hex, the file's footer hash (FNV-1a64) |
| `bytes` | integer | file size |

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
| `app` | string | the applet's manifest id, from the runtime |
| `url` | string | `http:` or `https:` |
| `method` | string | `GET HEAD POST PUT PATCH DELETE OPTIONS` (`NET_METHODS`) |
| `headers` | object | string values; at most 32 headers / 8 KiB |
| `timeoutMs` | integer? | at most **120,000**; default 30,000 |
| `maxBytes` | integer? | at most **256 KiB**; default 128 KiB |
| `bytes` | integer | request body length, at most **64 KiB** |

Streams, both on the request id: the request body, device to Hub (Hub grants
credit for `bytes` on receipt); the response body, Hub to device (the device
grants its window, 8 KiB today, in the same write as the request).

`EVENT` `net.head` (id = request id): `{status, url, headers}`; header names
lower case, hop-by-hop headers dropped, `content-encoding` and
`content-length` dropped when the body was decompressed, several
`set-cookie` joined with `\n`; at most 32 headers / 8 KiB.

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
one; it is not request/reply. Every message is at most LINK_MAX_CTRL.

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

## 7. Lanes

**A lane is an ordered, credited channel of whole records between one
running applet on the device and Hub, in both directions.** Hub's endpoint
forwards each record to the lane's local consumer and back without reading
it. **The records' format is Pocket Relay's and is specified with Pocket
Relay, not here; nothing in the link depends on it.** Where the device-side
endpoint runs (the applet's worker realm, its UI realm, or C) is open
(§11, question 1); this section specifies what the link does whichever it is.

### 7.1 Open

When an applet's guest starts and its package declares the lane capability
(its name is set in the PocketJS spec, §11 question 3), the device runtime
sends:

`REQUEST` `lane.open`, **header id = the lane id**:

| Field | Type | Content |
| --- | --- | --- |
| `app` | string, ≤ 128 bytes | the applet's manifest id |
| `hash` | string | 16 hex: the running package's footer hash |
| `maxRecord` | integer | the largest record the device accepts, at most LINK_MAX_PAYLOAD |

**The applet id is the runtime's assertion**: the device takes it from the
package it booted (today `launcher_current_app_id`), never from a value the
guest supplies. Hub cannot check it beyond trusting the authenticated device
runtime (§3.9 for what an attacker can do).

Hub answers:

- `REPLY` `{generation, maxRecord}`: `generation` is a u32 (§7.3);
  `maxRecord` is the largest record Hub accepts (LINK_MAX_PAYLOAD). Hub sends
  its first `CREDIT` for the lane right after.
- `REPLY` `ERROR`: `unsupported` (Hub does not list `lane`), `busy` (the
  connection has LINK_MAX_LANES lanes, or no consumer can start), `malformed`,
  `rejected` (Hub's policy refuses the applet id).

**Neither side sends `LANE` frames for a lane id before the `REPLY`.** The
lane id outlives the `REPLY`: unlike other requests, `lane.open`'s reply
opens the lane rather than ending activity on the id.

### 7.2 Records and flow control

- One record is one `LANE` frame: **1 byte to the receiver's `maxRecord`**.
  Hub's endpoint delivers each frame as one whole record, unmodified, in
  order, at most once.
- Each direction is credited in bytes (§5.6). A record waits until the
  sender's credit covers its whole length. **A receiver grants at least its
  `maxRecord` in total while the lane is open and its consumer keeps up**, so
  a record of the largest size can always be sent.
- **Hub grants the device credit as the lane's local consumer accepts
  records**, so backpressure runs end to end: Hub holds at most one window
  per lane.
- Lanes take no device mutex and are not interpreted by Hub's core. Hub may
  apply a check that the payload specification defines and close the lane
  with `payload` when a record fails it; the link defines no such check.

### 7.3 Generation

`generation` is a **u32 that Hub assigns per device, larger than every
generation before it, across connections and Hub restarts**; Hub stores the last value it gave in
the device's record (`lastGeneration`, §3.6). A generation names one lane's
life to the consumer: **records of a generation are never delivered after
that generation's close**, and a new open always gets a larger number. Hub
assigns it so the device keeps no counter across reboots.

### 7.4 Close

`EVENT` `lane.close`, header id = the lane id, `{reason}`, from either side.
**It ends the lane in both directions at once; no reply.** The receiver
discards `LANE` frames for that id that arrive afterwards. Lane ids are never
reused on a connection, so a late record cannot reach a new lane.

| Reason | Sent by | When |
| --- | --- | --- |
| `exit` | device | the applet exits or is switched away, or a push replaces it; sent before the guest is torn down |
| `reset` | device | the applet's realm is reset; a `lane.open` for the new realm follows |
| `consumer` | Hub | the lane's local consumer ended or failed to start |
| `payload` | either | the receiving endpoint refused a record |
| `policy` | Hub | the owner or Hub's policy ended the lane |

After Hub closes a lane, the device opens a new one for the same applet run
only when its endpoint asks for one, **at most once a second**.

**Connection loss closes every lane, with no `lane.close` and no
resumption.** After the next `ready` the device sends `lane.open` for the
applet that is running, which gets a new generation. Phases:

| Event | Lane |
| --- | --- |
| Applet starts | `lane.open` → generation g |
| Realm reset | `lane.close` `reset`, `lane.open` → g + n |
| Applet exits or is switched, push replaces it | `lane.close` `exit` |
| Link drops and comes back | lane gone; `lane.open` after `ready` → a new generation |
| Hub's consumer stops | `lane.close` `consumer` from Hub |

### 7.5 Limits

| Limit | Value |
| --- | --- |
| Lanes per connection | **4** (LINK_MAX_LANES). A 3DS runs one applet at a time and opens at most one |
| Record size | 1 byte to `maxRecord`, `maxRecord` ≤ LINK_MAX_PAYLOAD (32 KiB) |
| Credit | §5.6; outstanding at most 16 MiB per direction |

### 7.6 What Hub guarantees to the other side of a lane

Toward the lane's local consumer (the applet's daemon behind Hub's IPC):

1. **One new local connection per accepted lane**, labelled with the device
   id (authenticated by the handshake), the applet id (asserted by the device
   runtime), the generation, and the grants Hub derives from them.
2. Records **whole, unmodified, in order, at most once**, in both directions.
3. **One close notice per lane, never two**, with its reason; connection
   loss is one.
4. No record of a closed generation after its close notice.
5. Backpressure: Hub stops granting the device credit while the consumer does
   not read.
6. **No confidentiality and no integrity against an attacker on the LAN in
   phase one** (§3.9).

## 8. Arbitration

### 8.1 Hub's write queue

**Hub writes to a device connection from one FIFO queue.** Frames leave in
the order they were queued; no frame overtakes another. Fairness without
priorities comes from one rule for producers:

- **A stream or lane producer has at most one `DATA` or `LANE` frame in the
  queue at a time**, and only within credit. It queues the next chunk after
  the previous one has been written to the socket.
- Control frames (`REQUEST`, `REPLY`, `EVENT`, `CANCEL`, `CREDIT`, `RESET`,
  `PING`, `PONG`, `CLOSE`) are queued when produced.

So a frame queued now waits behind at most **one chunk of at most 32 KiB per
active stream and lane**, plus the control frames already queued. A 24 MiB
push and a `net.http` reply share the connection chunk by chunk; the push
does not hold the queue for its whole length. Per-producer order (§5.7) holds
because each producer's frames enter the one queue in its own order.

### 8.2 The device's send buffer

The device has one send buffer (version 1: `link.c` `tx_buffer`, 48 KiB) and
the same producer rule: each stream or lane queues one chunk at a time.
**LINK_TX_RESERVE (4 KiB) of the buffer is kept for frames other than `DATA`
and `LANE`**: a chunk is queued only when it leaves the reserve free, so
`PONG`, `PING`, `CREDIT`, `REPLY`, `RESET` and `CLOSE` can always be queued.
`log` events do not use the reserve (§6.2).

### 8.3 The device mutex

The mutex belongs to Hub's endpoint, one per device; it arbitrates Hub's own
clients (its UI, its CLI, `3ds:dev`, the studio relay, the agent).

| Takes the mutex | Takes no lock |
| --- | --- |
| `runtime.push`, `runtime.native.install`, `runtime.launch`, eval (§6.3) | `runtime.status`, `runtime.screenshot`, `runtime.logs`, other DevTools lines, catalog and install (device-initiated), `net.http`, agent, lanes |

- A client takes the mutex before Hub sends the request. **A second client is
  refused at once with `busy` and the holder**: `{client, operation, since}`.
  Hub does not queue it; a client that wants to wait retries. Pocket Hub's
  development bridge answers the same way today.
- **The holder is visible** in Hub's device status and IPC, for the UI.
- Release: at the request's `REPLY`; for `launching`, when the device links
  again or 60 s pass; when the connection closes; when the holder's local
  client goes away (Hub sends `CANCEL` for its open request).
- The device does not see the mutex. It enforces its own single slot for
  state-changing requests (§6.2), which also catches a second Hub process
  that should not exist.

Priorities, in-flight slots per client and quotas are deferred until
contention shows; the queue and the mutex above are phase one.

## 9. Limits and budgets

| Name | Value | Rationale |
| --- | --- | --- |
| Beacon port (UDP) | **8627** | kept from version 1 |
| Link port (TCP) | **8628**, ephemeral when taken | kept; beacons and URIs carry the port in use |
| Beacon size | **64 bytes** | kept layout, version byte 2 |
| Beacon interval | **1 s** | kept; the device's 2.5 s direct try covers a lost beacon |
| Broadcast address list refresh | **10 s** | listing interfaces every second cost a small companion a tenth of a core (Pocket Hub's version 1 endpoint) |
| Direct try after | **2.5 s** without a beacon | kept (`link.c` `LINK_SEARCH_DIRECT_MS`) |
| Backoff | **1 s doubling to 8 s** | kept |
| Refusal hold | **30 s** | kept |
| Connect timeout | **4 s** | kept |
| Handshake timeout | **6 s** | kept |
| Connections held by Hub | **32** | kept from version 1 |
| Pairings per device | **8**, oldest evicted | kept (`LINK_MAX_COMPANIONS`) |
| Pairing secret | **16 bytes**, **10 min**, single use, **5** failures | kept; 128 bits is out of reach for guessing within the window, and the URI stays under 160 bytes |
| Pairing URI | **< 160 bytes**, **≤ 3** hosts | kept: QR version 7–8 at level M, readable by the 3DS camera |
| Link key | **32 bytes** | kept |
| Nonce | **16 bytes** | kept |
| Ids (device, Hub) | **16 hex digits** | kept |
| Preamble | **8 bytes** | §4.1 |
| Frame header | **12 bytes** | §4.2 |
| LINK_MAX_PAYLOAD | **32,768 bytes** | §4.4: one receive buffer of this size on the device; bounds head-of-line delay |
| LINK_MAX_CTRL | **32,768 bytes** | one JSON object per frame |
| LINK_MAX_HANDSHAKE | **4,096 bytes** | handshake messages are under 1 KiB |
| `CLOSE` reason | **120 bytes** | one status line |
| Error `message` | **240 bytes** | |
| Ping interval | **3 s** | kept |
| Silence | **10 s** | kept; covers a measured 5.7 s stall |
| Close drain | **1 s** | `devserver_flush(1000)` before a `.3dsx` start |
| Request stall | **30 s** | kept (`LINK_REQUEST_STALL_MS`) |
| Cancel grace | **10 s** | frees an id when no reply follows `CANCEL` |
| Hub requests open at the device | **8**, of which **1** state-changing and **1** screenshot | the device holds one staging file of each kind and one pair of screenshot buffers |
| Device requests open at Hub | **8** `net.http`, **4** catalog and install, **1** `devtools.open`, **4** lanes | kept from version 1 (`LINK_MAX_REQUESTS` in `link.ts`), §6.3, §7.5 |
| Outstanding credit per stream direction | **16 MiB** | bounds arithmetic and a peer's buffering |
| Device receive window, bulk | **64 KiB** | two frames; `LINK_RX_BUDGET` |
| Device receive window, `net.http` | **8 KiB** | `LINK_HTTP_WINDOW` |
| Hub receive window | **256 KiB** | |
| Device received bytes per pump | **64 KiB** | kept (`LINK_RX_BUDGET`): bounds a frame's link work and SD writes |
| Device receive buffer | **12 + 32,768 bytes** | one whole frame |
| Device send buffer | **12 + 32,768 + 16 KiB** | version 1's size plus the larger header |
| LINK_TX_RESERVE | **4 KiB** of the send buffer | control frames always fit (§8.2) |
| DevTools line ring (in) | **4 × (16 KiB + 1)** | kept (`CTRL_IN_BYTES`) |
| DevTools out buffer | **64 KiB** | holds one maximal line until credit and buffer room let it out |
| DevTools line, device → Hub | **64 KiB** | the development connection's frame limit, which tree dumps need |
| DevTools line, Hub → device | **16 KiB** | kept (`POCKET_RUNTIME_MAX_CTRL_BYTES`) |
| Eval code | **16 KiB** | one Hub → device line |
| `runtime.push` | **1 byte to 24 MiB** | kept |
| `.3dsx` | **32 bytes to 32 MiB**, name **6–64** bytes | kept |
| `install` | **24 MiB**, **64** catalog rows | kept |
| `net.http` | body **64 KiB**, response **256 KiB**, **32 headers / 8 KiB**, timeout **120 s**, **3** redirects | kept (`net.ts`) |
| Log text | **1 KiB** | |
| Agent shot and screen | **153,600 bytes** | 320 × 240 RGB565 |
| Agent atlas | **333,616 bytes** | `GLYPHS_MAX_BYTES` |
| Microphone | **30 s** at **16,360 Hz** s16le | `AGENT_MIC_MAX_MS`, `AGENT_MIC_RATE` |
| Lanes per connection | **4**; 3DS opens **1** | one applet at a time on a 3DS |
| Lane record | **≤ 32 KiB** | one frame, no fragmentation |
| Lane generation | **u32**, larger than every earlier one of the device | §7.3 |

Device memory for the link on a 3DS, against version 1's link (`link.c`:
32 KiB receive, 48 KiB send) plus the development connection (`devserver.c`:
64 KiB receive, 64 KiB line ring, 64 KiB send): **about 32 + 48 + 64 + 64 =
208 KiB of buffers instead of about 272 KiB**, plus the screenshot's linear
buffers while a capture is in flight, as today.

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
| `beacon.json` | beacons with the pairing flag on and off, a 40-byte name, a name cut inside a multi-byte character; refused datagrams: 63 and 65 bytes, wrong magic, version 1, port 0, an uppercase id |
| `pair-uri.json` | URIs with 1 and 3 hosts, a name shortened to fit 160 bytes, percent-encoding; refused URIs: `v=1`, 4 hosts, a hostname, a 31-digit secret, 160 bytes; one URI's QR module matrix |
| `preamble.json` | the device's preamble; Hub selecting 2; Hub answering a range 3–4 with `selected` 0; a version-1 console preamble and Hub's answer; a device with range 2–3 sending its preamble alone, Hub selecting 2, then the device's version-2 `hello`; the same device sending a byte before Hub's preamble and Hub closing |
| `frames.json` | one encoding per frame type and flag; refused headers: non-zero `reserved`, an undefined flag, `length` 32,769, `REQUEST` with id 0, `DATA` of 0 bytes without `END`, `CREDIT` of 0, `PING` of 3 bytes |
| `handshake-connect.json` | a full mode `connect` transcript from fixed ids, key and nonces: each frame's bytes, the two HMAC message strings and both proofs |
| `handshake-pair.json` | a full mode `pair` transcript from a fixed secret and a fixed minted key: proofs, the mask message, the mask and `paired.key` |
| `handshake-refusals.json` | `unknown_device` (no key; another companion id), `pairing_closed`, `bad_proof`, `malformed`, `busy`; the device's `CLOSE` `auth` after a wrong `challenge.proof`; a frame of type `DATA` before `ready` |
| `requests.json` | a request with progress events and a reply; an error reply of each generic code; `unknown_message`; `CANCEL` answered by `cancelled`; `CANCEL` crossing a finished reply; ids with bit 31 |
| `streams.json` | a `runtime.push` of 100,000 bytes under 64 KiB credit with `END`; bytes past credit and the `CLOSE` `flow`; a grant over 16 MiB; `RESET` `refused` of an `agent.glyphs` stream; a stream short of its declared bytes |
| `lane.json` | a lane's life: `lane.open`, the reply with generation 7, credit both ways, records both ways, a record of `maxRecord` bytes, `lane.close` `reset` and the reopen with generation 8, records after `lane.close` discarded, a fifth lane refused with `busy`, a record over `maxRecord` closing with `protocol`, a reconnect and the reopen with a larger generation |
| `keepalive.json` | `PING` / `PONG` echo; a timeline with timestamps where a side closes with `silence` at 10 s, and one where `DATA` alone keeps the link up |
| `messages.json` | one golden JSON per message of §6 (requests, replies, events, errors), with each field at its limit and one past it |

The C client builds a POSIX variant of `link.c` on the build machine and runs
the transcripts against itself; Hub's tests run its endpoint against the
TypeScript console client, as Hub's version 1 tests do with
`console-client.ts`.

## 11. Open questions

Questions marked **(measure)** wait for the Old 3DS measurement of Pocket
Relay's cost (record handling, heap, bundle size, SHA-256 throughput).

1. **Where the lane's device endpoint runs (measure).** A TypeScript Relay
   endpoint in the worker realm needs an estimated 1.1–1.4 MB against the
   worker's 512 KiB heap. Options: the UI realm; the record layer in C with a
   thin guest API; a thinner native channel. The link is the same for all
   three; the choice sets the device's lane window and `maxRecord`.
   *Recommendation:* keep §7 independent of it and decide after the
   measurement.
2. **Lane record size and fragmentation (measure).** Records are one frame,
   at most 32 KiB. If Relay's records must exceed that, `LANE` flag 0x02
   (reserved) would mark a continued record, and the receiver would need a
   reassembly buffer of the record limit. *Recommendation:* 32 KiB and no
   fragmentation, unless the measurement shows records above it.
3. **The lane capability's name**, set in the PocketJS spec and added to the
   applet whitelist. *Recommendation:* `link.lane`, beside `link.companion`.
4. **Lane windows (measure).** The device's grant depends on where its
   endpoint buffers (question 1). *Recommendation:* start at one `maxRecord`
   plus one frame, and raise it only on measured throughput.
5. **`https://companion.pocket/<service>` over `net.http`.** Lanes and
   Relay daemons replace this path, and `net.http` then reaches the
   internet alone; until lanes carry Relay on a 3DS, applets that use
   services lose them if Hub stops answering the origin. Options: keep
   answering it in phase one; drop it with version 2. *Recommendation:* keep
   it until the lane endpoint is decided and the first Relay daemons run;
   removing it is one check in Hub.
6. **Guest log lines.** `runtime.logs` needs the shim's console bridge to
   emit through a host operation regardless of a panel
   (`framework/src/devtools.ts`). Option: leave guest lines inside the
   DevTools stream and have Hub filter `{"t":"log"}` lines, which means
   keeping `listening` on and paying the tree snapshots (§6.3).
   *Recommendation:* add the host operation (for example `ui.__dbgLog`) in
   the same change as the 3DS client.
7. **Pairing without the camera.** The first install writes files through
   ftpd or the SD card; the development connection's `dev.key` went the
   same way. Options: QR pairing only; Hub also writes a pairing
   (`sdmc:/pocketjs/link/companions/<hub id>.txt` and Hub's device record)
   during the first install. Whoever writes the SD card already controls the
   device. *Recommendation:* allow it; it keeps a 3DS without a working
   camera usable.
8. **Pocket3D pack delivery.** `products/3ds/src/packs_delivery.c` takes
   `pocket3d.packs` control lines over the development connection, pumps
   `devserver_poll` while it fetches pieces from a temporary HTTP endpoint on
   the computer, and gives up when `devserver_connected()` turns false
   (`tools/pocket3d-delivery.ts`). `products/3ds` itself does not call it. Options: three Hub-to-device
   requests (`packs.piece`, `packs.manifest`, `packs.prune`) streaming the
   bytes over the link; leave it out of version 2. *Recommendation:* leave it
   out of phase one and carry it as requests when a program that uses it moves
   to version 2.
9. **Other users of version 1's C client.** pocket-m5's M5Stack Tab5 firmware
   compiles `engine/host-services/link.c` (`engine/host-services/README.md`
   "Programs") and sends `companion.pocket` over the whole-response `net`
   mode (`docs/WORKER.md`). *Recommendation:* replace `link.c` in place;
   pocket-m5 pins a PocketJS commit before the change until it moves.
10. **The PSP USB carrier and the SVC wire.** `link.ts` keeps a USB carrier
    for the PSP, and the 3DS also pumps the SVC wire (`PKNT`) every frame,
    a third connection to a computer. Neither is in this version.
    *Recommendation:* leave both as they are in this change; decide when a
    second carrier is designed.
11. **Ports.** Keeping 8627 and 8628 means a version-1 Hub and a version-2
    Hub on one computer collide (the second takes an ephemeral port, its
    beacons say so). *Recommendation:* keep them; there is no migration.
12. **Which Hub a device prefers.** With several paired Hubs answering, the
    first beacon wins. Option: prefer the Hub linked last.
    *Recommendation:* keep the first-beacon rule until an owner with two Macs
    reports a problem.
13. **JSON parse cost on the device (measure).** No measurement of `jscan.c`
    on an Old 3DS exists. *Recommendation:* time the parse of a 64-row catalog
    reply and of an `agent.delta` in the same measurement run; move a message
    to a binary payload only if one takes more than a small part of a frame.
14. **Hub's device mutex: refuse or queue.** §8.3 refuses a second client at
    once. The studio relay pushes in the background and might prefer a short
    queue. *Recommendation:* refuse in phase one; add a bounded wait for one
    client type when contention shows.

## 12. Implementation notes

Three implementations follow this page on the branch that carries it; the
spec, the reference client, the vectors and the 3DS client merge together,
since `tests/3ds-link.test.ts` checks the C client against the TypeScript
contract.

### 12.1 TypeScript reference (this repository)

1. `contracts/spec/link.ts`: version-2 constants (ports, preamble, header,
   frame types, flags, close codes, labels, limits of §9), the message types
   of §6 and §7, the features. The USB carrier's records stay until question
   10 is decided.
2. `tools/pocket-link/protocol.ts`: the version-2 codec. **Reuse** the
   beacon, pairing URI, HMAC and mask functions with the new labels and
   version; replace the frame decoder (12-byte header, the checks of §4.7) and
   add the preamble exchange.
3. `tools/pocket-link/vectors.ts` and `tests/vectors/pocket-link-2/` (§10);
   `tests/pocket-link.test.ts` against them.
4. `tools/pocket-link/console-client.ts`: the device side in TypeScript —
   both handshake modes, credit, requests in both directions, a runtime
   operation responder with fakes, the DevTools stream, lanes — for Hub's
   tests and desktop hosts.
5. `stream-credit.ts`: lift the 1–8,192 byte capacity bound to the windows of
   §5.6. **Kept unchanged:** `fetch.ts` (Hub's Rust endpoint ports its
   policy), `catalog.ts`, `qr.ts`.
6. Retire with the 3DS client: `contracts/spec/pocket-runtime-wire.ts`,
   `tools/3ds-runtime-client.ts`, `tests/3ds-runtime-wire.test.ts`,
   `tools/3ds-keys.ts` and the `3ds:wire` lease. `tools/3ds-dev.ts` becomes
   a client of Hub's CLI.

### 12.2 3DS C client (`engine/host-services`, `products/3ds`)

1. `link_proto.c/h`: version-2 constants, preamble, header read and write,
   beacon, URI, proofs; tested from the vectors in `tests/3ds-link.test.ts`
   first.
2. `link.c`: **reuse** the phase machine (search, direct try, backoff,
   pairing across hosts), the companion files, the install path into slot
   staging, the guest events and `link_status_json`. Replace framing, add the
   preamble exchange, the id counter of §5.1, a table of open requests in both
   directions, per-stream credit, the send-buffer reserve and one-chunk rule
   (§8.2), `CLOSE`, features, and the lane open/close/record path with a small
   interface to the endpoint of question 1.
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

### 12.3 Hub's Rust endpoint (`pocket-hub`, crate `hub-link`)

1. Codec and vectors first: preamble, header, frame types, handshake proofs,
   checked against `tests/vectors/pocket-link-2/` from the submodule.
2. Listener with the ephemeral fallback, beacon sender (targets of §2.2),
   pairing windows and the QR (the matrix vector pins the encoder), the
   handshake, the device store (mode 0600, `lastGeneration`), one link per
   device.
3. Keepalive and silence; the FIFO writer with the one-chunk rule; credit;
   request tables in both directions; `CANCEL`; `CLOSE`.
4. Runtime operations and the device mutex, the PNG composition that
   `combinePocketRuntimeScreens` does today, and the CLI that `3ds:dev`
   calls. This unblocks development on a 3DS.
5. Catalog and install through the `pocket-package` crate, keeping
   `catalog.ts`'s rules (target variants, footer hash, 64 rows, one row per
   id, folder watch, size and hash from the open descriptor).
6. `net.http`: port `fetch.ts`'s destination policy, redirects, limits and
   macOS proxy settings.
7. DevTools relay to panels and CLI; agent messages and streams forwarded to
   the agent daemon; lanes mapped to one local IPC connection per generation.
8. Tests: the endpoint against `console-client.ts` on loopback, and against
   the POSIX build of the C client (Hub's version 1 tests build `link.c` the
   same way, `engine/host-services/README.md`).
