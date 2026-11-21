// @pocketjs/framework/game2d — small JSON saves over data.fs. Silent no-op without a host filesystem,
// so a game never has to branch on it. PSP cannot replace a file atomically (docs/PACKS.md): write a
// sibling first, so a power cut leaves either the old or the new file readable.

import { existsSync, fsHost, readFileSync, renameSync, rmSync, writeFileSync } from "../fs-api.ts";

export interface SaveSlot { load<T = unknown>(): T | null; save(value: unknown): boolean; clear(): void }

export function createSave(name: string): SaveSlot {
  const path = `${name}.json`, stage = `${name}.new.json`;
  const parse = (p: string) => { try { return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null; } catch { return null; } };
  return {
    load: <T,>() => (fsHost() ? ((parse(path) ?? parse(stage)) as T | null) : null),
    save(value) {
      if (!fsHost()) return false;
      try {
        const s = typeof value === "string" ? value : JSON.stringify(value);
        writeFileSync(stage, s);
        if (existsSync(path)) rmSync(path);
        renameSync(stage, path);
        return true;
      } catch { return false; }
    },
    clear() {
      if (!fsHost()) return;
      try { if (existsSync(path)) rmSync(path); if (existsSync(stage)) rmSync(stage); } catch { /* nothing to do */ }
    },
  };
}
