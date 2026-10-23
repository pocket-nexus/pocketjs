import { existsSync, mkdirSync, statSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { RuntimeBuildContext } from "../../../framework/src/runtime-config.ts";
import { demoManifestFor } from "../../demo-identity.ts";
import { withArtifactLock } from "../../targets/lock.ts";

export const repository = resolve(import.meta.dir, "../../..");

/** The manifest of the stock demo apps/<demo>/main.tsx (`hero` or `hero-main`):
 *  its own pocket.json, or the repository template with its identity. */
export function demoManifest(name: string, framework?: string): Record<string, any> {
  const demo = name.replace(/-main$/, "");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(demo) || !["main.tsx", "main.ts"].some(file => existsSync(resolve(repository, "apps", demo, file))))
    throw new Error(`${name} is not a stock demo (apps/<demo>/main.tsx); compile the application with \`pocket compile\` and build its package with \`pocket build --pocket\``);
  return demoManifestFor(`${repository}/`, demo, framework);
}

/** Compile a demo manifest as `pocket compile` does, into `outdir` and
 *  `<outdir>/<output>.pocket`; native programs embed only compiled packages.
 *  With `reuse`, the package from an earlier compile is returned unchanged. */
export async function compileDemoPackage(target: string, manifest: Record<string, any>, outdir: string, reuse = false): Promise<string> {
  const output = resolve(outdir, `${manifest.app.output}.pocket`);
  if (reuse) {
    if (!existsSync(output)) throw new Error(`--skip-build reuses a compiled package, and ${output} does not exist`);
    return output;
  }
  const directory = resolve(repository, ".pocket", `${target}-low-level`, manifest.app.output);
  mkdirSync(directory, { recursive: true });
  const manifestPath = resolve(directory, "pocket.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  const child = Bun.spawn([process.execPath, resolve(repository, "tools/pocket.ts"), "compile", "--target", target,
    "--manifest", manifestPath, "--project-root", repository, "--outdir", outdir,
    "--plan-dir", resolve(directory, "plans"), "--output", output], { cwd: repository, stdout: "inherit", stderr: "inherit" });
  if (await child.exited !== 0 || child.signalCode) throw new Error(`pocket compile failed for ${target}: ${manifest.app.output}`);
  return output;
}
export const buildHosts = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"] as const;
/** Shared native caches and packaging metadata have one writer per program. */
export function handheldLock<T>(id: string, operation: () => Promise<T>): Promise<T> {
  return withArtifactLock(resolve(repository, `.pocket-build/native-locks/${id}`), operation);
}
export function nativeArguments(context: RuntimeBuildContext): string[] {
  for (const arg of context.args) {
    if (/^--(?:plan|manifest|pocket-only|project-root|outdir|package-outdir|framework|config|runtime|skip-build|target|target-dir|manifest-path|package|profile|features|no-default-features|help|version)(?:=|$)/.test(arg)) {
      throw new Error(`native recipe owns ${arg}; supply --pocket to the build executor`);
    }
  }
  return context.args.map(arg => {
    const match = /^(--launcher-(?:registry|packages))=(.+)$/.exec(arg);
    if (!match) {
      if (arg === "--launcher-registry" || arg === "--launcher-packages") throw new Error(`${arg} requires =<path>`);
      return arg;
    }
    const path = resolve(match[2]!);
    if (!existsSync(path) || (match[1] === "--launcher-registry" ? !statSync(path).isFile() : !statSync(path).isDirectory())) {
      throw new Error(`missing native launcher input: ${path}`);
    }
    return `${match[1]}=${path}`;
  });
}

/** Declared source roots exclude Cargo output and per-run build directories. */
export function nativeSources(...directories: string[]): string[] {
  const paths = ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "contracts/generated", ...directories.flatMap(directory =>
    ["src", "include", "build.rs", "Cargo.toml", "Cargo.lock", "Makefile"].map(name => `${directory}/${name}`))];
  return paths.map(path => resolve(repository, path)).filter(existsSync);
}

export function programFiles(directory: string, extensions: RegExp): string[] {
  const root = resolve(repository, directory);
  return readdirSync(root).filter(name => extensions.test(name) && statSync(resolve(root, name)).isFile()).map(name => resolve(root, name));
}
