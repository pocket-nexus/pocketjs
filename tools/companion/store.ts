// The companion's persistent state: its identity and the consoles paired with
// it, in one JSON file (0600) under the store directory. Writes go through a
// temp file + rename so a crash never leaves half a key list.

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { KEY_RE, isLinkId, newLinkId } from "./protocol.ts";

export interface PairedConsole {
  id: string;
  name: string;
  model: string;
  /** 64 lowercase hex digits. */
  key: string;
  lastAddress: string;
  /** Unix ms. */
  lastSeen: number;
}

interface StoreFile {
  version: 1;
  id: string;
  /** Owner-chosen apps folder, served next to the CLI's --apps dirs. */
  appsDir?: string;
  consoles: PairedConsole[];
}

/** `$POCKET_COMPANION_HOME`, else ~/Library/Application Support/Pocket Companion. */
export function defaultStoreDir(): string {
  return process.env.POCKET_COMPANION_HOME || join(homedir(), "Library", "Application Support", "Pocket Companion");
}

/** The Mac's ComputerName (System Settings › General › Sharing), else the host name. */
export function defaultCompanionName(): string {
  if (process.platform === "darwin") {
    const result = spawnSync("scutil", ["--get", "ComputerName"], { encoding: "utf8" });
    const name = result.status === 0 ? result.stdout.trim() : "";
    if (name) return name;
  }
  return hostname().replace(/\.local$/, "");
}

export class CompanionStore {
  readonly dir: string;
  readonly file: string;
  private data: StoreFile;

  constructor(dir = defaultStoreDir()) {
    this.dir = dir;
    this.file = join(dir, "companion.json");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.data = this.load();
  }

  private load(): StoreFile {
    if (existsSync(this.file)) {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as Partial<StoreFile>;
      if (raw.version === 1 && isLinkId(raw.id)) {
        return {
          version: 1,
          id: raw.id,
          appsDir: typeof raw.appsDir === "string" ? raw.appsDir : undefined,
          consoles: (raw.consoles ?? []).filter((c) => isLinkId(c.id) && KEY_RE.test(c.key)),
        };
      }
      throw new Error(`${this.file}: not a Pocket Companion store`);
    }
    const fresh: StoreFile = { version: 1, id: newLinkId(), consoles: [] };
    this.data = fresh;
    this.save();
    return fresh;
  }

  private save() {
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.file);
  }

  get id(): string {
    return this.data.id;
  }

  get appsDir(): string {
    return this.data.appsDir ?? join(this.dir, "apps");
  }

  setAppsDir(path: string) {
    this.data.appsDir = path;
    this.save();
  }

  consoles(): PairedConsole[] {
    return this.data.consoles.map((c) => ({ ...c }));
  }

  console(id: string): PairedConsole | undefined {
    const found = this.data.consoles.find((c) => c.id === id);
    return found ? { ...found } : undefined;
  }

  /** Insert or replace a paired console (re-pairing replaces its key). */
  upsert(entry: PairedConsole) {
    this.data.consoles = [...this.data.consoles.filter((c) => c.id !== entry.id), { ...entry }];
    this.save();
  }

  /** Record a successful connection. */
  touch(id: string, address: string, fields: Partial<Pick<PairedConsole, "name" | "model">> = {}) {
    const entry = this.data.consoles.find((c) => c.id === id);
    if (!entry) return;
    entry.lastAddress = address;
    entry.lastSeen = Date.now();
    if (fields.name) entry.name = fields.name;
    if (fields.model) entry.model = fields.model;
    this.save();
  }

  forget(id: string): boolean {
    const before = this.data.consoles.length;
    this.data.consoles = this.data.consoles.filter((c) => c.id !== id);
    if (this.data.consoles.length === before) return false;
    this.save();
    return true;
  }
}
