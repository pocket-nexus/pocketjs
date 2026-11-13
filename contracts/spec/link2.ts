// contracts/spec/link2.ts — Pocket Link, version 2: the wire contract.
//
// The mechanism is docs/POCKET-LINK.md; section numbers below are that
// page's. Version 1 (contracts/spec/link.ts) stays beside this file while the
// C client in engine/host-services speaks it; the two share ports, the beacon
// layout and the id conventions.
//
// All integers are little-endian.

// ---------------------------------------------------------------------------
// §2 Carriers and discovery
// ---------------------------------------------------------------------------

export const LINK2_VERSION = 2;
/** UDP: the device receives Hub's beacons here. */
export const LINK2_BEACON_PORT = 8627;
/** TCP: Hub's listener; ephemeral when taken, and the beacon says which. */
export const LINK2_PORT = 8628;

/** §2.2
 *    off 0   u32     magic       'P','K','L','B'
 *    off 4   u8      version     2
 *    off 5   u8      flags       0 (version 1 used bit 0; a receiver ignores it)
 *    off 6   u16     tcpPort     1..65535
 *    off 8   u8[16]  companion   Hub's id, 16 lowercase hex digits
 *    off 24  u8[40]  name        UTF-8, cut on a code point, NUL-padded */
export const LINK2_BEACON_MAGIC = 0x424c4b50;
export const LINK2_BEACON_BYTES = 64;
export const LINK2_BEACON_NAME_BYTES = 40;
export const LINK2_BEACON_INTERVAL_MS = 1000;
export const LINK2_BROADCAST_REFRESH_MS = 10_000;

/** §2.3, §2.4: the device's timers. */
export const LINK2_SEARCH_DIRECT_MS = 2500;
export const LINK2_CONNECT_TIMEOUT_MS = 4000;
export const LINK2_HANDSHAKE_TIMEOUT_MS = 6000;
export const LINK2_BACKOFF_MIN_MS = 1000;
export const LINK2_BACKOFF_MAX_MS = 8000;
/** After any `refused`, and after the device's own CLOSE `auth` (§3.8). */
export const LINK2_REFUSED_HOLD_MS = 30_000;

/** §2.4: Hub's side. */
export const LINK2_MAX_CONNECTIONS = 32;
/** A replacement counts when the older connection answers Hub's PING in time. */
export const LINK2_REPLACED_PING_MS = 2000;
export const LINK2_REPLACED_COUNT = 3;
export const LINK2_REPLACED_WINDOW_MS = 30_000;

// ---------------------------------------------------------------------------
// §3 Admission
// ---------------------------------------------------------------------------

/** Device and Hub ids: 8 random bytes as 16 lowercase hex digits. */
export const LINK2_ID_HEX = 16;
export const LINK2_KEY_BYTES = 32;
export const LINK2_NONCE_BYTES = 16;
/** Key files a device reads; a ninth is a setup error (§3.6). */
export const LINK2_MAX_COMPANIONS = 8;

/** §3.1: the files on the device, relative to its link directory
 *  (3DS: sdmc:/pocketjs/link). */
export const LINK2_DEVICE_FILE = "device.txt";
export const LINK2_COMPANIONS_DIR = "companions";
export const LINK2_KEY_SUFFIX = ".txt";
/** What the last `ready` gave; written by the device, and by a setup. */
export const LINK2_LAST_SUFFIX = ".last";
/** A setup's write before its readback; the device never loads it. */
export const LINK2_NEW_SUFFIX = ".new";

/** §3.5: HMAC-SHA256 keyed with the raw 32 key bytes over
 *  label \n nD \n nC \n device \n companion. */
export const LINK2_LABEL = {
  companion: "pocket-link/2/companion",
  console: "pocket-link/2/console",
  /** Reserved for a later encrypted version (§3.10). */
  session: "pocket-link/2/session",
  /** §3.11: keyed with the code's digits. Hub's proof, and the mask of the link key. */
  pairCompanion: "pocket-link/2/pair/companion",
  pairKey: "pocket-link/2/pair/key",
  /** §3.11: keyed with the link key the device unmasked. */
  pairConsole: "pocket-link/2/pair/console",
} as const;

/** §3.4 limits, in encoded bytes. */
export const LINK2_NAME_BYTES = 64;
export const LINK2_MODEL_BYTES = 32;
export const LINK2_TARGET_BYTES = 15;
export const LINK2_MAX_FEATURES = 16;
export const LINK2_FEATURE_BYTES = 24;
export const LINK2_REFUSED_MESSAGE_BYTES = 160;

export interface Link2Hello {
  t: "hello";
  device: string;
  companion: string;
  nonce: string;
  name: string;
  model: string;
  target: string;
  hostAbi: number;
  features: string[];
  maxPayload: number;
}
export interface Link2Challenge { t: "challenge"; nonce: string; proof: string }
export interface Link2Auth { t: "auth"; proof: string }
export interface Link2Ready {
  t: "ready";
  name: string;
  features: string[];
  maxPayload: number;
  clock: { utc: number; local: number };
}
export interface Link2Refused { t: "refused"; code: Link2RefusalCode; message: string }
export type Link2HandshakeMessage = Link2Hello | Link2Challenge | Link2Auth | Link2Ready | Link2Refused;

/** §3.8; `declined` answers a `pair` whose request Hub's owner dismissed (§3.11). */
export const LINK2_REFUSAL = ["unknown_device", "bad_proof", "malformed", "busy", "declined"] as const;
export type Link2RefusalCode = (typeof LINK2_REFUSAL)[number];

/** §3.11 Pairing by a code the device shows. The code is decimal digits. */
export const LINK2_PAIR_CODE_DIGITS = 6;
/** How long a device keeps one code, and Hub one request. */
export const LINK2_PAIR_WINDOW_MS = 300_000;
/** Offers whose proof does not verify that a device takes before it drops its code. */
export const LINK2_PAIR_TRIES = 3;
/** How long a Hub whose beacon arrived stays in a pairing device's list. */
export const LINK2_PAIR_SEEN_MS = 3000;
/** Hubs a pairing device lists. */
export const LINK2_PAIR_MAX_SEEN = 8;
/** After `pair.accept` the device waits this long for `pair.done` before it links. */
export const LINK2_PAIR_DONE_MS = 2000;

/** device to Hub, in place of `hello`: the device asks to be paired. */
export interface Link2Pair {
  t: "pair";
  device: string;
  nonce: string;
  name: string;
  model: string;
  target: string;
}
/** Hub to device, once Hub's owner entered the code. `key` is the link key
 *  XOR HMAC(code, pairKey message): 64 hex digits. */
export interface Link2PairOffer { t: "pair.offer"; companion: string; name: string; nonce: string; proof: string; key: string }
export interface Link2PairAccept { t: "pair.accept"; proof: string }
export interface Link2PairDone { t: "pair.done" }
export type Link2PairMessage = Link2Pair | Link2PairOffer | Link2PairAccept | Link2PairDone;

// ---------------------------------------------------------------------------
// §4 Framing
// ---------------------------------------------------------------------------

/** §4.1
 *    off 0  u32  magic     'P','K','L','K'
 *    off 4  u8   highest
 *    off 5  u8   lowest
 *    off 6  u8   selected  device: 0. Hub: the version in use, or 0 for none
 *    off 7  u8   reserved  0 */
export const LINK2_MAGIC = 0x4b4c4b50;
export const LINK2_PREAMBLE_BYTES = 8;

/** §4.2
 *    off 0  u8   type
 *    off 1  u8   flags     per type; bit 7 reserved for encryption
 *    off 2  u16  reserved  0
 *    off 4  u32  length    payload bytes
 *    off 8  u32  id */
export const LINK2_HEADER_BYTES = 12;

/** §4.3 */
export const LINK2_FRAME = {
  ping: 0x01,
  pong: 0x02,
  close: 0x03,
  handshake: 0x04,
  request: 0x10,
  reply: 0x11,
  event: 0x12,
  cancel: 0x13,
  data: 0x20,
  credit: 0x21,
  reset: 0x22,
} as const;
export type Link2FrameType = (typeof LINK2_FRAME)[keyof typeof LINK2_FRAME];

export const LINK2_FLAG = {
  /** REPLY */
  error: 0x01,
  /** DATA */
  end: 0x01,
  /** REQUEST, EVENT: a u32 channel id precedes the JSON object (§7.2). */
  app: 0x02,
  /** REQUEST with APP: the requester's bytes follow on the request id. */
  body: 0x04,
  /** Every type: reserved for encryption (§3.10); undefined in this version. */
  sealed: 0x80,
} as const;

/** §4.4 */
export const LINK2_MAX_HANDSHAKE = 1024;
export const LINK2_PAYLOAD_CEILING = 32_768;
export const LINK2_MIN_PAYLOAD = 1024;
/** What both sides offer on the TCP carrier. */
export const LINK2_TCP_PAYLOAD = 16_384;
export const LINK2_PING_BYTES = 4;
export const LINK2_CLOSE_REASON_BYTES = 120;

/** §4.6 */
export const LINK2_PING_MS = 3000;
export const LINK2_SILENCE_MS = 10_000;
/** §4.8: the sender of CLOSE closes its socket this long after, at the latest. */
export const LINK2_CLOSE_DRAIN_MS = 1000;

/** §4.8 */
export const LINK2_CLOSE = {
  going_away: 1,
  protocol: 2,
  too_large: 3,
  silence: 4,
  flow: 5,
  auth: 6,
  replaced: 7,
  forgotten: 8,
  restart: 9,
  /** 10 is version 1's `pairing`; reserved. */
  handshake_timeout: 11,
} as const;
export type Link2CloseName = keyof typeof LINK2_CLOSE;

// ---------------------------------------------------------------------------
// §5 Requests, replies, events and streams
// ---------------------------------------------------------------------------

/** §5.1: the device allocates 1..0x7fffffff, Hub 0x80000001..0xffffffff;
 *  0 and 0x80000000 are in neither range. */
export const LINK2_ID_HUB_BIT = 0x8000_0000;
export const LINK2_ID_DEVICE_MAX = 0x7fff_ffff;

/** §5.2 */
export const LINK2_ERROR = [
  "malformed",
  "unknown_message",
  "unsupported",
  "busy",
  "cancelled",
  "timeout",
  "too_large",
  "not_found",
  "rejected",
  "transfer",
  "storage",
  "no_channel",
  "changed",
  "internal",
] as const;
export type Link2ErrorCode = (typeof LINK2_ERROR)[number];
export const LINK2_ERROR_MESSAGE_BYTES = 240;
export interface Link2ErrorReply { code: string; message: string; [more: string]: unknown }

/** §5.4, §5.5 */
export const LINK2_REQUEST_STALL_MS = 30_000;
export const LINK2_CANCEL_GRACE_MS = 10_000;

/** §5.6 */
export const LINK2_RESET = { cancelled: 1, refused: 2, length: 3, storage: 4, superseded: 5 } as const;
export type Link2ResetName = keyof typeof LINK2_RESET;
/** Outstanding credit of one stream direction; a grant past it closes with `flow`. */
export const LINK2_MAX_CREDIT = 16 * 1024 * 1024;
export const LINK2_WINDOW = {
  /** runtime.push, runtime.native.install, install: at the device. */
  bulk: 64 * 1024,
  /** net.http response body: at the device. */
  http: 8 * 1024,
  /** Any device stream: at Hub. */
  hub: 256 * 1024,
} as const;
/** Each inbound stream of an applet channel, at the device: granted and not
 *  yet received plus held for the guest. Granted whole while a read is
 *  pending, so the bytes of the next reads are in flight while the guest takes
 *  this one's: measured on a New 3DS XL, 32 KiB carries the stream at the
 *  carrier's speed and 16 KiB granted per read at under a third of it
 *  (docs/POCKET-LINK.md §13). */
export const LINK2_APP_STREAM_WINDOW = 32 * 1024;
/** An applet event costs one unit per started LINK2_APP_EVENT_UNIT bytes of JSON. */
export const LINK2_APP_EVENT_UNIT = 512;
export const LINK2_APP_EVENT_WINDOW = 48;
export const LINK2_APP_EVENT_WINDOW_HUB = 256;

// ---------------------------------------------------------------------------
// §6 System messages
// ---------------------------------------------------------------------------

/** §6.1 */
export const LINK2_FEATURES = [
  "runtime",
  "runtime.native",
  "runtime.remove",
  "devtools",
  "catalog",
  "install",
  "net.http",
  "agent",
  "channel",
  "apps",
] as const;
export type Link2Feature = (typeof LINK2_FEATURES)[number];
export const LINK2_FEATURES_INTERVAL_MS = 1000;
export interface Link2FeaturesEvent { t: "features"; features: string[] }

/** §6.2 */
export interface Link2RuntimeApp { id: string; output: string; title: string }
export interface Link2RuntimeStatus {
  phase: string;
  target: string;
  hostAbi: number;
  slot: string;
  address: string;
  generation: number;
  active: string;
  lastGood: string;
  running: string;
  frame: number;
  app: Link2RuntimeApp | null;
}
export const LINK2_APPS_MAX_ROWS = 64;
export const LINK2_APPS_INTERVAL_MS = 1000;
export const LINK2_APP_ID_BYTES = 128;
export const LINK2_APP_OUTPUT_BYTES = 64;
export const LINK2_APP_VERSION_BYTES = 32;
export interface Link2InstalledApp { id: string; output: string; version: string; hash: string; home?: boolean }
export interface Link2RuntimeAppsEvent { t: "runtime.apps"; set: number; at: number; apps: Link2InstalledApp[]; more: boolean }

export const LINK2_PUSH_MAX_BYTES = 24 * 1024 * 1024;
export interface Link2PushRequest { t: "runtime.push"; bytes: number; hash: string }
export interface Link2InstallEvent { t: "runtime.install"; phase: "receiving" | "received" | "staged"; hash: string; generation: number; message: string }
export interface Link2PushReply { phase: "accepted"; hash: string; generation: number; message: string; app: Link2RuntimeApp }

export const LINK2_NATIVE_MIN_BYTES = 32;
export const LINK2_NATIVE_MAX_BYTES = 32 * 1024 * 1024;
export const LINK2_NATIVE_NAME_MIN = 6;
export const LINK2_NATIVE_NAME_MAX = 64;
export interface Link2NativeInstallRequest { t: "runtime.native.install"; name: string; bytes: number; crc32: number; launch: boolean }
export interface Link2NativeEvent { t: "runtime.native"; phase: "receiving"; name: string }
export interface Link2NativeReply { phase: "installed" | "staged" | "launching"; name: string; path: string }
/** Hub sends no state-changing request this long after a `launching` reply (§8.3). */
export const LINK2_LAUNCH_HOLD_MS = 60_000;

export type Link2LaunchRequest = { t: "runtime.launch"; native: string } | { t: "runtime.launch"; app: string };
export type Link2LaunchReply = { phase: "launching"; name: string; path: string } | { phase: "switching"; output: string };

/** Requires the group `runtime.remove`; changes device state (§8.3). `id` is
 *  1 to LINK2_APP_ID_BYTES bytes: a manifest id as a runtime.apps row gives it. */
export interface Link2RemoveRequest { t: "runtime.remove"; id: string }
/** Sent after the applet's slot, its package and its data, is deleted. */
export interface Link2RemoveReply { id: string }
/** `rejected` carries one of these in `reason`; the other errors carry none:
 *  `not_found`, `busy`, `storage`, `malformed`, `unsupported`. */
export const LINK2_REMOVE_REJECTED = ["home", "running"] as const;
export type Link2RemoveRejected = (typeof LINK2_REMOVE_REJECTED)[number];
export interface Link2RemoveRefusal { code: "rejected"; message: string; reason: Link2RemoveRejected }

export interface Link2ScreenshotSurface { name: "top" | "bottom"; width: number; height: number; bytes: number }
export interface Link2ScreenshotEvent { t: "runtime.screenshot"; frame: number; format: "bgr8-rotated"; surfaces: Link2ScreenshotSurface[] }

export const LINK2_LOG_TEXT_BYTES = 1024;
/** The bytes of a log event beside its text; `text` is at most the payload limit minus this. */
export const LINK2_LOG_OVERHEAD = 96;
export interface Link2LogEvent {
  t: "log";
  level: "debug" | "info" | "warn" | "error";
  source: "host" | "guest";
  text: string;
  frame: number;
  dropped?: number;
}

/** §6.3 */
export const LINK2_DEVTOOLS_LINE_OUT = 64 * 1024;
export const LINK2_DEVTOOLS_LINE_IN = 16 * 1024;
export const LINK2_DEVTOOLS_RING = 4 * (LINK2_DEVTOOLS_LINE_IN + 1);

/** §6.4 */
export const LINK2_CATALOG_MAX_APPS = 64;
export const LINK2_CATALOG_TITLE_BYTES = 64;
export const LINK2_CATALOG_SUMMARY_BYTES = 120;
export const LINK2_CATALOG_SNAPSHOT_MS = 30_000;
/** Catalog and install requests open per connection. */
export const LINK2_MAX_CATALOG_REQUESTS = 4;
export const LINK2_INSTALL_MAX_BYTES = 24 * 1024 * 1024;
export interface Link2CatalogApp { id: string; title: string; version: string; summary: string; output: string; hash: string; bytes: number }
export interface Link2CatalogRequest { t: "catalog"; after?: string; rev?: number }
export interface Link2CatalogReply { apps: Link2CatalogApp[]; rev: number; more: boolean }
export interface Link2InstallRequest { t: "install"; app: string }
export interface Link2InstallHead { t: "install.head"; app: string; hash: string; bytes: number }

/** §6.5 */
export const LINK2_HTTP_MIN_PAYLOAD = 12_288;
export const LINK2_HTTP_URL_BYTES = 2048;
export const LINK2_HTTP_HEADERS_BYTES = 8192;
export const LINK2_HTTP_MAX_HEADERS = 32;
export const LINK2_HTTP_MAX_BODY = 64 * 1024;
export const LINK2_HTTP_MAX_RESPONSE = 256 * 1024;
export const LINK2_HTTP_MAX_TIMEOUT_MS = 120_000;
export const LINK2_HTTP_MAX_OPEN = 8;
export interface Link2HttpRequest {
  t: "net.http";
  app: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  timeoutMs?: number;
  maxBytes?: number;
  bytes: number;
}
export interface Link2HttpHead { t: "net.head"; status: number; url: string; headers: Record<string, string>; truncated?: true }

// ---------------------------------------------------------------------------
// §7 Applet channels
// ---------------------------------------------------------------------------

export const LINK2_MAX_CHANNELS = 4;
export const LINK2_CHANNEL_OPEN_MS = 20_000;
export const LINK2_CHANNEL_BUSY_RETRY_MIN_MS = 2000;
export const LINK2_CHANNEL_BUSY_RETRY_MAX_MS = 60_000;
/** After a close that leaves the applet running, at most one reopen in this time. */
export const LINK2_CHANNEL_REOPEN_MS = 1000;
export const LINK2_CHANNEL_REQUESTS = 8;
export const LINK2_CHANNEL_STREAMS = 4;
/** The ceiling of LINK_APP_MSG; the limit in force is min(this, payload limit − 4). */
export const LINK2_APP_MSG_CEILING = 8192;
export const LINK2_APP_CHANNEL_PREFIX = 4;
export const LINK2_APP_NAME_BYTES = 64;
export const LINK2_APP_ERROR_CODE_BYTES = 32;
/** Daemon requests not yet handed to the guest, per channel, as JSON bytes. */
export const LINK2_APP_WAITING_REQUESTS = 8192;
/** Per frame toward the guest: messages, JSON bytes and stream bytes (§7.3). */
export const LINK2_APP_FRAME_MESSAGES = 16;
export const LINK2_APP_FRAME_JSON = 8192;
export const LINK2_APP_FRAME_STREAM = 16 * 1024;
/** Bytes queued from the guest toward the wire, per channel: 16 KiB for each
 *  of its 4 outbound streams. */
export const LINK2_APP_OUTBOUND = 64 * 1024;

export interface Link2ChannelOpen { t: "channel.open"; app: string; hash: string }
export interface Link2ChannelOpenReply { generation: number }
export const LINK2_CHANNEL_OPEN_ERROR = ["no_daemon", "busy", "rejected", "unsupported", "malformed"] as const;
export const LINK2_CHANNEL_CLOSE = ["exit", "reset", "daemon", "policy", "overflow", "feature"] as const;
export type Link2ChannelCloseReason = (typeof LINK2_CHANNEL_CLOSE)[number];
export interface Link2ChannelClose { t: "channel.close"; reason: Link2ChannelCloseReason }

// ---------------------------------------------------------------------------
// §8, §9
// ---------------------------------------------------------------------------

/** Of the device's send buffer, for PING, PONG and CLOSE alone (§8.2). */
export const LINK2_TX_RESERVE = 64;
/** Hub requests open at the device: in all, state-changing, screenshots. */
export const LINK2_HUB_REQUESTS = 8;
export const LINK2_HUB_STATE_REQUESTS = 1;
export const LINK2_HUB_SCREENSHOTS = 1;
