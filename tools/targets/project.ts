// tools/targets/project.ts — the project configuration: the nearest
// pocket.config.ts above the manifest's directory, and its `targets`.
//
// The lookup starts at the manifest's directory, where tools/build.ts reads
// the same file's `theme`, and stops at the first pocket.config.ts. A file
// without `targets` names no project default. `manifest` and `hostProfile`
// entries resolve against the file's directory.
//
// The file is bundled with `@pocketjs/framework` mapped to this framework, so
// it evaluates when the framework comes from POCKETJS_FRAMEWORK_ROOT and the
// project has no node_modules.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BunPlugin } from "bun";
import type { PocketConfig, PocketConfigTarget } from "../../framework/src/config.ts";
import { validatePocketIdfHostProfile } from "../../framework/src/manifest/idf-host.ts";
import { CATALOG, COMMAND_WORDS, catalogEntry } from "./index.ts";

const FRAMEWORK_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

export interface ProjectTarget {
  /** A catalog id, or a host profile's id. */
  readonly id: string;
  /** Absolute path of the manifest this target builds, when the entry names one. */
  readonly manifest?: string;
  /** Absolute path of the ESP-IDF host profile, for a host-profile entry. */
  readonly hostProfile?: string;
}

export interface ProjectConfiguration {
  /** The configuration file, or null when no pocket.config.ts lies above. */
  readonly config: string | null;
  readonly targets: readonly ProjectTarget[];
}

export type ProjectResult =
  | { readonly ok: true; readonly project: ProjectConfiguration }
  | { readonly ok: false; readonly diagnostics: readonly string[] };

export function findProjectConfig(from: string): string | null {
  for (let directory = resolve(from); ; directory = dirname(directory)) {
    const candidate = join(directory, "pocket.config.ts");
    if (existsSync(candidate)) return candidate;
    if (dirname(directory) === directory) return null;
  }
}

/** The framework file a `@pocketjs/framework[/subpath]` specifier names, from
 *  the framework's package.json `exports`. */
function frameworkFile(specifier: string): string | null {
  const exports = JSON.parse(readFileSync(join(FRAMEWORK_ROOT, "package.json"), "utf8")).exports ?? {};
  const key = specifier === "@pocketjs/framework" ? "." : `./${specifier.slice("@pocketjs/framework/".length)}`;
  const entry = exports[key];
  const target = typeof entry === "string" ? entry : entry?.default;
  return typeof target === "string" ? join(FRAMEWORK_ROOT, target) : null;
}

const frameworkSpecifiers: BunPlugin = {
  name: "pocketjs-framework-specifiers",
  setup(build) {
    build.onResolve({ filter: /^@pocketjs\/framework(?:\/.*)?$/ }, (args) => {
      const path = frameworkFile(args.path);
      return path ? { path } : undefined;
    });
  },
};

async function evaluateConfig(path: string): Promise<PocketConfig> {
  const bundle = await Bun.build({ entrypoints: [path], target: "bun", format: "esm", plugins: [frameworkSpecifiers] });
  if (!bundle.success) throw new AggregateError(bundle.logs, `${path} does not bundle`);
  const code = await bundle.outputs[0]!.text();
  const module = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
  return (module.default ?? module.config ?? {}) as PocketConfig;
}

function entryTarget(entry: PocketConfigTarget): { target?: string; hostProfile?: string; manifest?: string } {
  return typeof entry === "string" ? { target: entry } : entry;
}

/** The project configuration for a manifest in `manifestDirectory`. */
export async function loadProject(manifestDirectory: string): Promise<ProjectResult> {
  const config = findProjectConfig(manifestDirectory);
  if (!config) return { ok: true, project: { config: null, targets: [] } };
  let loaded: PocketConfig;
  try {
    loaded = await evaluateConfig(config);
  } catch (error) {
    return { ok: false, diagnostics: [`${config}: ${error instanceof Error ? error.message : String(error)}`] };
  }
  const base = dirname(config);
  const diagnostics: string[] = [];
  const targets: ProjectTarget[] = [];
  for (const [index, raw] of (loaded.targets ?? []).entries()) {
    const entry = entryTarget(raw);
    const where = `${config}: targets[${index}]`;
    const manifest = entry.manifest ? resolve(base, entry.manifest) : undefined;
    if (entry.target !== undefined) {
      if (!catalogEntry(entry.target)) {
        diagnostics.push(`${where}: unknown target ${entry.target}; targets: ${CATALOG.map((descriptor) => descriptor.id).join(", ")}`);
        continue;
      }
      targets.push({ id: entry.target, ...(manifest ? { manifest } : {}) });
      continue;
    }
    if (entry.hostProfile === undefined) {
      diagnostics.push(`${where}: an entry names a catalog id, { target }, or { hostProfile }`);
      continue;
    }
    const hostProfile = resolve(base, entry.hostProfile);
    if (!existsSync(hostProfile)) {
      diagnostics.push(`${where}: host profile not found: ${hostProfile}`);
      continue;
    }
    const validated = validatePocketIdfHostProfile(JSON.parse(readFileSync(hostProfile, "utf8")));
    if (!validated.ok) {
      diagnostics.push(`${where}: ${hostProfile}: ${validated.diagnostics.map((item) => item.message).join("; ")}`);
      continue;
    }
    const id = validated.value.id;
    if (catalogEntry(id) || COMMAND_WORDS.includes(id)) {
      diagnostics.push(`${where}: host profile id ${id} is a catalog id or a pocket command word; rename it`);
      continue;
    }
    targets.push({ id, hostProfile, ...(manifest ? { manifest } : {}) });
  }
  const seen = new Set<string>();
  for (const target of targets) {
    if (seen.has(target.id)) diagnostics.push(`${config}: target ${target.id} is listed twice`);
    seen.add(target.id);
  }
  return diagnostics.length > 0 ? { ok: false, diagnostics } : { ok: true, project: { config, targets } };
}
