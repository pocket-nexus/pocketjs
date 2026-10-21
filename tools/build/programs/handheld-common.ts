import { existsSync, statSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { RuntimeBuildContext } from "../../../framework/src/runtime-config.ts";
import { withArtifactLock } from "../../targets/lock.ts";

export const repository = resolve(import.meta.dir, "../../..");
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
  const paths = ["engine/Cargo.toml", "engine/Cargo.lock", "contracts/generated", ...directories.flatMap(directory =>
    ["src", "include", "build.rs", "Cargo.toml", "Cargo.lock", "Makefile"].map(name => `${directory}/${name}`))];
  return paths.map(path => resolve(repository, path)).filter(existsSync);
}

export function programFiles(directory: string, extensions: RegExp): string[] {
  const root = resolve(repository, directory);
  return readdirSync(root).filter(name => extensions.test(name) && statSync(resolve(root, name)).isFile()).map(name => resolve(root, name));
}
