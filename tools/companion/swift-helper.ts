// The companion's macOS helpers (tools/companion/macos/*.swift, not the app):
// a helper runs from, in order, its environment override (a binary, or a .ts
// file run with this Bun; the tests use it), the binary of its name next to
// the running executable (the app bundle's Contents/MacOS), or a build of its
// Swift source with swiftc into `<store>/bin`, keyed by the source's hash.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";

export interface SwiftHelper {
  /** Binary name: `pocket-transcribe`. */
  name: string;
  /** Absolute path of the Swift source. */
  source: string;
  /** Environment variable that overrides the helper. */
  env: string;
  /** Extra swiftc flags (`-parse-as-library` for an @main type). */
  flags?: string[];
}

const builds = new Map<string, Promise<string[] | null>>();

/** The command that runs `helper`, building it first when needed; null when
 *  this Mac cannot run it (no swiftc, or the build failed). */
export function helperCommand(helper: SwiftHelper, storeDir: string, log?: (line: string) => void): Promise<string[] | null> {
  const override = process.env[helper.env];
  if (override) return Promise.resolve(override.endsWith(".ts") ? [process.execPath, override] : [override]);
  const bundled = join(dirname(process.execPath), helper.name);
  if (existsSync(bundled)) return Promise.resolve([bundled]);
  if (!existsSync(helper.source)) return Promise.resolve(null);
  let build = builds.get(helper.name);
  if (!build) {
    build = buildHelper(helper, storeDir, log).finally(() => builds.delete(helper.name));
    builds.set(helper.name, build);
  }
  return build;
}

async function buildHelper(helper: SwiftHelper, storeDir: string, log?: (line: string) => void): Promise<string[] | null> {
  const hash = createHash("sha256").update(readFileSync(helper.source)).digest("hex").slice(0, 12);
  const dir = join(storeDir, "bin");
  const binary = join(dir, `${helper.name}-${hash}`);
  if (existsSync(binary)) return [binary];
  if (spawnSync("which", ["swiftc"]).status !== 0) {
    log?.(`agent: swiftc not found; ${helper.name} is off`);
    return null;
  }
  mkdirSync(dir, { recursive: true });
  const partial = `${binary}.${process.pid}.tmp`;
  const started = Date.now();
  const ok = await new Promise<boolean>((resolve) => {
    const child = spawn("swiftc", ["-O", ...(helper.flags ?? []), "-swift-version", "5", helper.source, "-o", partial], { stdio: ["ignore", "ignore", "pipe"] });
    let errors = "";
    child.stderr.on("data", (chunk: Buffer) => (errors += chunk.toString()));
    child.on("exit", (code) => {
      if (code !== 0) log?.(`agent: building ${helper.name} failed: ${errors.trim().slice(0, 400)}`);
      resolve(code === 0);
    });
    child.on("error", () => resolve(false));
  });
  if (!ok) return null;
  chmodSync(partial, 0o755);
  renameSync(partial, binary);
  log?.(`agent: built ${binary} in ${Date.now() - started} ms`);
  return [binary];
}
