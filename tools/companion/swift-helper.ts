// The companion's native helpers (tools/companion/macos/*.swift, not the app;
// tools/companion/linux/*.c on Linux): a helper runs from, in order, its
// environment override (a binary, or a .ts file run with this Bun; the tests
// use it), the binary of its name next to the running executable (the app
// bundle's Contents/MacOS), or a build of its source into `<store>/bin`,
// keyed by the source's hash: the Swift source with swiftc on a Mac, the C
// source with cc and its pkg-config packages on Linux.

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
  /** The Linux build: a C source and the pkg-config packages it links. */
  linux?: { source: string; packages: string[] };
}

const builds = new Map<string, Promise<string[] | null>>();

/** The command that runs `helper`, building it first when needed; null when
 *  this computer cannot run it (no compiler, or the build failed). */
export function helperCommand(helper: SwiftHelper, storeDir: string, log?: (line: string) => void): Promise<string[] | null> {
  const override = process.env[helper.env];
  if (override) return Promise.resolve(override.endsWith(".ts") ? [process.execPath, override] : [override]);
  const bundled = join(dirname(process.execPath), helper.name);
  if (existsSync(bundled)) return Promise.resolve([bundled]);
  if (process.platform === "linux") {
    if (!helper.linux || !existsSync(helper.linux.source)) return Promise.resolve(null);
  } else if (!existsSync(helper.source)) return Promise.resolve(null);
  let build = builds.get(helper.name);
  if (!build) {
    build = buildHelper(helper, storeDir, log).finally(() => builds.delete(helper.name));
    builds.set(helper.name, build);
  }
  return build;
}

async function buildHelper(helper: SwiftHelper, storeDir: string, log?: (line: string) => void): Promise<string[] | null> {
  const linux = process.platform === "linux" ? helper.linux : undefined;
  const source = linux?.source ?? helper.source;
  const hash = createHash("sha256").update(readFileSync(source)).digest("hex").slice(0, 12);
  const dir = join(storeDir, "bin");
  const binary = join(dir, `${helper.name}-${hash}`);
  if (existsSync(binary)) return [binary];
  const compiler = linux ? "cc" : "swiftc";
  if (spawnSync("which", [compiler]).status !== 0) {
    log?.(`agent: ${compiler} not found; ${helper.name} is off`);
    return null;
  }
  let flags: string[] = [];
  if (linux) {
    const config = spawnSync("pkg-config", ["--cflags", "--libs", ...linux.packages], { encoding: "utf8" });
    if (config.status !== 0) {
      log?.(`agent: ${helper.name} needs ${linux.packages.join(" and ")} (pkg-config: ${String(config.stderr).trim().slice(0, 200)})`);
      return null;
    }
    flags = config.stdout.trim().split(/\s+/).filter(Boolean);
  }
  mkdirSync(dir, { recursive: true });
  const partial = `${binary}.${process.pid}.tmp`;
  const started = Date.now();
  const ok = await new Promise<boolean>((resolve) => {
    const args = linux
      ? ["-O2", source, "-o", partial, ...flags]
      : ["-O", ...(helper.flags ?? []), "-swift-version", "5", source, "-o", partial];
    const child = spawn(compiler, args, { stdio: ["ignore", "ignore", "pipe"] });
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
