#!/usr/bin/env bun
// Entry point for Rust AOT builds.
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const candidate = args[0] === "check" ? args[1] : args[0];
const isSfc = candidate?.endsWith(".vue") || (candidate &&
  [resolve(candidate), resolve(import.meta.dir, "../../apps", candidate)].some(path =>
    existsSync(path) && statSync(path).isDirectory(),
  ));
if (args[0] === "--help" || args[0] === "-h") {
  console.log("bun microts/compiler/cli.ts build <app|Root.vue|App.tsx> [--out gen] [--strict] [--ir file] [--board name] [--no-format]\nbun microts/compiler/cli.ts check <app|Root.vue|App.tsx> [--strict] [--boards | --board name] [--json]\nbun microts/compiler/cli.ts run <app> --tape <file>");
} else if (args[0] === "build" || args[0] === "run" || args[0] === "check" && candidate?.endsWith(".tsx") || isSfc) {
  try {
    const { runAotCli } = await import("./aot-build.ts");
    await runAotCli(args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
} else {
  console.error("MicroTS: expected build, check or run; use --help for commands");
  process.exitCode = 1;
}
