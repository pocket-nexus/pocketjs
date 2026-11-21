// tools/cli/framework.mjs — which PocketJS framework a `pocket` command runs.
//
// A framework root is a directory whose package.json carries
// `"pocketjs": { "protocol": <n> }`; the package name is not read, so a fork
// published under another name is recognized. An application installs the
// framework at node_modules/@pocketjs/framework, whatever its package name.
//
//   1. POCKETJS_FRAMEWORK_ROOT, when set
//   2. the nearest of: an ancestor that is a framework root (a checkout), or an
//      ancestor's node_modules/@pocketjs/framework; when one directory is both,
//      the checkout wins

import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** The CLI ↔ framework protocol this CLI speaks. */
export const CLI_PROTOCOL = 1;

export const INSTALL_PATH = join("node_modules", "@pocketjs", "framework");

/** The marker of a framework root, or null. */
export function readMarker(directory) {
  try {
    const pkg = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
    const protocol = pkg?.pocketjs?.protocol;
    if (!Number.isInteger(protocol)) return null;
    return { protocol, name: pkg.name ?? null, version: pkg.version ?? null };
  } catch {
    return null;
  }
}

/** The lockfile spec an application pinned the framework with, when its bun.lock names one. */
function lockedSpec(projectDirectory) {
  try {
    const lock = readFileSync(join(projectDirectory, "bun.lock"), "utf8");
    const match = lock.match(/"@pocketjs\/framework": \["@pocketjs\/framework@([^"]+)"/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/** How an application's install path entry was produced: a link, a git
 *  dependency, a local tarball or directory, or a registry version. */
function installSource(projectDirectory, installPath) {
  if (lstatSync(installPath).isSymbolicLink()) return `link → ${realpathSync(installPath)}`;
  const spec = lockedSpec(projectDirectory);
  if (spec && /^(?:github:|git\+|git:|https?:\/\/.*\.git)/.test(spec)) return `git ${spec.replace(/^git\+/, "")}`;
  if (spec && /^(?:file:|link:)/.test(spec)) return spec;
  return "registry";
}

/**
 * The framework for `cwd`: `{ root, source, origin, protocol, version, name }`,
 * or `{ error }`. `source` is "env", "checkout" or "project"; `origin` says
 * where it came from for `pocket show`.
 */
export function resolveFramework({ cwd = process.cwd(), env = process.env } = {}) {
  const explicit = env.POCKETJS_FRAMEWORK_ROOT?.trim();
  if (explicit) {
    const root = resolve(explicit);
    const marker = readMarker(root);
    if (!marker) {
      return { error: `POCKETJS_FRAMEWORK_ROOT=${root} is not a PocketJS framework: its package.json has no "pocketjs": { "protocol": … } marker` };
    }
    return { root, source: "env", origin: "POCKETJS_FRAMEWORK_ROOT", ...marker };
  }
  for (let directory = resolve(cwd); ; directory = dirname(directory)) {
    const checkout = readMarker(directory);
    if (checkout) {
      const shadowed = existsSync(join(directory, INSTALL_PATH));
      return {
        root: directory,
        source: "checkout",
        origin: shadowed ? `checkout (over ${join(directory, INSTALL_PATH)})` : "checkout",
        ...checkout,
      };
    }
    const installPath = join(directory, INSTALL_PATH);
    if (existsSync(join(installPath, "package.json"))) {
      const marker = readMarker(installPath);
      if (!marker) {
        return { error: `${installPath} is not a PocketJS framework this CLI can drive: its package.json has no "pocketjs": { "protocol": … } marker; install a newer @pocketjs/framework` };
      }
      return { root: realpathSync(installPath), source: "project", origin: installSource(directory, installPath), ...marker };
    }
    if (dirname(directory) === directory) {
      return { error: "PocketJS framework not found — install @pocketjs/framework in this project, work inside a PocketJS checkout, or set POCKETJS_FRAMEWORK_ROOT" };
    }
  }
}

/** A diagnostic when the framework speaks another protocol than this CLI, or null. */
export function protocolMismatch(framework, cliVersion) {
  if (framework.protocol === CLI_PROTOCOL) return null;
  return `@pocketjs/cli ${cliVersion} speaks protocol ${CLI_PROTOCOL} and ${framework.name ?? "the framework"} ${framework.version ?? ""} at ${framework.root} speaks protocol ${framework.protocol}; install matching versions`;
}
