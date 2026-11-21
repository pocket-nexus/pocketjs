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
    // The compiler reads no file for application settings; this driver
    // registers the application its argument names from the host config
    // above it (aot-model-config.ts) before compiling.
    const named = args[0] === "build" || args[0] === "run" || args[0] === "check" ? args[1] : args[0];
    const source = named && [resolve(named), resolve(import.meta.dir, "../../apps", named)].find(path => existsSync(path));
    if (source) {
      const { registerSourceApplication } = await import("../../tools/source-app.ts");
      // A directory names its own config; a file names the config above it.
      await registerSourceApplication(statSync(source).isDirectory() ? resolve(source, "pocket.host.config.ts") : source);
    }
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
