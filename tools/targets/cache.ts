// tools/targets/cache.ts — the per-user directory PocketJS tools write
// reproducible content into: toolchains, verified downloads, the compiler's
// transform cache. One resolution for every tool.
//
//   POCKET_NEXUS_CACHE_DIR            when set
//   $XDG_CACHE_HOME/pocket-nexus      when XDG_CACHE_HOME is set
//   $HOME/.cache/pocket-nexus         otherwise

import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function pocketNexusCacheRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.POCKET_NEXUS_CACHE_DIR?.trim()) return resolve(env.POCKET_NEXUS_CACHE_DIR.trim());
  const cacheHome = env.XDG_CACHE_HOME?.trim()
    ? resolve(env.XDG_CACHE_HOME.trim())
    : join(env.HOME || homedir(), ".cache");
  return join(cacheHome, "pocket-nexus");
}
