// Source applications for the low-level compiler (tools/build.ts without a
// plan) and the native program wrappers: entry lookup, the host config an
// entry belongs to, and the registration of application settings the AOT
// frontends consult (microts/compiler/aot-model-config.ts).
import { existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { AppConfig } from "../contracts/spec/app-config.ts";
import { registerApplication, registeredApplication } from "../microts/compiler/aot-model-config.ts";
import { findHostConfig, loadHostConfig } from "./profile-resolver.ts";

/** The application a source file belongs to: the nearest host config above it
 *  and its `app` section. */
export interface SourceApplication {
  readonly configPath: string;
  readonly directory: string;
  readonly app: AppConfig;
  /** The config module and every file it imports (its theme, for example). */
  readonly dependencies: readonly string[];
}

const configs = new Map<string, Promise<SourceApplication | undefined>>();

/** The application whose host config is nearest above `file`; undefined when
 *  that config has no `app` section or there is none. */
export function sourceApplication(file: string): Promise<SourceApplication | undefined> {
  const path = findHostConfig(dirname(resolve(file)));
  if (!path) return Promise.resolve(undefined);
  let loaded = configs.get(path);
  if (!loaded) {
    loaded = loadHostConfig(path).then(config => config.value.app
      ? { configPath: path, directory: dirname(path), app: config.value.app, dependencies: config.dependencies }
      : undefined);
    configs.set(path, loaded);
  }
  return loaded;
}

/** Register an application's model settings for the AOT frontends. */
export function registerAppSettings(directory: string, app: Pick<AppConfig, "aot" | "model" | "recursionLimit" | "framework" | "entry">) {
  return registerApplication({ directory, aot: app.aot, model: app.model, recursionLimit: app.recursionLimit, framework: app.framework, entry: app.entry });
}

/** Register the application `file` belongs to, once, unless its directory is
 *  registered already. Sources one application imports from another are
 *  compiled with the settings of the application they belong to. */
export async function registerSourceApplication(file: string): Promise<SourceApplication | undefined> {
  const application = await sourceApplication(file);
  if (application && !registeredApplication(application.directory)) registerAppSettings(application.directory, application.app);
  return application;
}

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


export function sourceOutputName(file: string, frameworkRoot: string): string {
  const normalizedFile = file.replace(/\\/g, "/"), normalizedRoot = frameworkRoot.replace(/\\/g, "/");
  const prefix = normalizedRoot.endsWith("/") ? normalizedRoot : normalizedRoot + "/";
  const relative = normalizedFile.startsWith(prefix) ? normalizedFile.slice(prefix.length) : normalizedFile;
  const demo = relative.match(/^apps\/([^/]+)\/(app|main)\.tsx?$/);
  if (demo) return demo[2] === "main" ? `${demo[1]}-main` : demo[1]!;
  return normalizedFile.split("/").pop()!.replace(/\.tsx?$/, "");
}
