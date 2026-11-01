#!/usr/bin/env bun
// The C header of the QuickJS engine ABIs (contracts/spec/quickjs-bytecode.ts).
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { quickJsEngineAbiHeader } from "../contracts/spec/quickjs-bytecode.ts";

const root = resolve(import.meta.dir, "..");

export function generatedQuickJsBytecodeContracts(): Map<string, string> {
  return new Map([["contracts/generated/pocket_quickjs_abi.h", quickJsEngineAbiHeader()]]);
}

if (import.meta.main) {
  const check = Bun.argv.includes("--check");
  for (const [path, contents] of generatedQuickJsBytecodeContracts()) {
    const file = resolve(root, path);
    if (check) {
      if (!existsSync(file) || readFileSync(file, "utf8") !== contents) throw new Error(`stale generated contract: ${path}`);
    } else await Bun.write(file, contents);
  }
}
