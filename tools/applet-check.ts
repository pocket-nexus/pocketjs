// tools/applet-check.ts — the source and bundle rules of a Pocket Applet
// (contracts/spec/applet.ts, docs/APPLETS.md).
//
//   bun tools/applet-check.ts <pocket.json> [--project-root=<dir>] [--js=<bundle> --pak=<pak>]
//
// The manifest rules run at plan resolution; this file adds the rules that
// need the applet's code. It walks the import graph from the entry (comments
// and types removed by Bun's transpiler) and checks every module the applet
// ships:
//
//   - imports: relative modules inside the project root, PocketJS modules on
//     the applet list (camera, fs and db only with their capability), Solid;
//     no dynamic import, no other package;
//   - no code evaluation (eval, Function);
//   - no launcher work through @pocketjs/framework/link (install, remove,
//     pair, catalog);
//   - every URL host and companion service the code names is declared;
//   - the UI draws on AuxiliarySurface.
//
// The bundle rules check the built guest and pak against the size budgets.
// tools/build.ts runs both for a plan that carries `applet`.

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import {
  APPLET_BUDGET,
  APPLET_GATED_MODULES,
  APPLET_MODULES,
  APPLET_PACKAGES,
  APPLET_SYSTEM_LINK_EXPORTS,
  appletManifestDiagnostics,
  type AppletDeclaration,
  type AppletDiagnostic,
} from "../contracts/spec/applet.ts";
import { LINK_SERVICES_HOST } from "../contracts/spec/link.ts";
import type { PocketManifestV2 } from "../contracts/spec/pocket-manifest.ts";
import { validatePocketManifest } from "../framework/src/manifest/validate.ts";

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
function moduleGraph(input: AppletSourceInput, out: AppletDiagnostic[]): Map<string, string> {
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
          (gate !== undefined && input.capabilities.some((id) => gate.some((prefix) => id === prefix || (prefix.endsWith(".") && id.startsWith(prefix)))));
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
export function checkAppletSources(input: AppletSourceInput): AppletDiagnostic[] {
  const out: AppletDiagnostic[] = [];
  const root = resolve(input.projectRoot);
  const modules = moduleGraph(input, out);
  const services = new Set(input.applet.services ?? []);
  const hosts = new Set(input.applet.hosts ?? []);
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
    for (const match of code.matchAll(/companionService\(\s*([^,)]+)/g)) {
      const literal = match[1]!.trim().match(/^["'`]([a-z][a-z0-9-]*)["'`]$/);
      if (!literal) {
        out.push({ code: "applet.service", path: at, message: "companionService takes its service name as a string literal" });
      } else if (!services.has(literal[1]!)) {
        out.push({ code: "applet.service", path: at, message: `companion service ${literal[1]} is not in applet.services` });
      }
    }
    for (const match of code.matchAll(/https?:\/\/([a-z0-9.-]+)(\/[a-z0-9-]*)?/gi)) {
      const host = match[1]!.toLowerCase();
      if (host === LINK_SERVICES_HOST) {
        const name = match[2]?.slice(1);
        if (name && !services.has(name)) {
          out.push({ code: "applet.service", path: at, message: `companion service ${name} is not in applet.services` });
        }
      } else if (!hosts.has(host)) {
        out.push({ code: "applet.host", path: at, message: `${host} is not in applet.hosts` });
      }
    }
    if (/\bAuxiliarySurface\b/.test(code)) surface = true;
  }
  if (!surface) {
    out.push({ code: "applet.surface", path: input.entry, message: "an applet draws its UI inside AuxiliarySurface" });
  }
  return out;
}

/** The bundle rules: the size budgets. */
export function checkAppletBundle(sizes: { jsBytes: number; pakBytes?: number }): AppletDiagnostic[] {
  const out: AppletDiagnostic[] = [];
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
export function checkApplet(options: { manifestPath: string; projectRoot?: string; js?: string; pak?: string }): AppletDiagnostic[] {
  const raw = JSON.parse(readFileSync(options.manifestPath, "utf8")) as unknown;
  const validated = validatePocketManifest(raw);
  if (!validated.ok) return validated.diagnostics.map((d) => ({ ...d }));
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

export function formatAppletDiagnostics(name: string, diagnostics: readonly AppletDiagnostic[]): string {
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
