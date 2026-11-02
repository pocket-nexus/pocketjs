// platforms/sim/pack.ts — the pack module (contracts/spec/pack.ts) over a
// local directory for the headless sim host and bun tests.
//
// `pendingOpens` reproduces the browser's open() shape: the first N calls per
// path return PACK_OPEN_PENDING, so a guest's retry path runs under test
// without a network. Inject via bootWorld's extraGlobals: { pack: host.ns }.

import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { resolve } from "node:path";
import {
  PACK_MAX_HANDLES,
  PACK_MAX_IMG_BYTES,
  PACK_OPEN_MISSING,
  PACK_OPEN_PENDING,
  packValidPath,
  type PackOps,
} from "../../contracts/spec/pack.ts";

export interface SimPackOptions {
  /** The game data root: a directory on the host. */
  root: string;
  /** Receiver of loadImg's bytes. Without it loadImg returns -1. */
  ops?: { uploadImgEntry?(blob: Uint8Array): number } | null;
  /** open() returns PACK_OPEN_PENDING this many times per path first. */
  pendingOpens?: number;
}

export interface SimPackHost {
  /** The `globalThis.pack` namespace (one method per PACK_OP). */
  ns: PackOps & { stats(): string };
  /** Every op call in order (for trace assertions). */
  log: string[];
  /** Handles currently open. */
  openCount(): number;
  /** Close every handle (end of scenario). */
  dispose(): void;
}

export function createSimPackHost(options: SimPackOptions): SimPackHost {
  const root = resolve(options.root);
  const pendingOpens = options.pendingOpens ?? 0;
  const waits = new Map<string, number>();
  const handles = new Map<number, { fd: number; size: number }>();
  const log: string[] = [];
  let nextHandle = 0;
  const stats = {
    opens: 0, reads: 0, readBytes: 0, loadImgs: 0,
    readUsLast: 0, readUsMax: 0, readUsSum: 0, loadImgUsLast: 0, loadImgUsMax: 0, loadImgUsSum: 0,
    readBufBytes: 0, root: "",
  };

  function readAt(fd: number, offset: number, dst: Uint8Array): number {
    let got = 0;
    while (got < dst.length) {
      const n = readSync(fd, dst, got, dst.length - got, offset + got);
      if (n <= 0) break;
      got += n;
    }
    return got;
  }

  const ns: SimPackHost["ns"] = {
    open(path: string): number {
      log.push(`open ${path}`);
      if (!packValidPath(path)) return PACK_OPEN_MISSING;
      const waited = waits.get(path) ?? 0;
      if (waited < pendingOpens) {
        waits.set(path, waited + 1);
        return PACK_OPEN_PENDING;
      }
      if (handles.size >= PACK_MAX_HANDLES) return PACK_OPEN_MISSING;
      let fd: number;
      try {
        fd = openSync(resolve(root, path), "r");
      } catch {
        return PACK_OPEN_MISSING;
      }
      const stat = fstatSync(fd);
      if (!stat.isFile()) {
        closeSync(fd);
        return PACK_OPEN_MISSING;
      }
      const handle = nextHandle++;
      handles.set(handle, { fd, size: stat.size });
      stats.opens++;
      stats.root = "dir";
      return handle;
    },
    size(handle: number): number {
      return handles.get(handle)?.size ?? -1;
    },
    read(handle: number, offset: number, dst: Uint8Array): number {
      const file = handles.get(handle);
      if (!file || !(offset >= 0)) return -1;
      log.push(`read ${handle} ${offset} ${dst.length}`);
      const n = offset >= file.size ? 0 : readAt(file.fd, offset, dst);
      stats.reads++;
      stats.readBytes += n;
      return n;
    },
    loadImg(handle: number, offset: number, length: number): number {
      const file = handles.get(handle);
      if (!file || !options.ops?.uploadImgEntry) return -1;
      if (!(offset >= 0) || !(length >= 8) || length > PACK_MAX_IMG_BYTES || offset + length > file.size) return -1;
      log.push(`loadImg ${handle} ${offset} ${length}`);
      const blob = new Uint8Array(length);
      if (readAt(file.fd, offset, blob) !== length) return -1;
      stats.loadImgs++;
      return options.ops.uploadImgEntry(blob);
    },
    close(handle: number): void {
      log.push(`close ${handle}`);
      const file = handles.get(handle);
      if (!file) return;
      closeSync(file.fd);
      handles.delete(handle);
    },
    stats(): string {
      return JSON.stringify(stats);
    },
  };

  return {
    ns,
    log,
    openCount: () => handles.size,
    dispose(): void {
      for (const file of handles.values()) closeSync(file.fd);
      handles.clear();
    },
  };
}
