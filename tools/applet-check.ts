// tools/applet-check.ts — the source and bundle rules of a Pocket Applet
// (docs/APPLETS.md lists them; contracts/spec/applet.ts holds the lists).
//
//   bun tools/applet-check.ts <pocket.json> [--project-root=<dir>] [--js=<bundle> --pak=<pak>]
//
// It walks the import graph from the entry (comments and types removed by
// Bun's transpiler), checks every module the applet ships, and checks the
// built guest and pak against the size budgets. tools/build.ts runs it for a
// plan that carries `applet`.

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import {
  APPLET_BUDGET,
  APPLET_GATED_MODULES,
  APPLET_MODULES,
  APPLET_PACKAGES,
  APPLET_SYSTEM_LINK_EXPORTS,
  appletManifestDiagnostics,
  capabilityMatches,
  type AppletDeclaration,
  type ContractDiagnostic,
} from "../contracts/spec/applet.ts";
import type { PocketManifestV2 } from "../contracts/spec/pocket-manifest.ts";
import { validatePocketManifest } from "../framework/src/manifest/validate.ts";
import { readPocketManifest } from "../framework/src/manifest/load.ts";

export interface AppletSourceInput {
  /** The directory manifest entries are relative to. */
  projectRoot: string;
  /** The applet's entry, relative to projectRoot. */
  entry: string;
  applet: AppletDeclaration;
  /** Capability ids the manifest declares (required or enhanced). */
  capabilities: readonly string[];
}

const transpilers = {
  ts: new Bun.Transpiler({ loader: "ts" }),
  tsx: new Bun.Transpiler({ loader: "tsx", tsconfig: { compilerOptions: { jsx: "preserve" } } }),
};
const EXTENSIONS = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];

function resolveModule(from: string, specifier: string): string | null {
  const base = resolve(dirname(from), specifier);
  for (const extension of EXTENSIONS) {
    const path = base + extension;
    if (existsSync(path) && statSync(path).isFile()) return path;
  }
  return null;
}

/** The modules an applet ships, from its entry, with their code. */
function moduleGraph(input: AppletSourceInput, out: ContractDiagnostic[]): Map<string, string> {
  const root = resolve(input.projectRoot);
  const modules = new Map<string, string>();
  const queue = [resolve(root, input.entry)];
  const show = (path: string) => relative(root, path);
  while (queue.length > 0) {
    const path = queue.shift()!;
    if (modules.has(path)) continue;
    let source: string;
    try {
      source = readFileSync(path, "utf8");
    } catch {
      out.push({ code: "applet.missingModule", path: show(path), message: "module not found" });
      continue;
    }
    const transpiler = path.endsWith(".tsx") ? transpilers.tsx : transpilers.ts;
    const code = transpiler.transformSync(source);
    modules.set(path, code);
    for (const entry of transpiler.scanImports(source)) {
      const specifier = entry.path;
      // The transpiler adds a JSX runtime import the source never names;
      // the PocketJS build compiles JSX to Solid.
      if (!source.includes(`"${specifier}"`) && !source.includes(`'${specifier}'`)) continue;
      if (entry.kind === "dynamic-import") {
        out.push({ code: "applet.dynamicImport", path: show(path), message: `dynamic import of ${specifier}: an applet's code is its bundle` });
        continue;
      }
      if (specifier.startsWith(".")) {
        const target = resolveModule(path, specifier);
        if (!target) {
          out.push({ code: "applet.missingModule", path: show(path), message: `cannot resolve ${specifier}` });
        } else if (relative(root, target).startsWith("..") || isAbsolute(relative(root, target))) {
          out.push({ code: "applet.outsideProject", path: show(path), message: `${specifier} is outside the project root` });
        } else {
          queue.push(target);
        }
        continue;
      }
      const framework = specifier.match(/^@pocketjs\/framework(?:\/(.+))?$/);
      if (framework) {
        const module = framework[1] ?? "solid";
        const gate = APPLET_GATED_MODULES[module];
        const allowed = (APPLET_MODULES as readonly string[]).includes(module) ||
          (gate !== undefined && input.capabilities.some((id) => gate.some((pattern) => capabilityMatches(id, pattern))));
        if (!allowed) {
          out.push({
            code: "applet.module",
            path: show(path),
            message: gate
              ? `@pocketjs/framework/${module} needs the ${gate.join(" or ")} capability`
              : `@pocketjs/framework/${module} is not available to applets`,
          });
        }
        continue;
      }
      if (!(APPLET_PACKAGES as readonly string[]).includes(specifier)) {
        out.push({ code: "applet.package", path: show(path), message: `${specifier}: an applet imports PocketJS and Solid only` });
      }
    }
  }
  return modules;
}

/** The source rules. */
export function checkAppletSources(input: AppletSourceInput): ContractDiagnostic[] {
  const out: ContractDiagnostic[] = [];
  const root = resolve(input.projectRoot);
  const modules = moduleGraph(input, out);
  let surface = false;
  for (const [path, code] of modules) {
    const at = relative(root, path);
    if (/\beval\s*\(/.test(code)) out.push({ code: "applet.eval", path: at, message: "eval: an applet evaluates no code" });
    if (/\bnew\s+Function\s*\(|(?<![.\w$])Function\s*\(/.test(code)) {
      out.push({ code: "applet.eval", path: at, message: "Function constructor: an applet evaluates no code" });
    }
    for (const match of code.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']@pocketjs\/framework\/link["']/g)) {
      for (const name of match[1]!.split(",").map((part) => part.trim().split(/\s+as\s+/)[0]!)) {
        if ((APPLET_SYSTEM_LINK_EXPORTS as readonly string[]).includes(name)) {
          out.push({ code: "applet.system", path: at, message: `${name} acts for the launcher, not an applet` });
        }
      }
    }
    if (/\b(?:AuxiliarySurface|AppletSurface)\b/.test(code)) surface = true;
  }
  if (!surface) {
    out.push({ code: "applet.surface", path: input.entry, message: "an applet draws its UI inside AppletSurface (or AuxiliarySurface)" });
  }
  return out;
}

/** The bundle rules: the size budgets. */
export function checkAppletBundle(sizes: { jsBytes: number; pakBytes?: number }): ContractDiagnostic[] {
  const out: ContractDiagnostic[] = [];
  if (sizes.jsBytes > APPLET_BUDGET.jsBytes) {
    out.push({ code: "applet.budget", path: "bundle", message: `the guest bundle is ${sizes.jsBytes} bytes; the budget is ${APPLET_BUDGET.jsBytes}` });
  }
  if (sizes.pakBytes !== undefined && sizes.pakBytes > APPLET_BUDGET.pakBytes) {
    out.push({ code: "applet.budget", path: "pak", message: `the pak is ${sizes.pakBytes} bytes; the budget is ${APPLET_BUDGET.pakBytes}` });
  }
  return out;
}

/** Every rule for a manifest file: schema, manifest rules, sources and,
 *  when given, the built bundle. A manifest without `applet` passes. */
export function checkApplet(options: { manifestPath: string; projectRoot?: string; js?: string; pak?: string }): ContractDiagnostic[] {
  const raw: unknown = readPocketManifest(options.manifestPath).manifest;
  const validated = validatePocketManifest(raw);
  if (!validated.ok) return [...validated.diagnostics];
  const manifest: PocketManifestV2 = validated.value;
  if (!manifest.applet) return [];
  const out = appletManifestDiagnostics(manifest);
  const capabilities = [...manifest.engine.capabilities.requires, ...(manifest.engine.capabilities.enhances ?? [])];
  out.push(...checkAppletSources({
    projectRoot: options.projectRoot ?? dirname(options.manifestPath),
    entry: manifest.app.entry,
    applet: manifest.applet,
    capabilities,
  }));
  if (options.js) {
    out.push(...checkAppletBundle({
      jsBytes: statSync(options.js).size,
      ...(options.pak && existsSync(options.pak) ? { pakBytes: statSync(options.pak).size } : {}),
    }));
  }
  return out;
}

export function formatAppletDiagnostics(name: string, diagnostics: readonly ContractDiagnostic[]): string {
  return diagnostics.map((d) => `${name}: ${d.code} at ${d.path}: ${d.message}`).join("\n");
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const manifestPath = args.find((arg) => !arg.startsWith("--"));
  const flag = (name: string) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  if (!manifestPath) {
    console.error("usage: bun tools/applet-check.ts <pocket.json> [--project-root=<dir>] [--js=<bundle> --pak=<pak>]");
    process.exit(2);
  }
  const diagnostics = checkApplet({
    manifestPath: resolve(manifestPath),
    ...(flag("project-root") ? { projectRoot: resolve(flag("project-root")!) } : {}),
    ...(flag("js") ? { js: resolve(flag("js")!) } : {}),
    ...(flag("pak") ? { pak: resolve(flag("pak")!) } : {}),
  });
  if (diagnostics.length > 0) {
    console.error(formatAppletDiagnostics(manifestPath, diagnostics));
    process.exit(1);
  }
  console.log(`${manifestPath}: applet rules pass`);
}
