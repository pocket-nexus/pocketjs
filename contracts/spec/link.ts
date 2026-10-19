// Pocket Link spec — the console's system link to a paired companion computer.
//
// A Pocket Link is ONE authenticated TCP connection from a console to a
// companion process on a computer the owner paired by scanning a QR code.
// The console's runtime owns it, not a guest: it survives every app switch,
// and the guest-facing modules that ride it (`globalThis.link`, and the NET
// module on hosts whose HTTP transport is the companion) are host services.
//
// What travels over it:
//
//   net      the NET module's whole-response HTTP (contracts/spec/net.ts). The
//            companion performs the request with its own TLS stack, so a
//            console whose TLS is too old for the modern web still reaches it.
//   catalog  the Pocket apps the companion offers for this console's target.
//   install  one app package, streamed into the console's runtime storage.
//
// Roles. The companion LISTENS (TCP) and BEACONS (UDP broadcast + unicast to
// the last address of every paired console). The console CONNECTS: it holds
// no listening socket for the link, and it accepts a beacon only from a
// companion it has paired with.
//
// Trust. Pairing shares a 32-byte key; every connection proves knowledge of
// it in both directions (HMAC-SHA256 over fresh nonces) before any request.
// Frames after the handshake are not encrypted or MACed: the link assumes the
// owner's LAN, like the dev wire (pocket-runtime-wire.ts) and offload. A
// companion serves net requests only to paired consoles, and refuses
// loopback, link-local and private destinations unless its owner allows them.

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/** UDP port the console listens on for companion beacons. */
export const LINK_BEACON_PORT = 8627;
/** The companion's default TCP listener. A companion that cannot bind it
 *  listens on an ephemeral port; the beacon and the pairing URI carry the
 *  port actually in use. */
export const LINK_PORT = 8628;

// ---------------------------------------------------------------------------
// Beacon (companion -> console, once a second)
// ---------------------------------------------------------------------------
//
//   off 0   u32  magic       'P','K','L','B'
//   off 4   u8   version     LINK_VERSION
//   off 5   u8   flags       bit 0: a pairing window is open
//   off 6   u16  tcpPort     LE
//   off 8   u8[16] companion  the companion id, 16 lowercase hex digits
//   off 24  u8[40] name      UTF-8 display name, NUL-padded
//
// The datagram's SOURCE ADDRESS is the connect target. A console connects to
// a beaconing companion only if it holds a key for that companion id.

export const LINK_BEACON_MAGIC = 0x424c4b50; // 'PKLB' LE
export const LINK_BEACON_BYTES = 64;
export const LINK_BEACON_NAME_BYTES = 40;
export const LINK_BEACON_FLAG_PAIRING = 1;

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------
//
// The console opens TCP and sends an 8-byte preamble:
//
//   off 0  u32  magic    'P','K','L','K'
//   off 4  u8   version  LINK_VERSION
//   off 5  u8[3] reserved (0)
//
// Every later message, both directions, is one frame:
//
//   off 0  u8   type      LINK_FRAME
//   off 1  u8   flags     0
//   off 2  u16  reserved  0
//   off 4  u32  length    payload bytes, LE (<= LINK_MAX_FRAME)
//
//   ping / pong   empty. The console pings every LINK_PING_MS; either side
//                 closes after LINK_SILENCE_MS without a frame.
//   ctrl          one UTF-8 JSON object, no newline (<= LINK_MAX_CTRL).
//   data          u32 LE stream id, then bytes (<= LINK_MAX_DATA). A stream
//                 id is the `id` of the request that opened the stream; a
//                 stream's bytes arrive in order and its length was declared
//                 by the ctrl message that opened it.
//
// Unknown frame types are skipped by length; unknown ctrl `t` values are
// ignored. A frame longer than LINK_MAX_FRAME closes the connection.

export const LINK_MAGIC = 0x4b4c4b50; // 'PKLK' LE
export const LINK_VERSION = 1;
export const LINK_PREAMBLE_BYTES = 8;
export const LINK_HEADER_BYTES = 8;
export const LINK_FRAME = {
  ping: 0x01,
  pong: 0x02,
  ctrl: 0x10,
  data: 0x20,
} as const;
export const LINK_MAX_CTRL = 32 * 1024;
export const LINK_MAX_DATA = 32 * 1024;
export const LINK_MAX_FRAME = LINK_MAX_DATA + 4;
export const LINK_PING_MS = 3_000;
export const LINK_SILENCE_MS = 10_000;
export const LINK_CONNECT_TIMEOUT_MS = 4_000;
export const LINK_HANDSHAKE_TIMEOUT_MS = 6_000;

// ---------------------------------------------------------------------------
// Handshake (ctrl frames, before anything else)
// ---------------------------------------------------------------------------
//
//   console -> {"t":"hello","v":1,"mode":"connect"|"pair",
//               "device":"<id16>","companion":"<id16>","nonce":"<hex32>",
//               "name":"<console name>","model":"<model>","target":"3ds-dev"}
//   companion -> {"t":"challenge","nonce":"<hex32>","proof":"<hex64>"}
//   console -> {"t":"auth","proof":"<hex64>"}
//   companion -> {"t":"ready","name":"<companion name>","features":[...],
//                 "clock":{"utc":<epoch ms>,"local":<epoch ms>}}
//             or {"t":"paired","name":"…","key":"<hex64>","features":[...],"clock":{…}}
//             or {"t":"refused","code":"<LINK_REFUSAL>","message":"…"}
//
// The secret is the pairing key for mode "connect" and the pairing secret
// from the QR code for mode "pair". With nD/nC the nonces as sent (hex):
//
//   challenge.proof = HMAC(secret, "pocket-link/1/companion\n" + nD + "\n" + nC + "\n" + device + "\n" + companion)
//   auth.proof      = HMAC(secret, "pocket-link/1/console\n"   + nD + "\n" + nC + "\n" + device + "\n" + companion)
//
// The console checks challenge.proof before it answers, so a companion that
// does not hold the secret learns nothing. In mode "pair" the companion mints
// a fresh 32-byte link key and sends it masked:
//
//   paired.key = key XOR HMAC(secret, "pocket-link/1/key\n" + nD + "\n" + nC)
//
// A pairing secret is single-use and expires with its pairing window.
//
// `clock` is the companion's wall clock when it sent the message: `utc` and
// the same instant in its local zone (`local - utc` is its UTC offset). A
// console whose own clock is unset or wrong keeps the difference and shows
// the companion's time, also after the link drops.

export const LINK_LABEL = {
  companion: "pocket-link/1/companion",
  console: "pocket-link/1/console",
  key: "pocket-link/1/key",
} as const;
export const LINK_KEY_BYTES = 32;
export const LINK_NONCE_BYTES = 16;
export const LINK_ID_HEX = 16;

export const LINK_REFUSAL = {
  /** The companion holds no key for this console (it was forgotten). */
  unknownDevice: "unknown_device",
  /** The proof did not verify. */
  badProof: "bad_proof",
  /** No pairing window is open, or the secret expired or was used. */
  pairingClosed: "pairing_closed",
  version: "version",
} as const;

/** Features a companion may list in ready/paired. */
export const LINK_FEATURE = {
  net: "net",
  catalog: "catalog",
  install: "install",
} as const;

// ---------------------------------------------------------------------------
// Pairing URI (the QR code the companion shows)
// ---------------------------------------------------------------------------
//
//   pocketlink://pair?v=1&c=<companion id16>&h=<ipv4>[,<ipv4>…]&p=<tcp port>
//                    &s=<secret hex32>&n=<percent-encoded companion name>
//
// `h` lists up to LINK_PAIR_MAX_HOSTS addresses; the console tries them in
// order. The URI stays under LINK_PAIR_URI_MAX bytes, so a QR code at ECC
// level M needs at most version 9 (180 bytes); a URI with one address is
// version 7 or 8 (122 / 152 bytes), which a 3DS outer camera reads from a
// laptop screen at arm's length.

export const LINK_PAIR_SCHEME = "pocketlink://pair";
export const LINK_PAIR_SECRET_BYTES = 16;
export const LINK_PAIR_MAX_HOSTS = 3;
export const LINK_PAIR_URI_MAX = 160;
/** How long a companion keeps one pairing window (and its secret) open. */
export const LINK_PAIR_WINDOW_MS = 10 * 60_000;

// ---------------------------------------------------------------------------
// Requests (ctrl frames after ready)
// ---------------------------------------------------------------------------
//
// The console numbers its requests (`id`, u32, never reused within a
// connection). Replies carry the same id. A connection that closes fails
// every request still open on it; nothing is replayed on the next one.
//
// net (the NET module's start/take/cancel/poll ride these):
//   console   {"t":"net","id":n,"app":"<app id>","url":"https://…","method":"GET",
//              "headers":{…},"timeoutMs":30000,"maxBytes":131072,"bytes":k}
//             then k bytes of request body as data frames on stream n
//   companion {"t":"net.head","id":n,"status":200,"url":"<final url>",
//              "headers":{…},"bytes":N}  then N bytes as data frames on n
//          or {"t":"net.error","id":n,"code":"<NET_ERROR>","message":"…"}
//   console   {"t":"net.cancel","id":n}
//
// catalog:
//   console   {"t":"catalog","id":n}
//   companion {"t":"catalog","id":n,"apps":[LinkCatalogApp…]}
//   companion {"t":"catalog.changed"}   unsolicited, after the offer changes
//
// install:
//   console   {"t":"install","id":n,"app":"<app id>"}
//   companion {"t":"install.head","id":n,"app":"…","hash":"<hex16>","bytes":N}
//             then N bytes of the .pocket file as data frames on n
//          or {"t":"install.error","id":n,"message":"…"}
//
// The console writes the stream straight to storage, checks the package
// footer hash against install.head.hash, admits the package for its target
// and ABI, and commits it as the app's active package.

export const LINK_CATALOG_MAX_APPS = 64;
export const LINK_INSTALL_MAX_BYTES = 24 * 1024 * 1024;

export interface LinkCatalogApp {
  /** Manifest id, the install key (e.g. "dev.pocket-nexus.hn"). */
  id: string;
  title: string;
  version: string;
  /** Build output name: the launcher key once installed. */
  output: string;
  /** Package footer hash, 16 lowercase hex digits. */
  hash: string;
  bytes: number;
  /** One line for the store row; may be empty. */
  summary: string;
}

// ---------------------------------------------------------------------------
// Guest namespace (`globalThis.link`, capability "link.companion")
// ---------------------------------------------------------------------------
//
//   status() -> string        JSON LinkStatus, a snapshot taken this call
//   pair(uri) -> bool         start pairing from a scanned URI; false when
//                             the URI does not parse (result via status())
//   forget(companion) -> bool remove a paired companion and its key
//   catalog() -> id | -1      ask the linked companion for its catalog
//   install(appId) -> id | -1 stream one app from the linked companion
//   remove(appId) -> bool     delete an installed app's runtime storage;
//                             refused for the running app and the launcher
//   poll() -> string | undefined
//                             the whole batch of LinkEvent objects visible
//                             this tick, as one JSON array
//
// The SDK (`@pocketjs/framework/link`) polls once per tick only while a
// request is open or a listener is attached.

export const LINK_STATE = {
  /** No companion has been paired. */
  unpaired: "unpaired",
  /** Waiting for a paired companion's beacon (or for WiFi). */
  searching: "searching",
  connecting: "connecting",
  linked: "linked",
} as const;
export type LinkState = (typeof LINK_STATE)[keyof typeof LINK_STATE];

export const LINK_PAIRING = {
  idle: "idle",
  connecting: "connecting",
  paired: "paired",
  failed: "failed",
} as const;
export type LinkPairing = (typeof LINK_PAIRING)[keyof typeof LINK_PAIRING];

export interface LinkCompanion {
  id: string;
  name: string;
  /** Last address the console reached it at, "" if never. */
  address: string;
  port: number;
}

export interface LinkStatus {
  state: LinkState;
  /** The companion the console is linked or connecting to. */
  companion: LinkCompanion | null;
  paired: LinkCompanion[];
  device: { id: string; name: string; model: string; address: string };
  pairing: LinkPairing;
  /** Human-readable reason for the last failed connection or pairing. */
  error: string;
  /** Features the linked companion offered. */
  features: string[];
  /** The companion's clock as of this status read: `utc` epoch ms and its
   *  zone's offset. Null until a companion has linked since boot. */
  clock: { utc: number; offsetMinutes: number } | null;
}

export type LinkEvent =
  | { t: "catalog"; id: number; apps: LinkCatalogApp[] }
  | { t: "catalog.changed" }
  | { t: "install.progress"; id: number; app: string; received: number; bytes: number }
  | { t: "install.done"; id: number; app: string; output: string; hash: string }
  | { t: "error"; id: number; message: string };

/** Pending `catalog`/`install` requests per console. */
export const LINK_MAX_REQUESTS = 4;
