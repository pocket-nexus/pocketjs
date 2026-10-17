// framework/compiler/runtime-packages.ts — the packages whose code enters the
// guest bundle, and where the compiler and the application find them.
//
// The compiler reads each framework's runtime from the copy installed beside
// the compiler and bundles that copy alone. An application type-checks and
// writes its imports against the copy its own resolution finds. When the two
// copies differ in version, the application was checked against one runtime
// and runs another, so `pocket check` reports the difference.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PocketFramework } from "../src/config.ts";

const COMPILER_DIRECTORY = fileURLToPath(new URL(".", import.meta.url));

/** The runtime package each framework's application code imports. */
export const GUEST_RUNTIME_PACKAGE: Readonly<Record<PocketFramework, string>> = {
  solid: "solid-js",
  "vue-vapor": "vue",
  octane: "octane",
};

/** The installed directory of package `name`, found by walking `node_modules`
 *  upward from `from` as Node resolution does, or null. Package `exports` maps
 *  do not expose the dist files the compiler reads, so the lookup stops at the
 *  package directory. */
export function findPackageDirectory(name: string, from: string): string | null {
  for (let directory = resolve(from); ; directory = dirname(directory)) {
    const candidate = join(directory, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
    if (dirname(directory) === directory) return null;
  }
}

/** The directory of the copy the compiler bundles: a checkout keeps it under the
 *  framework, an application install hoists it beside the framework. */
export function compilerPackageDirectory(name: string): string {
  const directory = findPackageDirectory(name, COMPILER_DIRECTORY);
  if (!directory) throw new Error(`PocketJS build: package ${name} is not installed beside ${COMPILER_DIRECTORY}`);
  return directory;
}

export function packageVersion(directory: string): string {
  return JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).version;
}

export interface RuntimePackageCopy {
  readonly version: string;
  readonly directory: string;
}

export interface RuntimeVersionMismatch {
  readonly name: string;
  readonly application: RuntimePackageCopy;
  readonly bundled: RuntimePackageCopy;
}

/** The framework's runtime package when the application under `projectRoot`
 *  resolves a version other than the one the compiler bundles; null when the
 *  versions agree or the application resolves no copy. */
export function runtimeVersionMismatch(
  framework: PocketFramework,
  projectRoot: string,
): RuntimeVersionMismatch | null {
  const name = GUEST_RUNTIME_PACKAGE[framework];
  const bundledDirectory = compilerPackageDirectory(name);
  const applicationDirectory = findPackageDirectory(name, projectRoot);
  if (!applicationDirectory || applicationDirectory === bundledDirectory) return null;
  const bundled = { version: packageVersion(bundledDirectory), directory: bundledDirectory };
  const application = { version: packageVersion(applicationDirectory), directory: applicationDirectory };
  return application.version === bundled.version ? null : { name, application, bundled };
}
