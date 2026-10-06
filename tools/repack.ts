// bun tools/repack.ts --target <t> --runtime dist/runtime/<t> --pocket <file>
//   --id <id> --title <title> --author <author> --version <version>
//   [--icon <square.png>] -o <out>
//
// A game's installation package from a prebuilt runtime (tools/runtime.ts)
// and the game's `.pocket`, with no native tools. This file only reads the
// files; tools/repack/<target>.ts does the work on bytes, so a Worker can call
// it the same way.

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { RepackInput } from "./repack/shared/runtime.ts";

type Repack = (input: RepackInput) => Promise<Uint8Array>;

const TARGETS: Record<string, () => Promise<Repack>> = {
  "3ds": async () => (await import("./repack/3ds.ts")).repack3ds,
  android: async () => (await import("./repack/android.ts")).repackAndroid,
};

/** Every file below `directory`, by "/"-separated relative path. */
export function readRuntimeDirectory(directory: string): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  const walk = (path: string) => {
    for (const name of readdirSync(path)) {
      const child = join(path, name);
      if (statSync(child).isDirectory()) walk(child);
      else files.set(relative(directory, child).split("\\").join("/"), new Uint8Array(readFileSync(child)));
    }
  };
  walk(directory);
  return files;
}

const USAGE =
  `usage: bun tools/repack.ts --target <${Object.keys(TARGETS).join("|")}> --runtime <dir> --pocket <file> ` +
  "--id <id> --title <title> --author <author> --version <version> [--icon <png>] -o <out>";

export async function repackMain(argv: readonly string[]): Promise<string> {
  const options = new Map<string, string>();
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!;
    const name = argument === "-o" ? "out" : argument.startsWith("--") ? argument.slice(2) : "";
    const value = argv[index + 1];
    if (!name || value === undefined) throw new Error(USAGE);
    options.set(name, value);
    index += 1;
  }
  const required = ["target", "runtime", "pocket", "id", "title", "author", "version", "out"];
  const missing = required.filter((name) => !options.get(name));
  const unknown = [...options.keys()].filter((name) => !required.includes(name) && name !== "icon");
  if (missing.length || unknown.length) {
    throw new Error(`${USAGE}\n${[...missing.map((name) => `missing --${name}`), ...unknown.map((name) => `unknown --${name}`)].join(", ")}`);
  }
  const load = TARGETS[options.get("target")!];
  if (!load) throw new Error(USAGE);
  const repack = await load();
  const icon = options.get("icon");
  const started = performance.now();
  const bytes = await repack({
    runtime: readRuntimeDirectory(options.get("runtime")!),
    pocket: new Uint8Array(readFileSync(options.get("pocket")!)),
    identity: {
      id: options.get("id")!,
      title: options.get("title")!,
      author: options.get("author")!,
      version: options.get("version")!,
      ...(icon ? { icon: new Uint8Array(readFileSync(icon)) } : {}),
    },
  });
  const elapsed = performance.now() - started;
  const out = options.get("out")!;
  writeFileSync(out, bytes);
  console.log(`output: ${out} (${bytes.length} bytes, repacked in ${elapsed.toFixed(0)} ms)`);
  return out;
}

if (import.meta.main) {
  try {
    await repackMain(Bun.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
