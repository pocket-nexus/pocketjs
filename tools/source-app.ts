import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { AnimationTheme, PocketManifestV2 } from "../contracts/spec/pocket-manifest.ts";
import { expandThemeReference } from "../framework/src/manifest/load.ts";

/** Application content with theme content in place of a module reference. */
export type SourceAppContent = Omit<PocketManifestV2["app"], "theme"> & { theme?: AnimationTheme };

/** Source lookup shared by the low-level compiler and native program wrappers. */
export function resolveSourceEntry(arg: string, frameworkRoot: string, cwd = process.cwd()): string {
  const normalized = arg.replace(/\\/g, "/").replace(/\.tsx?$/, "");
  const bare = normalized.includes("/") ? normalized.slice(normalized.lastIndexOf("/") + 1) : normalized;
  const isBareName = !arg.includes("/") && !arg.startsWith(".");
  const demoRel = normalized.replace(/^.*?apps\//, "");
  const demoName = demoRel.endsWith("/main") ? demoRel.slice(0, -5)
    : demoRel.endsWith("/app") ? demoRel.slice(0, -4)
    : bare.endsWith("-main") ? bare.slice(0, -5) : bare;
  const wantsMain = demoRel.endsWith("/main") || bare.endsWith("-main");
  const tries = [
    resolve(cwd, arg), resolve(frameworkRoot, arg),
    wantsMain ? resolve(frameworkRoot, "apps", demoName, "main.tsx") : "",
    wantsMain ? resolve(frameworkRoot, "apps", demoName, "main.ts") : "",
    !wantsMain ? resolve(frameworkRoot, "apps", demoName, "app.tsx") : "",
    isBareName && !wantsMain ? resolve(frameworkRoot, "apps", demoName, "main.tsx") : "",
    isBareName && !wantsMain ? resolve(frameworkRoot, "apps", demoName, "main.ts") : "",
    resolve(frameworkRoot, "apps", arg),
    resolve(frameworkRoot, "apps", arg + ".tsx"),
    resolve(frameworkRoot, "apps", arg + ".ts"),
  ].filter(Boolean);
  for (const path of tries) {
    if (/\.tsx?$/.test(path) && existsSync(path) && statSync(path).isFile()) return path;
  }
  throw new Error(`PocketJS build: cannot resolve app "${arg}" (tried:\n  ${tries.join("\n  ")})`);
}

/** Native demo commands mount their main module; explicit file paths stay explicit. */
export function mountedSourceApp(arg: string, frameworkRoot: string): string {
  if (arg.includes("/") || arg.startsWith(".")) return arg;
  const bare = arg.replace(/\.tsx?$/, "").replace(/-main$/, "");
  return ["main.tsx", "main.ts"].some(file => existsSync(resolve(frameworkRoot, "apps", bare, file)))
    || [".tsx", ".ts"].some(extension => existsSync(resolve(frameworkRoot, "apps", bare + "-main" + extension)))
    ? `${bare}-main` : arg;
}

export function sourceAppContent(entry: string, options: {
  frameworkRoot: string;
  projectRoot: string;
  onRead?: (path: string) => void;
  onAppRoot?: (path: string) => void;
}): Partial<SourceAppContent> & { domains?: PocketManifestV2["domains"] } {
  let directory = dirname(resolve(entry));
  while (!existsSync(join(directory, "pocket.json"))) {
    if (dirname(directory) === directory) return {};
    directory = dirname(directory);
  }
  const candidates = readdirSync(directory).filter(name => /^pocket(?:\.[^.]+)?\.json$/.test(name)).map(name => {
    const path = join(directory, name);
    options.onRead?.(path);
    const expanded = expandThemeReference(JSON.parse(readFileSync(path, "utf8")), path);
    expanded.inputs.forEach(input => options.onRead?.(input));
    const manifest = expanded.manifest as { app: SourceAppContent; domains?: PocketManifestV2["domains"] };
    return { path, app: manifest.app, domains: manifest.domains };
  });
  const matches = candidates.flatMap(candidate => {
    const base = candidate.app?.entry && [options.projectRoot, directory, options.frameworkRoot]
      .find(base => resolve(base, candidate.app.entry) === entry);
    return base ? [{ ...candidate, base }] : [];
  });
  if (new Set(matches.map(({ app, domains }) => JSON.stringify([app.framework, app.theme, domains?.worker]))).size > 1) {
    throw new Error("PocketJS build: manifests disagree on application content; pass a ResolvedBuildPlan");
  }
  const selected = matches[0] ?? candidates.find(({ path }) => path === join(directory, "pocket.json"));
  if (selected) options.onAppRoot?.("base" in selected ? selected.base : directory);
  return selected ? { ...selected.app, ...(selected.domains ? { domains: selected.domains } : {}) } : {};
}

export function sourceOutputName(file: string, frameworkRoot: string): string {
  const normalizedFile = file.replace(/\\/g, "/"), normalizedRoot = frameworkRoot.replace(/\\/g, "/");
  const prefix = normalizedRoot.endsWith("/") ? normalizedRoot : normalizedRoot + "/";
  const relative = normalizedFile.startsWith(prefix) ? normalizedFile.slice(prefix.length) : normalizedFile;
  const demo = relative.match(/^apps\/([^/]+)\/(app|main)\.tsx?$/);
  if (demo) return demo[2] === "main" ? `${demo[1]}-main` : demo[1]!;
  return normalizedFile.split("/").pop()!.replace(/\.tsx?$/, "");
}
