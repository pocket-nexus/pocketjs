// Pocket Link 2 pairing files (docs/POCKET-LINK.md §3.1, §3.2, §3.6): the
// two files Hub writes onto a device's storage, the `.last` file the device
// keeps beside a key file, the device's loading of `companions/`, and Hub's
// setup as a plan of storage operations. Pure functions: the caller does the
// reads and writes (ftpd, or the mounted card) and reports their outcomes.

import {
  LINK2_COMPANIONS_DIR,
  LINK2_DEVICE_FILE,
  LINK2_KEY_SUFFIX,
  LINK2_LAST_SUFFIX,
  LINK2_MAX_COMPANIONS,
  LINK2_NEW_SUFFIX,
  LINK2_PORT,
} from "../../../contracts/spec/link2.ts";
import { KEY_RE, isLinkId } from "./protocol.ts";

// ---------------------------------------------------------------------------
// File formats
// ---------------------------------------------------------------------------

export interface CompanionFile {
  key: string;
  name: string;
  address: string;
  port: number;
}
export interface LastFile {
  name: string;
  address: string;
  port: number;
}

const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const oneLine = (text: string) => text.replace(/[\r\n]/g, " ");

export const formatDeviceFile = (id: string) => `${id}\n`;

/** Hub's reading at a setup (§3.2 step 1): 16 lowercase hex digits, with any
 *  trailing run of newline, carriage return and space, which is what the
 *  device's own reader strips (`link.c` `load_device_id`). Hub keeps every
 *  file the device reads as an id: minting a new id for one would cost every
 *  other pairing of the card. Anything else gets a new id. */
export function parseDeviceFile(text: string): string | null {
  const id = text.replace(/[\n\r ]+$/, "");
  return isLinkId(id) ? id : null;
}

export function formatCompanionFile(file: CompanionFile): string {
  return `key=${file.key}\nname=${oneLine(file.name)}\naddress=${file.address}\nport=${file.port}\n`;
}
export function formatLastFile(file: LastFile): string {
  return `name=${oneLine(file.name)}\naddress=${file.address}\nport=${file.port}\n`;
}

function fields(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const at = line.indexOf("=");
    if (at > 0) out.set(line.slice(0, at), line.slice(at + 1));
  }
  return out;
}
function addressOf(map: Map<string, string>): string {
  const value = map.get("address") ?? "";
  return IPV4_RE.test(value) ? value : "";
}
function portOf(map: Map<string, string>): number {
  const value = map.get("port") ?? "";
  if (!/^\d{1,5}$/.test(value)) return 0;
  const port = Number(value);
  return port >= 1 && port <= 65535 ? port : 0;
}

/** The device's reading of a key file, as `link.c` `load_companion` reads it:
 *  lines in any order, a final newline optional, unknown lines skipped. Null
 *  without a `key=` of 64 lowercase hex digits. A missing or bad port reads
 *  as the link's default port. */
export function parseCompanionFile(text: string): CompanionFile | null {
  const map = fields(text);
  const key = map.get("key");
  if (key === undefined || !KEY_RE.test(key)) return null;
  return { key, name: map.get("name") ?? "", address: addressOf(map), port: portOf(map) || LINK2_PORT };
}

/** A `.last` file parses when it holds an IPv4 address and a port. */
export function parseLastFile(text: string): LastFile | null {
  const map = fields(text);
  const address = addressOf(map);
  const port = portOf(map);
  if (address === "" || port === 0) return null;
  return { name: map.get("name") ?? "", address, port };
}

const keyFileId = (name: string) => (name.length === 16 + LINK2_KEY_SUFFIX.length && name.endsWith(LINK2_KEY_SUFFIX) && isLinkId(name.slice(0, 16)) ? name.slice(0, 16) : null);

// ---------------------------------------------------------------------------
// The device: loading companions/
// ---------------------------------------------------------------------------

export interface DirectoryEntry {
  name: string;
  text: string;
}
export interface LoadedCompanion extends CompanionFile {
  id: string;
}

/** The device's load of `companions/` (§3.6): the `.txt` files in directory
 *  order, at most 8, each with its `.last` file's name, address and port in
 *  place of the key file's when that file parses. A ninth loadable key file
 *  is ignored and reported. */
export function loadCompanions(entries: readonly DirectoryEntry[]): { companions: LoadedCompanion[]; error: string | null } {
  const companions: LoadedCompanion[] = [];
  let error: string | null = null;
  for (const entry of entries) {
    const id = keyFileId(entry.name);
    if (id === null) continue;
    const file = parseCompanionFile(entry.text);
    if (file === null) continue;
    if (companions.length === LINK2_MAX_COMPANIONS) {
      error = "more than 8 computers";
      continue;
    }
    const lastEntry = entries.find((other) => other.name === id + LINK2_LAST_SUFFIX);
    const last = lastEntry ? parseLastFile(lastEntry.text) : null;
    companions.push({ id, key: file.key, name: last?.name ?? file.name, address: last?.address ?? file.address, port: last?.port ?? file.port });
  }
  return { companions, error };
}

/** What the device writes at a `ready`: the `.last` text when a value
 *  changed, or null. It never writes the key file. */
export function lastFileUpdate(current: LoadedCompanion, ready: LastFile): string | null {
  if (current.name === ready.name && current.address === ready.address && current.port === ready.port) return null;
  return formatLastFile(ready);
}

// ---------------------------------------------------------------------------
// Hub: the setup (§3.2)
// ---------------------------------------------------------------------------

/** A read's three outcomes, which Hub tells apart. */
export type ReadOutcome = { kind: "failed" } | { kind: "absent" } | { kind: "file"; text: string };

export interface SetupInput {
  hubId: string;
  /** Hub's key for this device before the setup, or null. */
  key: string | null;
  hub: { name: string; port: number };
  /** Over ftpd: the FTP connection's local address. On a mounted card: every
   *  current interface address of Hub, the one to write first. */
  via: { kind: "ftp"; localAddress: string } | { kind: "card"; addresses: readonly string[] };
  device: ReadOutcome;
  /** `companions/` as listed, with each file's text where it could be read. */
  listing: readonly DirectoryEntry[];
  companion: ReadOutcome;
  last: ReadOutcome;
  mintDeviceId: () => string;
  mintKey: () => string;
}

export type StorageOp =
  | { op: "write"; path: string; text: string }
  | { op: "readback"; path: string; text: string }
  | { op: "delete"; path: string }
  | { op: "rename"; from: string; to: string };

export interface SetupPlan {
  outcome:
    | "failed-read"
    | "eight-computers"
    | "kept"
    | "address"
    | "key";
  deviceId: string | null;
  /** In order; the caller stops at the first that fails and reports the setup as failed. */
  ops: StorageOp[];
  /** Hub's key for the device once the plan is stored, before any write:
   *  the minted key when the plan writes one. */
  key: string | null;
  /** The key this plan mints and its final readback confirms, or null. */
  minted: string | null;
  message: string;
}

const companionPath = (hubId: string, suffix: string) => `${LINK2_COMPANIONS_DIR}/${hubId}${suffix}`;

/** Hub's procedure against the device's storage as a plan. The record is
 *  touched only after completed reads: a failed read ends the setup with the
 *  key as it was. A key is minted only when the card holds no key file with
 *  the record's key, so the key it replaces opens nothing; the minted key is
 *  the record's key before the first write. */
export function planSetup(input: SetupInput): SetupPlan {
  const keep = input.key;
  const failed = (message: string): SetupPlan => ({ outcome: "failed-read", deviceId: null, ops: [], key: keep, minted: null, message });
  if (input.device.kind === "failed") return failed("device.txt could not be read");
  if (input.companion.kind === "failed") return failed("the key file could not be read");
  if (input.last.kind === "failed") return failed("the last-address file could not be read");

  const ops: StorageOp[] = [];
  let deviceId = input.device.kind === "file" ? parseDeviceFile(input.device.text) : null;
  if (deviceId === null) {
    deviceId = input.mintDeviceId();
    ops.push({ op: "write", path: LINK2_DEVICE_FILE, text: formatDeviceFile(deviceId) });
  }

  const ownKeyFile = input.hubId + LINK2_KEY_SUFFIX;
  const loadable = input.listing.filter((entry) => keyFileId(entry.name) !== null && parseCompanionFile(entry.text) !== null);
  const ownIsLoadable = loadable.some((entry) => entry.name === ownKeyFile);
  if (loadable.length >= LINK2_MAX_COMPANIONS && !ownIsLoadable) {
    return {
      outcome: "eight-computers",
      deviceId,
      ops: [],
      key: keep,
      minted: null,
      message: "the device already holds 8 computers: remove one on the device, or delete one of its files",
    };
  }
  if (input.listing.some((entry) => entry.name === input.hubId + LINK2_NEW_SUFFIX)) {
    ops.push({ op: "delete", path: companionPath(input.hubId, LINK2_NEW_SUFFIX) });
  }

  const onCard = input.companion.kind === "file" ? parseCompanionFile(input.companion.text) : null;
  const held = onCard !== null && keep !== null && onCard.key === keep;
  const address = input.via.kind === "ftp" ? input.via.localAddress : (input.via.addresses[0] ?? "");

  if (onCard !== null && held) {
    const last = input.last.kind === "file" ? parseLastFile(input.last.text) : null;
    const used = last ?? { name: onCard.name, address: onCard.address, port: onCard.port };
    const own = input.via.kind === "ftp" ? used.address === input.via.localAddress : input.via.addresses.includes(used.address);
    if (own && used.port === input.hub.port) {
      return { outcome: "kept", deviceId, ops, key: keep, minted: null, message: "the pairing is in place" };
    }
    const text = formatLastFile({ name: input.hub.name, address, port: input.hub.port });
    const temporary = companionPath(input.hubId, `${LINK2_LAST_SUFFIX}.tmp`);
    ops.push({ op: "write", path: temporary, text });
    ops.push({ op: "rename", from: temporary, to: companionPath(input.hubId, LINK2_LAST_SUFFIX) });
    ops.push({ op: "readback", path: companionPath(input.hubId, LINK2_LAST_SUFFIX), text });
    return { outcome: "address", deviceId, ops, key: keep, minted: null, message: "the last address was rewritten; the key file is untouched" };
  }

  const minted = input.mintKey();
  const text = formatCompanionFile({ key: minted, name: input.hub.name, address, port: input.hub.port });
  const fresh = companionPath(input.hubId, LINK2_NEW_SUFFIX);
  const final = companionPath(input.hubId, LINK2_KEY_SUFFIX);
  ops.push({ op: "write", path: fresh, text });
  ops.push({ op: "readback", path: fresh, text });
  ops.push({ op: "delete", path: companionPath(input.hubId, LINK2_LAST_SUFFIX) });
  ops.push({ op: "delete", path: final });
  ops.push({ op: "rename", from: fresh, to: final });
  ops.push({ op: "readback", path: final, text });
  ops.push({ op: "readback", path: LINK2_DEVICE_FILE, text: formatDeviceFile(deviceId) });
  return { outcome: "key", deviceId, ops, key: minted, minted, message: "a new key is written" };
}

/** How a plan ended. `completed` is how many of `plan.ops` succeeded. A plan
 *  whose every operation succeeded is done; any other end is reported as
 *  failed ("setup not confirmed"). The record's key is `plan.key` either way:
 *  after a cut the card holds the minted key or no key Hub knows. */
export function settleSetup(plan: SetupPlan, completed: number): { key: string | null; failed: boolean; failedAt: StorageOp | null } {
  if (plan.outcome === "failed-read" || plan.outcome === "eight-computers") return { key: plan.key, failed: true, failedAt: null };
  if (completed >= plan.ops.length) return { key: plan.key, failed: false, failedAt: null };
  return { key: plan.key, failed: true, failedAt: plan.ops[completed] };
}

/** What the card holds after a cut that let `completed` operations of a
 *  key-writing plan through (§3.2, the power-cut table). */
export function cardAfter(before: ReadonlyMap<string, string>, plan: SetupPlan, completed: number): Map<string, string> {
  const card = new Map(before);
  for (const op of plan.ops.slice(0, completed)) {
    if (op.op === "write") card.set(op.path, op.text);
    else if (op.op === "delete") card.delete(op.path);
    else if (op.op === "rename") {
      const text = card.get(op.from);
      card.delete(op.from);
      if (text !== undefined) card.set(op.to, text);
    }
  }
  return card;
}
