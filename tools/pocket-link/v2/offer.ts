// A Hub's app offer from folders of `.pocket` files (docs/POCKET-LINK.md
// §6.4): one row per package variant, with the target it was built for. The
// endpoint filters the rows by a device's target, keeps the first row of an
// app id, orders them by id and serves the first 64 (`catalogRows`), so the
// order here decides which file wins an id: **the first folder, and the
// newest file inside a folder**.
//
// A file travels to the device verbatim: a row's hash is the file's footer
// (FNV-1a64 over everything before it) and its bytes the file size. The
// footer is checked when the file is scanned, and again when an install
// reads it: a file replaced since its row was made is refused.

import { type FSWatcher, readFileSync, readdirSync, statSync, watch } from "node:fs";
import { join, resolve } from "node:path";
import { LINK2_INSTALL_MAX_BYTES } from "../../../contracts/spec/link2.ts";
import { POCKET_PACKAGE_FOOTER_SIZE, POCKET_SECTION, decodeIdentity, decodePocketPackage, findSection, fnv1a64 } from "../../../contracts/spec/pocket-package.ts";
import type { HubOffer } from "./hub.ts";
import { LinkError } from "./peer.ts";

const hex16 = (value: bigint) => value.toString(16).padStart(16, "0");

/** The footer a package stores and the hash of the bytes before it, as 16 hex digits each. */
export function packageFooter(bytes: Uint8Array): { stored: string; computed: string } | null {
  if (bytes.length < POCKET_PACKAGE_FOOTER_SIZE + 16) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset + bytes.length - POCKET_PACKAGE_FOOTER_SIZE, POCKET_PACKAGE_FOOTER_SIZE);
  return { stored: hex16(view.getBigUint64(0, true)), computed: hex16(fnv1a64(bytes.subarray(0, bytes.length - POCKET_PACKAGE_FOOTER_SIZE))) };
}

interface Scanned {
  path: string;
  dir: number;
  mtimeMs: number;
  size: number;
  rows: HubOffer[];
  error: string | null;
}

function scan(path: string, dir: number, mtimeMs: number, size: number): Scanned {
  const base: Scanned = { path, dir, mtimeMs, size, rows: [], error: null };
  if (size > LINK2_INSTALL_MAX_BYTES) return { ...base, error: `larger than ${LINK2_INSTALL_MAX_BYTES} bytes` };
  try {
    const bytes = new Uint8Array(readFileSync(path));
    const footer = packageFooter(bytes);
    if (footer === null) return { ...base, error: "truncated" };
    if (footer.stored !== footer.computed) return { ...base, error: "footer hash mismatch" };
    const pkg = decodePocketPackage(bytes, { skipHashCheck: true });
    let manifest: Record<string, unknown> = {};
    try {
      manifest = JSON.parse(new TextDecoder().decode(pkg.manifest));
    } catch {}
    const applet = manifest.applet as { summary?: unknown } | undefined;
    const summary = typeof applet?.summary === "string" ? applet.summary : typeof manifest.summary === "string" ? manifest.summary : typeof manifest.description === "string" ? manifest.description : "";
    const version = typeof manifest.version === "string" ? manifest.version : "";
    const read = () => {
      const now = new Uint8Array(readFileSync(path));
      if (packageFooter(now)?.stored !== footer.stored) throw new LinkError("not_found", "the file changed since the offer listed it");
      return now;
    };
    const rows: HubOffer[] = [];
    for (const variant of pkg.variants) {
      const identity = findSection(variant, POCKET_SECTION.identity);
      if (identity === null) continue;
      const { id, title, output } = decodeIdentity(identity);
      rows.push({ id, title, version, summary: summary.replace(/\s+/g, " ").trim(), output, hash: footer.stored, bytes: size, targets: [variant.target], read });
    }
    return { ...base, rows };
  } catch (error) {
    return { ...base, error: (error as Error).message };
  }
}

export class FolderOffer {
  private readonly dirs: string[];
  private readonly files = new Map<string, Scanned>();
  private readonly watchers = new Map<string, FSWatcher>();
  private sweep: ReturnType<typeof setInterval> | null = null;
  private pending: ReturnType<typeof setTimeout> | null = null;
  private signature = "";

  /** `onChange` runs after a rescan found another offer; `log` gets one line per file left out. */
  constructor(dirs: string[], private readonly onChange: () => void = () => {}, private readonly log: (line: string) => void = () => {}) {
    this.dirs = [...new Set(dirs.map((dir) => resolve(dir)))];
    this.rescan(false);
  }

  /** The rows, in the order that lets the first folder and the newest file win an id. */
  offer(): HubOffer[] {
    return [...this.files.values()]
      .filter((file) => file.error === null)
      .sort((a, b) => a.dir - b.dir || b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path))
      .flatMap((file) => file.rows);
  }

  /** Reads the folders again; true when the offer changed. */
  rescan(notify = true): boolean {
    const seen = new Set<string>();
    this.dirs.forEach((dir, index) => {
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        return;
      }
      for (const name of names.sort()) {
        if (!name.endsWith(".pocket") || name.startsWith(".")) continue;
        const path = join(dir, name);
        let stat;
        try {
          stat = statSync(path);
        } catch {
          continue;
        }
        if (!stat.isFile() || seen.has(path)) continue;
        seen.add(path);
        const cached = this.files.get(path);
        if (cached !== undefined && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) continue;
        const scanned = scan(path, index, stat.mtimeMs, stat.size);
        if (scanned.error !== null) this.log(`offer: ${path} is left out: ${scanned.error}`);
        this.files.set(path, scanned);
      }
    });
    for (const path of [...this.files.keys()]) if (!seen.has(path)) this.files.delete(path);
    const signature = JSON.stringify([...this.files.values()].map((file) => [file.path, file.size, file.mtimeMs, file.error, file.rows.map((row) => row.hash)]));
    const changed = signature !== this.signature;
    this.signature = signature;
    if (changed && notify) this.onChange();
    return changed;
  }

  /** Watches the folders, and reads them again every `sweepMs` for a folder that appears later. */
  watch(sweepMs = 5000): void {
    for (const dir of this.dirs) {
      if (this.watchers.has(dir)) continue;
      try {
        const watcher = watch(dir, () => {
          if (this.pending !== null) clearTimeout(this.pending);
          this.pending = setTimeout(() => this.rescan(true), 250);
        });
        watcher.on("error", () => {
          watcher.close();
          this.watchers.delete(dir);
        });
        this.watchers.set(dir, watcher);
      } catch {}
    }
    this.sweep ??= setInterval(() => {
      this.rescan(true);
      this.watch(sweepMs);
    }, sweepMs);
  }

  close(): void {
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    if (this.sweep !== null) clearInterval(this.sweep);
    if (this.pending !== null) clearTimeout(this.pending);
    this.sweep = null;
    this.pending = null;
  }
}
