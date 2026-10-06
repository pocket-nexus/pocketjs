#!/usr/bin/env bun
// Repacks a game into an installation package: a generic runtime
// (tools/runtime.ts), a `.pocket` holding the target's variant, and the
// identity the package goes by. No compiler runs.
//
//   bun tools/repack.ts --target <t> --runtime dist/runtime/<t> --pocket <file.pocket> \
//       --id <id> --title <title> --author <author> --version <major.minor.patch> \
//       [--icon <square.png>] -o <out>
//
// Each target's step is tools/repack/<target>.ts, exporting
// `repack<Target>(input: RepackInput): Promise<Uint8Array>`.

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { RepackInput } from "./repack/shared/input.ts";

type Repack = (input: RepackInput) => Promise<Uint8Array>;

/** The repack step of each target. */
export const REPACKS: Record<string, () => Promise<Repack>> = {
  android: async () => (await import("./repack/android.ts")).repackAndroid,
};

/** A runtime directory's files by relative path, as the repack steps take them. */
export function readRuntimeDirectory(directory: string): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  const walk = (path: string) => {
    for (const name of readdirSync(path).sort()) {
      const child = join(path, name);
      if (statSync(child).isDirectory()) walk(child);
      else files.set(relative(directory, child), new Uint8Array(readFileSync(child)));
    }
  };
  walk(directory);
  return files;
}

function usage(message?: string): never {
  if (message) console.error(`repack: ${message}`);
  console.error(
    `usage: bun tools/repack.ts --target <${Object.keys(REPACKS).join("|")}> --runtime <dir> --pocket <file.pocket> ` +
      "--id <id> --title <title> --author <author> --version <x.y.z> [--icon <png>] -o <out>",
  );
  process.exit(2);
}

if (import.meta.main) {
  const argv = Bun.argv.slice(2);
  const values: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const name = flag === "-o" ? "out" : flag.startsWith("--") ? flag.slice(2) : usage(`unexpected ${flag}`);
    const value = argv[++i];
    if (value === undefined) usage(`${flag} needs a value`);
    values[name] = value;
  }
  for (const required of ["target", "runtime", "pocket", "id", "title", "author", "version", "out"]) {
    if (!values[required]) usage(`--${required === "out" ? "o" : required} is required`);
  }
  const load = REPACKS[values.target];
  if (!load) usage(`no repack for target ${values.target}`);
  const started = performance.now();
  const repack = await load();
  try {
    const bytes = await repack({
      runtime: readRuntimeDirectory(resolve(values.runtime)),
      pocket: new Uint8Array(readFileSync(resolve(values.pocket))),
      identity: {
        id: values.id,
        title: values.title,
        author: values.author,
        version: values.version,
        ...(values.icon ? { icon: new Uint8Array(readFileSync(resolve(values.icon))) } : {}),
      },
    });
    const out = resolve(values.out);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, bytes);
    console.log(
      `repack ${values.target}: ${out} (${bytes.length} bytes, sha256 ${createHash("sha256").update(bytes).digest("hex")}, ` +
        `${((performance.now() - started) / 1000).toFixed(2)} s)`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
