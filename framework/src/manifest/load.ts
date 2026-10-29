//! Reads a pocket.json from disk and resolves its `app.theme` module
//! reference, so that resolution, packaging and native build inputs hold
//! theme content only.
import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { animationThemeSchema, pocketManifestV2Schema, type AnimationTheme } from "../../../contracts/spec/pocket-manifest.ts";
import { validateSchema, type ContractDiagnostic } from "./schema.ts";

export interface LoadedManifest {
  /** The manifest, with `app.theme` holding content. */
  readonly manifest: unknown;
  /** The PNG `icon` names, read by `readAuthoredManifest`. */
  readonly icon?: Uint8Array;
  /** The manifest file and, for a theme module reference, the module and every relative import it reaches. */
  readonly inputs: readonly string[];
  /** The bytes a package embeds: the file as written, or the manifest with its theme reference replaced. */
  readonly embedded: Uint8Array;
}

/** Read a manifest file and load the module `app.theme` names, if any. */
export function readPocketManifest(path: string): LoadedManifest {
  const absolute = resolve(path);
  const bytes = readFileSync(absolute);
  const expanded = expandThemeReference(JSON.parse(bytes.toString("utf8")), absolute);
  return {
    manifest: expanded.manifest,
    inputs: [absolute, ...expanded.inputs],
    embedded: expanded.inputs.length === 0
      ? new Uint8Array(bytes)
      : new TextEncoder().encode(JSON.stringify(expanded.manifest, null, 2) + "\n"),
  };
}

/**
 * Read a manifest an author wrote: the file must satisfy the published
 * schema (contracts/schema/pocket-2.json), which takes `app.theme` as a path
 * only. Files a package or a tool wrote in the loaded form are read with
 * `readPocketManifest`.
 */
export function readAuthoredManifest(path: string): LoadedManifest {
  const absolute = resolve(path);
  const raw = JSON.parse(readFileSync(absolute, "utf8")) as { icon?: string };
  const diagnostics: ContractDiagnostic[] = [];
  validateSchema(raw, pocketManifestV2Schema, "", diagnostics);
  if (diagnostics.length) {
    throw new Error(`${absolute}: ${diagnostics.map(item => `${item.code} ${item.path || "/"}: ${item.message}`).join("; ")}`);
  }
  const loaded = readPocketManifest(absolute);
  if (raw.icon === undefined) return loaded;
  const iconPath = resolve(dirname(absolute), raw.icon);
  if (!existsSync(iconPath) || !statSync(iconPath).isFile()) throw new Error(`icon names ${iconPath}, which is not a file`);
  const icon = new Uint8Array(readFileSync(iconPath));
  const view = new DataView(icon.buffer, icon.byteOffset, icon.byteLength);
  const png = icon.length >= 24 && PNG_SIGNATURE.every((byte, index) => icon[index] === byte);
  if (!png || view.getUint32(16) !== view.getUint32(20) || view.getUint32(16) === 0) {
    throw new Error(`${iconPath}: icon must be a square PNG`);
  }
  return { ...loaded, icon, inputs: [...loaded.inputs, iconPath] };
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Replace a string `app.theme` with the default export of the module it
 * names, relative to `manifestPath`. A `.json` path is parsed; any other path
 * is loaded as a module. The export is validated as an `AnimationTheme` and
 * copied as JSON. `inputs` lists the module and its relative imports; it is
 * empty when `app.theme` already holds content.
 */
export function expandThemeReference(manifest: unknown, manifestPath: string): { manifest: unknown; inputs: string[] } {
  const app = (manifest as { app?: { theme?: unknown } } | null)?.app;
  if (!app || typeof app.theme !== "string") return { manifest, inputs: [] };
  const module = resolve(dirname(resolve(manifestPath)), app.theme);
  if (!existsSync(module) || !statSync(module).isFile()) throw new Error(`app.theme names ${module}, which is not a file`);
  const theme = JSON.parse(JSON.stringify(module.endsWith(".json") ? JSON.parse(readFileSync(module, "utf8")) : defaultExport(module))) as AnimationTheme;
  const diagnostics: ContractDiagnostic[] = [];
  validateSchema(theme, animationThemeSchema, "/app/theme", diagnostics);
  if (diagnostics.length) {
    throw new Error(`${module}: ${diagnostics.map(item => `${item.path}: ${item.message}`).join("; ")}`);
  }
  return {
    manifest: { ...(manifest as object), app: { ...app, theme } },
    inputs: module.endsWith(".json") ? [module] : [module, ...relativeImports(module)],
  };
}

/** The default export of a TypeScript or JavaScript module. */
function defaultExport(module: string): unknown {
  const namespace: unknown = createRequire(pathToFileURL(module))(module);
  if (namespace === null || typeof namespace !== "object" || !("default" in namespace)) {
    throw new Error(`${module} has no default export; app.theme needs an AnimationTheme`);
  }
  return namespace.default;
}

/** Every file a module reaches through relative imports, depth first. */
function relativeImports(module: string): string[] {
  const ts = createRequire(import.meta.url)("typescript") as typeof import("typescript");
  const visited = new Set<string>();
  const visit = (file: string) => {
    for (const { fileName } of ts.preProcessFile(readFileSync(file, "utf8"), true, true).importedFiles) {
      if (!fileName.startsWith(".")) continue;
      const base = resolve(dirname(file), fileName);
      const found = [base, ...[".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", "/index.ts"].map(extension => base + extension)]
        .find(path => existsSync(path) && statSync(path).isFile());
      if (!found) throw new Error(`cannot resolve ${fileName} imported by ${file}`);
      if (visited.has(found)) continue;
      visited.add(found);
      if (!found.endsWith(".json")) visit(found);
    }
  };
  visit(module);
  return [...visited];
}
