#!/usr/bin/env bun
// Builds the generic runtime of a target into dist/runtime/<target>/: the
// host with no game in it, and runtime.json beside it. tools/repack.ts adds a
// game to it.
//
//   bun tools/runtime.ts <target> [target options]
//
// Each target's build is tools/runtime/<target>.ts; options after the target
// go to it.

import { existsSync } from "node:fs";
import { join } from "node:path";

/** Targets with a runtime build, by the name of their tools/runtime/<name>.ts. */
export const RUNTIME_TARGETS = ["android"] as const;

if (import.meta.main) {
  const [target, ...rest] = Bun.argv.slice(2);
  if (!target || !(RUNTIME_TARGETS as readonly string[]).includes(target)) {
    console.error(`usage: bun tools/runtime.ts <${RUNTIME_TARGETS.join("|")}> [options]`);
    process.exit(2);
  }
  const script = join(import.meta.dir, "runtime", `${target}.ts`);
  if (!existsSync(script)) throw new Error(`runtime: ${script} is absent`);
  const done = Bun.spawnSync(["bun", script, ...rest], { stdout: "inherit", stderr: "inherit", stdin: "inherit" });
  process.exit(done.exitCode ?? 1);
}
