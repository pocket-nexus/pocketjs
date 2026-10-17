// hosts/sim/fs.ts — the in-memory implementation of the fs module
// (contracts/spec/fs.ts) for the headless sim host.
//
// Storage policy is sim-shaped: the whole tree lives in memory (no disk,
// no cleanup) and persists for the life of the host object, so an app
// reload inside one scenario keeps its files, the way a device keeps its
// flash. The tree is case-sensitive — the deterministic host that catches
// a case-only collision before a case-folding device filesystem hides it.
//
// Inject via bootWorld's extraGlobals: { fs: host.ns }, the way a device
// host mounts the namespace beside `ui`. One host per guest = one app's
// data root, which is the isolation model: a second app gets a second
// host object, and neither vocabulary can name the other's tree.

import {
  FS_BLOB_KEY,
  FS_MAX_DIR_ENTRIES,
  FS_MAX_IO_BYTES,
  FS_MAX_TEXT_BYTES,
  FS_READ_TEXT_TOO_LARGE,
  FS_WRITE_APPEND,
  FS_WRITE_TRUNCATE,
  fsValidPath,
} from "../../contracts/spec/fs.ts";

export interface SimFsHost {
  /** The `globalThis.fs` namespace (one method per FS_OP). */
  ns: Record<string, unknown>;
  /** Every op call in order (for trace assertions). */
  log: string[];
  /** Drop the whole tree (end of scenario). */
  dispose(): void;
}

/** Parent path of a valid path ("" = the root). */
function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

function decodePayload(data: string): Uint8Array | string {
  const parsed = JSON.parse(data) as unknown;
  if (typeof parsed === "string") return new Uint8Array(Buffer.from(parsed, "utf8"));
  if (parsed !== null && typeof parsed === "object") {
    const b64 = (parsed as Record<string, unknown>)[FS_BLOB_KEY];
    if (typeof b64 === "string") return new Uint8Array(Buffer.from(b64, "base64"));
  }
  return "malformed payload: a JSON string or {\"$b\": base64}";
}

export function createSimFsHost(options?: { quotaBytes?: number }): SimFsHost {
  const files = new Map<string, Uint8Array>();
  const dirs = new Set<string>(); // the root "" is implicit
  const log: string[] = [];
  const quota = options?.quotaBytes ?? 0;
  let lastError = "";

  const ok = <T>(value: T): T => {
    lastError = "";
    return value;
  };
  const err = (message: string): 1 => {
    lastError = message;
    return 1;
  };
  const errLine = (message: string): string => {
    lastError = message;
    return JSON.stringify({ error: message });
  };
  const errText = (message: string): string => {
    lastError = message;
    return "";
  };

  const isDir = (path: string): boolean => path === "" || dirs.has(path);

  /** Sorted child names of a directory — Unicode CODE POINT order (= UTF-8
   *  byte order, the spec's order). JS default sort compares UTF-16 code
   *  units, which disagrees for astral-plane names, hence the comparator. */
  function childrenOf(path: string): string[] {
    const prefix = path === "" ? "" : `${path}/`;
    const names = new Set<string>();
    for (const key of [...files.keys(), ...dirs]) {
      if (!key.startsWith(prefix) || key === path) continue;
      const rest = key.slice(prefix.length);
      const slash = rest.indexOf("/");
      names.add(slash < 0 ? rest : rest.slice(0, slash));
    }
    return [...names].sort((a, b) => {
      const as = [...a];
      const bs = [...b];
      for (let i = 0; i < Math.min(as.length, bs.length); i++) {
        const d = as[i].codePointAt(0)! - bs[i].codePointAt(0)!;
        if (d !== 0) return d;
      }
      return as.length - bs.length;
    });
  }

  /** Create every missing ancestor of `path`; error string if one is a file. */
  function ensureParents(path: string): string | null {
    for (let p = parentOf(path); p !== ""; p = parentOf(p)) {
      if (files.has(p)) return `not a directory: ${p}`;
      dirs.add(p);
    }
    return null;
  }

  function usedBytes(): number {
    let n = 0;
    for (const bytes of files.values()) n += bytes.length;
    return n;
  }

  const ns = {
    read(path: string, offset: number, maxBytes: number): string {
      log.push(`op read ${path} ${offset} ${maxBytes}`);
      if (!fsValidPath(path)) return errLine("invalid path");
      if (maxBytes < 1 || maxBytes > FS_MAX_IO_BYTES) {
        return errLine("read maxBytes out of range");
      }
      if (offset < 0) return errLine("read offset out of range");
      const bytes = files.get(path);
      if (!bytes) return errLine(isDir(path) ? "is a directory" : "not found");
      const chunk = bytes.subarray(offset, offset + maxBytes);
      return ok(
        JSON.stringify({
          data: { [FS_BLOB_KEY]: Buffer.from(chunk).toString("base64") },
          size: bytes.length,
          eof: offset + chunk.length >= bytes.length,
        }),
      );
    },
    readText(path: string): string {
      log.push(`op readText ${path}`);
      if (!fsValidPath(path)) return errText("invalid path");
      const bytes = files.get(path);
      if (!bytes) return errText(isDir(path) ? "is a directory" : "not found");
      if (bytes.length > FS_MAX_TEXT_BYTES) return errText(FS_READ_TEXT_TOO_LARGE);
      try {
        // ignoreBOM keeps U+FEFF in the returned string so re-encoding yields
        // the file's exact bytes, matching the native host.
        return ok(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
      } catch {
        return errText("invalid UTF-8");
      }
    },
    write(path: string, data: string, mode: number): number {
      log.push(`op write ${path} ${mode}`);
      if (!fsValidPath(path)) return err("invalid path");
      if (mode !== FS_WRITE_TRUNCATE && mode !== FS_WRITE_APPEND) {
        return err("invalid write mode");
      }
      const payload = decodePayload(data);
      if (typeof payload === "string") return err(payload);
      if (payload.length > FS_MAX_IO_BYTES) return err("write exceeds FS_MAX_IO_BYTES");
      if (isDir(path)) return err("is a directory");
      const parentProblem = ensureParents(path);
      if (parentProblem) return err(parentProblem);
      const existing = mode === FS_WRITE_APPEND ? files.get(path) : undefined;
      const nextSize = (existing?.length ?? 0) + payload.length;
      if (quota > 0 && usedBytes() - (files.get(path)?.length ?? 0) + nextSize > quota) {
        return err("quota exceeded");
      }
      if (existing) {
        const joined = new Uint8Array(nextSize);
        joined.set(existing, 0);
        joined.set(payload, existing.length);
        files.set(path, joined);
      } else {
        files.set(path, payload.slice());
      }
      return ok(0);
    },
    remove(path: string, recursive: number): number {
      log.push(`op remove ${path} ${recursive}`);
      if (!fsValidPath(path)) return err("invalid path");
      if (files.delete(path)) return ok(0);
      if (!dirs.has(path)) return err("not found");
      if (childrenOf(path).length > 0 && recursive !== 1) return err("directory not empty");
      const prefix = `${path}/`;
      for (const key of [...files.keys()]) if (key.startsWith(prefix)) files.delete(key);
      for (const key of [...dirs]) if (key.startsWith(prefix)) dirs.delete(key);
      dirs.delete(path);
      return ok(0);
    },
    list(path: string, offset: number): string {
      log.push(`op list ${path} ${offset}`);
      if (path !== "" && !fsValidPath(path)) return errLine("invalid path");
      if (files.has(path)) return errLine("not a directory");
      if (!isDir(path)) return errLine("not found");
      const names = childrenOf(path);
      // Clamp like the reference core: a negative offset must not wrap to
      // slice-from-the-end.
      offset = Math.max(0, offset);
      const page = names.slice(offset, offset + FS_MAX_DIR_ENTRIES);
      return ok(
        JSON.stringify({
          entries: page.map((name) => {
            const full = path === "" ? name : `${path}/${name}`;
            const bytes = files.get(full);
            return bytes
              ? { name, kind: "file", size: bytes.length }
              : { name, kind: "dir", size: 0 };
          }),
          eof: offset + page.length >= names.length,
        }),
      );
    },
    stat(path: string): string {
      log.push(`op stat ${path}`);
      if (path === "") return ok(JSON.stringify({ kind: "dir", size: 0 }));
      if (!fsValidPath(path)) return errLine("invalid path");
      const bytes = files.get(path);
      if (bytes) return ok(JSON.stringify({ kind: "file", size: bytes.length }));
      if (dirs.has(path)) return ok(JSON.stringify({ kind: "dir", size: 0 }));
      return errLine("not found");
    },
    mkdir(path: string): number {
      log.push(`op mkdir ${path}`);
      if (!fsValidPath(path)) return err("invalid path");
      if (files.has(path)) return err(`not a directory: ${path}`);
      const parentProblem = ensureParents(path);
      if (parentProblem) return err(parentProblem);
      dirs.add(path);
      return ok(0);
    },
    rename(from: string, to: string): number {
      log.push(`op rename ${from} ${to}`);
      if (!fsValidPath(from) || !fsValidPath(to)) return err("invalid path");
      if (from === to) return ok(0);
      if (!isDir(parentOf(to))) return err("not found");
      if (dirs.has(to)) return err("destination exists");
      const fromFile = files.get(from);
      if (fromFile) {
        if (files.has(to)) files.delete(to);
        files.delete(from);
        files.set(to, fromFile);
        return ok(0);
      }
      if (!dirs.has(from)) return err("not found");
      if (files.has(to)) return err("destination exists");
      if (to.startsWith(`${from}/`)) return err("cannot rename into own subtree");
      const prefix = `${from}/`;
      for (const [key, bytes] of [...files.entries()]) {
        if (!key.startsWith(prefix)) continue;
        files.delete(key);
        files.set(`${to}/${key.slice(prefix.length)}`, bytes);
      }
      for (const key of [...dirs]) {
        if (!key.startsWith(prefix)) continue;
        dirs.delete(key);
        dirs.add(`${to}/${key.slice(prefix.length)}`);
      }
      dirs.delete(from);
      dirs.add(to);
      return ok(0);
    },
    usage(): string {
      log.push("op usage");
      return ok(JSON.stringify({ usedBytes: usedBytes(), quotaBytes: quota }));
    },
    lastError(): string {
      return lastError;
    },
  };

  return {
    ns,
    log,
    dispose(): void {
      files.clear();
      dirs.clear();
    },
  };
}
