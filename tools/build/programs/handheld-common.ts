import { existsSync, statSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { AppConfig } from "../../../contracts/spec/app-config.ts";
import { appOutput } from "../../../framework/compiler/app-plan.ts";
import type { RuntimeBuildContext } from "../../../framework/src/host-config.ts";
import { compileApplication } from "../../compile-app.ts";
import { loadHostConfig } from "../../profile-resolver.ts";
import { withArtifactLock } from "../../targets/lock.ts";

export const repository = resolve(import.meta.dir, "../../..");

/** The host config of the stock demo apps/<demo> (`hero` or `hero-main`). */
export function demoConfigPath(name: string): string {
  const demo = name.replace(/-main$/, "");
  const path = resolve(repository, "apps", demo, "pocket.host.config.ts");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(demo) || !existsSync(path))
    throw new Error(`${name} is not a stock demo (apps/<demo>/pocket.host.config.ts); compile the application with \`pocket compile\` and build its package with \`pocket build --pocket\``);
  return path;
}

/** The `app` section of a stock demo's host config. */
export async function demoApp(name: string): Promise<AppConfig> {
  const config = await loadHostConfig(demoConfigPath(name));
  if (!config.value.app) throw new Error(`${config.path} has no app section`);
  return config.value.app;
}

/** The package a stock demo compiles to under `outdir`. */
export async function demoPackagePath(name: string, outdir: string): Promise<string> {
  return resolve(outdir, `${appOutput(await demoApp(name))}.pocket`);
}

/** Compile a stock demo for `target` as `pocket compile` does, from the
 *  repository root, into `outdir` and `<outdir>/<output>.pocket`; native
 *  programs embed only compiled packages. `app` derives a variant of the
 *  demo's application (another framework, for example). With `reuse`, the
 *  package from an earlier compile is returned unchanged. */
export async function compileDemoPackage(target: string, name: string, outdir: string, options: {
  reuse?: boolean; app?: (app: AppConfig) => AppConfig;
} = {}): Promise<string> {
  const declared = await demoApp(name);
  const output = resolve(outdir, `${appOutput(options.app ? options.app(declared) : declared)}.pocket`);
  if (options.reuse) {
    if (!existsSync(output)) throw new Error(`--skip-build reuses a compiled package, and ${output} does not exist`);
    return output;
  }
  const directory = resolve(repository, ".pocket", `${target}-low-level`, appOutput(declared));
  await compileApplication({ configPath: demoConfigPath(name), target, projectRoot: repository, outdir,
    planRoot: resolve(directory, "plans"), output, ...(options.app ? { app: options.app } : {}) });
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
