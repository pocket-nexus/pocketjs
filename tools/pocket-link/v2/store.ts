// The reference Hub's store on disk (docs/POCKET-LINK.md §3.6): its
// identity and one record per device, for the command line of cli.ts.
//
//   <home>/hub.json            {version, id, name, lastGeneration}
//   <home>/devices/<id>.json   one device record, the link key included
//
// <home> is $POCKETJS_LINK_HOME, else ~/.pocketjs/link. Folders are 0700 and
// files 0600; a file is written to a temporary name beside it and renamed,
// so a reader sees the old file or the new one. Every call reads the disk:
// two processes on one store (a `serve` and a `setup`) see each other's
// writes. The generation counter is one for the whole Hub (§7.4).
//
// A key leaves this module only inside a record handed to the endpoint;
// `describe()` is what a command prints.

import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { LINK2_BEACON_NAME_BYTES } from "../../../contracts/spec/link2.ts";
import type { DeviceRecord, HubStore } from "./hub.ts";
import { isLinkId, newLinkId } from "./protocol.ts";

const VERSION = 1;

interface HubFile {
  version: number;
  id: string;
  name: string;
  lastGeneration: number;
}

/** What a command shows of a device: no key. */
export interface DeviceSummary {
  id: string;
  name: string;
  model: string;
  target: string;
  hostAbi: number;
  lastAddress: string;
  lastSeen: number;
  /** A key is stored for the device. */
  paired: boolean;
  /** The last setup has no matching final readback and no `ready` followed (§3.2). */
  unconfirmed: boolean;
}

/** $POCKETJS_LINK_HOME, else ~/.pocketjs/link. */
export function linkHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.POCKETJS_LINK_HOME ? env.POCKETJS_LINK_HOME : join(homedir(), ".pocketjs", "link");
}

/** A display name cut to the beacon's 40 bytes on a code point, one line. */
export function hubName(text: string): string {
  const line = text.replace(/[\r\n]+/g, " ").trim();
  const encoder = new TextEncoder();
  let out = "";
  let bytes = 0;
  for (const point of line) {
    const size = encoder.encode(point).length;
    if (bytes + size > LINK2_BEACON_NAME_BYTES) break;
    out += point;
    bytes += size;
  }
  return out;
}

const defaultName = () => hubName(hostname().replace(/\.local$/, "")) || "Pocket Link";

function secureDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

/** Writes `text` to `path` with mode 0600 through a temporary file and a rename. */
export function writeSecret(path: string, text: string): void {
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, text, { mode: 0o600, flag: "w" });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

const isRecord = (value: unknown): value is DeviceRecord => {
  const record = value as Partial<DeviceRecord> | null;
  return typeof record === "object" && record !== null && typeof record.id === "string" && isLinkId(record.id) && typeof record.key === "string";
};

export class LinkStore implements HubStore {
  readonly home: string;
  private readonly hubPath: string;
  private readonly devicesDir: string;

  /** Opens the store, making it on first use. `name` names a new store. */
  constructor(home: string = linkHome(), options: { name?: string } = {}) {
    this.home = home;
    this.hubPath = join(home, "hub.json");
    this.devicesDir = join(home, "devices");
    secureDir(home);
    secureDir(this.devicesDir);
    if (!existsSync(this.hubPath)) {
      this.writeHub({ version: VERSION, id: newLinkId(), name: (options.name !== undefined && hubName(options.name)) || defaultName(), lastGeneration: 0 });
    }
    const hub = this.hub();
    if (hub.version !== VERSION) throw new Error(`${this.hubPath} is version ${hub.version}; this tool reads version ${VERSION}`);
  }

  private hub(): HubFile {
    const hub = readJson<HubFile>(this.hubPath);
    if (hub === null || typeof hub.id !== "string" || !isLinkId(hub.id)) throw new Error(`${this.hubPath} is not a Pocket Link store`);
    return { version: hub.version, id: hub.id, name: typeof hub.name === "string" ? hub.name : defaultName(), lastGeneration: Number.isInteger(hub.lastGeneration) ? hub.lastGeneration : 0 };
  }
  private writeHub(hub: HubFile): void {
    writeSecret(this.hubPath, `${JSON.stringify(hub, null, 2)}\n`);
  }
  private devicePath(device: string): string | null {
    return isLinkId(device) ? join(this.devicesDir, `${device}.json`) : null;
  }

  get id(): string {
    return this.hub().id;
  }
  get name(): string {
    return this.hub().name;
  }
  /** Renames this Hub. A device learns the new name at its next `ready`. */
  setName(name: string): void {
    const cut = hubName(name);
    if (cut === "") throw new Error("a Hub name holds at least one character");
    this.writeHub({ ...this.hub(), name: cut });
  }

  get(device: string): DeviceRecord | undefined {
    const path = this.devicePath(device);
    if (path === null) return undefined;
    const record = readJson<DeviceRecord>(path);
    return isRecord(record) && record.id === device ? record : undefined;
  }
  list(): DeviceRecord[] {
    let names: string[];
    try {
      names = readdirSync(this.devicesDir);
    } catch {
      return [];
    }
    const records: DeviceRecord[] = [];
    for (const name of names.sort()) {
      if (!name.endsWith(".json")) continue;
      const record = this.get(name.slice(0, -".json".length));
      if (record !== undefined) records.push(record);
    }
    return records;
  }
  put(record: DeviceRecord): void {
    const path = this.devicePath(record.id);
    if (path === null) throw new Error("a device id is 16 lowercase hex digits");
    writeSecret(path, `${JSON.stringify(record, null, 2)}\n`);
  }
  remove(device: string): void {
    const path = this.devicePath(device);
    if (path !== null) rmSync(path, { force: true });
  }
  /** Stored before the value is returned (§7.4). */
  nextGeneration(): number {
    const hub = this.hub();
    hub.lastGeneration = (hub.lastGeneration + 1) >>> 0;
    this.writeHub(hub);
    return hub.lastGeneration;
  }

  /** The records as a command prints them. */
  describe(): DeviceSummary[] {
    return this.list().map((record) => ({
      id: record.id,
      name: record.name,
      model: record.model,
      target: record.target,
      hostAbi: record.hostAbi,
      lastAddress: record.lastAddress,
      lastSeen: record.lastSeen,
      paired: record.key !== "",
      unconfirmed: record.unconfirmed === true,
    }));
  }
}
