// The companion's app offer: every `.pocket` file in the apps directories that
// carries a variant for the asking console's target. Rows are rebuilt when a
// directory changes (fs.watch, plus a periodic stat sweep for directories that
// appear later); files are parsed once per (mtime, size).
//
// A file travels to the console verbatim, so a catalog row's hash is the
// file's own footer (FNV-1a64 over everything before it) and its bytes is the
// file size. The footer is verified once when the file is scanned.

import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, readdirSync, statSync, watch, type FSWatcher } from "node:fs";
import { join, resolve } from "node:path";
import { LINK_CATALOG_MAX_APPS, LINK_INSTALL_MAX_BYTES, type LinkCatalogApp } from "../../contracts/spec/link.ts";
import {
  POCKET_PACKAGE_FOOTER_SIZE,
  POCKET_SECTION,
  decodeIdentity,
  decodePocketPackage,
  findSection,
} from "../../contracts/spec/pocket-package.ts";

/** FNV-1a64 over bytes in 16-bit limbs (no BigInt per byte), as 16 lowercase
 *  hex digits. Same function as fnv1a64() in contracts/spec/pocket-package.ts. */
export function fnv1a64Hex(bytes: Uint8Array): string {
  let h0 = 0x2325;
  let h1 = 0x8422;
  let h2 = 0x9ce4;
  let h3 = 0xcbf2;
  for (let i = 0; i < bytes.length; i++) {
    h0 ^= bytes[i];
    // h * 0x100000001b3 mod 2^64 = h * 0x1b3 + (h << 40)
    const t0 = h0 * 0x1b3;
    const t1 = h1 * 0x1b3 + (t0 >>> 16);
    const t2 = h2 * 0x1b3 + (t1 >>> 16) + (h0 << 8);
    const t3 = h3 * 0x1b3 + (t2 >>> 16) + (h1 << 8);
    h0 = t0 & 0xffff;
    h1 = t1 & 0xffff;
    h2 = t2 & 0xffff;
    h3 = t3 & 0xffff;
  }
  return [h3, h2, h1, h0].map((limb) => limb.toString(16).padStart(4, "0")).join("");
}

/** The footer a package stores, as 16 lowercase hex digits. */
export function storedFooterHex(tail: Uint8Array): string {
  const view = new DataView(tail.buffer, tail.byteOffset + tail.length - 8, 8);
  return view.getBigUint64(0, true).toString(16).padStart(16, "0");
}

interface ScannedVariant {
  target: string;
  output: string;
  id: string;
  title: string;
}

interface ScannedFile {
  path: string;
  mtimeMs: number;
  size: number;
  hash: string;
  version: string;
  summary: string;
  variants: ScannedVariant[];
  error?: string;
}

export interface CatalogEntry extends LinkCatalogApp {
  path: string;
}

function scanFile(path: string, mtimeMs: number, size: number): ScannedFile {
  const base: ScannedFile = { path, mtimeMs, size, hash: "", version: "", summary: "", variants: [] };
  if (size > LINK_INSTALL_MAX_BYTES) return { ...base, error: `larger than ${LINK_INSTALL_MAX_BYTES} bytes` };
  try {
    const bytes = new Uint8Array(readFileSync(path));
    if (bytes.length < POCKET_PACKAGE_FOOTER_SIZE + 16) return { ...base, error: "truncated" };
    const hash = storedFooterHex(bytes);
    if (fnv1a64Hex(bytes.subarray(0, bytes.length - POCKET_PACKAGE_FOOTER_SIZE)) !== hash) {
      return { ...base, error: "footer hash mismatch" };
    }
    const pkg = decodePocketPackage(bytes, { skipHashCheck: true });
    let manifest: Record<string, unknown> = {};
    try {
      manifest = JSON.parse(new TextDecoder().decode(pkg.manifest));
    } catch {}
    const variants: ScannedVariant[] = [];
    for (const variant of pkg.variants) {
      const identityBytes = findSection(variant, POCKET_SECTION.identity);
      if (!identityBytes) continue;
      const identity = decodeIdentity(identityBytes);
      variants.push({ target: variant.target, ...identity });
    }
    const summary = typeof manifest.summary === "string" ? manifest.summary : typeof manifest.description === "string" ? manifest.description : "";
    return {
      ...base,
      hash,
      version: typeof manifest.version === "string" ? manifest.version : "",
      summary: summary.replace(/\s+/g, " ").trim().slice(0, 120),
      variants,
    };
  } catch (error) {
    return { ...base, error: (error as Error).message };
  }
}

export class AppCatalog {
  private dirs: string[];
  private files = new Map<string, ScannedFile>();
  private watchers = new Map<string, FSWatcher>();
  private sweep: ReturnType<typeof setInterval> | undefined;
  private pending: ReturnType<typeof setTimeout> | undefined;
  private signature = "";

  constructor(
    dirs: string[],
    private readonly onChange: () => void = () => {},
    private readonly log: (line: string) => void = () => {},
  ) {
    this.dirs = [...new Set(dirs.map((d) => resolve(d)))];
    this.rescan(false);
  }

  get directories(): string[] {
    return [...this.dirs];
  }

  setDirectories(dirs: string[]) {
    this.dirs = [...new Set(dirs.map((d) => resolve(d)))];
    for (const [dir, watcher] of this.watchers) {
      if (!this.dirs.includes(dir)) {
        watcher.close();
        this.watchers.delete(dir);
      }
    }
    this.rescan(true);
    if (this.sweep) this.watch();
  }

  /** Start watching the directories; `onChange` fires after the offer changes. */
  watch(sweepMs = 5_000) {
    for (const dir of this.dirs) {
      if (this.watchers.has(dir) || !existsSync(dir)) continue;
      try {
        const watcher = watch(dir, () => this.schedule());
        watcher.on("error", () => {
          watcher.close();
          this.watchers.delete(dir);
        });
        this.watchers.set(dir, watcher);
      } catch {}
    }
    if (!this.sweep) {
      this.sweep = setInterval(() => {
        this.rescan(true);
        this.watch(sweepMs);
      }, sweepMs);
      this.sweep.unref?.();
    }
  }

  close() {
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    clearInterval(this.sweep);
    clearTimeout(this.pending);
    this.sweep = undefined;
  }

  private schedule() {
    clearTimeout(this.pending);
    this.pending = setTimeout(() => this.rescan(true), 250);
  }

  /** Re-stat every directory; returns true when the offer changed. */
  rescan(notify = true): boolean {
    const seen = new Set<string>();
    for (const dir of this.dirs) {
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        continue;
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
        if (!stat.isFile()) continue;
        seen.add(path);
        const cached = this.files.get(path);
        if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) continue;
        const scanned = scanFile(path, stat.mtimeMs, stat.size);
        if (scanned.error) this.log(`catalog: skip ${path}: ${scanned.error}`);
        this.files.set(path, scanned);
      }
    }
    for (const path of this.files.keys()) if (!seen.has(path)) this.files.delete(path);
    const signature = JSON.stringify([...this.files.values()].map((f) => [f.path, f.hash, f.size, f.error ?? ""]));
    const changed = signature !== this.signature;
    this.signature = signature;
    if (changed && notify) this.onChange();
    return changed;
  }

  /** Rows for one target: one per app id, the first directory winning and the
   *  newest file winning inside a directory. */
  entries(target: string): CatalogEntry[] {
    const byId = new Map<string, { entry: CatalogEntry; dir: number; mtime: number }>();
    for (const file of this.files.values()) {
      if (file.error) continue;
      const variant = file.variants.find((v) => v.target === target);
      if (!variant) continue;
      const dir = this.dirs.findIndex((d) => file.path.startsWith(`${d}/`));
      const current = byId.get(variant.id);
      if (current && (current.dir < dir || (current.dir === dir && current.mtime >= file.mtimeMs))) continue;
      byId.set(variant.id, {
        dir,
        mtime: file.mtimeMs,
        entry: {
          id: variant.id,
          title: variant.title,
          version: file.version,
          output: variant.output,
          hash: file.hash,
          bytes: file.size,
          summary: file.summary,
          path: file.path,
        },
      });
    }
    return [...byId.values()]
      .map((v) => v.entry)
      .sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id))
      .slice(0, LINK_CATALOG_MAX_APPS);
  }

  apps(target: string): LinkCatalogApp[] {
    return this.entries(target).map(({ path: _path, ...app }) => app);
  }

  find(target: string, id: string): CatalogEntry | undefined {
    return this.entries(target).find((entry) => entry.id === id);
  }
}

/** An open package file for streaming: size and footer read from the open
 *  descriptor, so a file replaced mid-install still streams one consistent
 *  version. */
export class PackageReader {
  readonly size: number;
  readonly hash: string;
  private fd: number;
  private offset = 0;

  constructor(path: string) {
    this.fd = openSync(path, "r");
    try {
      this.size = fstatSync(this.fd).size;
      if (this.size < POCKET_PACKAGE_FOOTER_SIZE || this.size > LINK_INSTALL_MAX_BYTES) throw new Error("package size out of range");
      const tail = new Uint8Array(POCKET_PACKAGE_FOOTER_SIZE);
      readSync(this.fd, tail, 0, tail.length, this.size - POCKET_PACKAGE_FOOTER_SIZE);
      this.hash = storedFooterHex(tail);
    } catch (error) {
      closeSync(this.fd);
      throw error;
    }
  }

  /** The next chunk, or null at the end. */
  next(max: number): Uint8Array | null {
    if (this.offset >= this.size) return null;
    const chunk = new Uint8Array(Math.min(max, this.size - this.offset));
    const read = readSync(this.fd, chunk, 0, chunk.length, this.offset);
    if (read !== chunk.length) throw new Error("package file shrank while streaming");
    this.offset += read;
    return chunk;
  }

  close() {
    if (this.fd >= 0) closeSync(this.fd);
    this.fd = -1;
  }
}
