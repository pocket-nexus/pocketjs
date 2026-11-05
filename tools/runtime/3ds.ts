// Compatibility entry for the minimal file-loaded 3DS program.
import { resolve } from "node:path";
import type { RuntimeBuildContext } from "../../framework/src/host-config.ts";
import { buildMinimal3ds } from "../build/programs/3ds.ts";
export async function buildRuntime3ds(argv: readonly string[] = [], context?: RuntimeBuildContext): Promise<string> {
  let out = resolve(import.meta.dir, "../../dist/runtime/3ds");
  for (const argument of argv) {
    if (argument.startsWith("--out=")) out = resolve(argument.slice(6));
    else throw new Error(`usage: bun tools/runtime.ts 3ds [--out=<dir>] (unknown argument ${argument})`);
  }
  return buildMinimal3ds(out, context);
}
if (import.meta.main) {
  try { await buildRuntime3ds(Bun.argv.slice(2)); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); }
}
