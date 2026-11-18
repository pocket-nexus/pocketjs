// Applications the tests resolve and compile: a small portable `app` section,
// the repository's application configs, and the model settings the AOT
// fixtures register for the MicroTS frontends.
import { existsSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { AppConfig } from "../contracts/spec/app-config.ts";
import type { PlatformContractRegistry } from "../contracts/spec/platforms.ts";
import { resolveAppPlan, type ResolutionResult } from "../framework/compiler/app-plan.ts";
import { registerApplication, type ApplicationSettings } from "../microts/compiler/aot-model-config.ts";
import { loadHostConfig, profileRegistry, type LoadedHostConfig } from "../tools/profile-resolver.ts";
import { registerSourceApplication } from "../tools/source-app.ts";

export const ROOT = resolve(import.meta.dir, "..");

/** A portable application: the PSP's 480x272 viewport, buttons, the left
 *  stick and baked glyphs. Entries are relative to a config directory. */
export const PORTABLE_APP = {
  id: "dev.pocket-nexus.telemetry",
  title: "Pocket Telemetry",
  version: "0.1.0",
  entry: "app/main.tsx",
  framework: "solid",
  viewport: { logical: [480, 272], presentation: "integer-fit" },
  features: ["text.glyphs.baked", "input.analog.left", "input.buttons"],
} as const satisfies AppConfig;

/** A mutable copy of PORTABLE_APP for a test to change. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const portableApp = (): any => structuredClone(PORTABLE_APP);

/** Every application config the repository ships: apps/<name>/ and the
 *  second build of a name in a subdirectory (apps/nexus-touch/e7/). */
export function repositoryAppConfigs(): string[] {
  const apps = resolve(ROOT, "apps");
  return readdirSync(apps).sort().flatMap(name => [
    resolve(apps, name, "pocket.host.config.ts"),
    ...readdirSync(resolve(apps, name), { withFileTypes: true }).filter(entry => entry.isDirectory())
      .map(entry => resolve(apps, name, entry.name, "pocket.host.config.ts")),
  ]).filter(path => existsSync(path));
}

export interface RepositoryApp {
  readonly config: LoadedHostConfig;
  readonly app: AppConfig;
  readonly configDirectory: string;
}

/** The host config at `path` (relative to the repository) and its app section. */
export async function repositoryApp(path: string): Promise<RepositoryApp> {
  const config = await loadHostConfig(resolve(ROOT, path));
  if (!config.value.app) throw new Error(`${path} has no app section`);
  return { config, app: config.value.app, configDirectory: dirname(config.path) };
}

/** Resolve a repository application for one host, entries relative to the
 *  repository root as the in-repository tools compile them. The registry
 *  defaults to the host the config lists under that id. */
export function resolveRepositoryApp(application: RepositoryApp, target: string, options: {
  app?: AppConfig; registry?: PlatformContractRegistry; executionClass?: "guest" | "aot";
} = {}): ResolutionResult {
  const index = application.config.profiles.findIndex(profile => profile.id === target);
  const registry = options.registry ?? (index >= 0 ? profileRegistry(application.config.profiles[index]!) : undefined);
  return resolveAppPlan(options.app ?? application.app, {
    target, configDirectory: application.configDirectory, projectRoot: ROOT,
    ...(options.executionClass ? { executionClass: options.executionClass } : {}),
  }, registry);
}

/** Register apps/<name> from its host config for the MicroTS frontends, as
 *  a build driver does before compiling it. */
export async function registerRepositoryApp(name: string): Promise<void> {
  const application = await registerSourceApplication(resolve(ROOT, "apps", name, "pocket.host.config.ts"));
  if (!application) throw new Error(`apps/${name} has no application config`);
}

/** Register a compiled-model fixture directory for the MicroTS frontends,
 *  as a host config's app section would. */
export function registerModelFixture(directory: string, settings: Partial<Omit<ApplicationSettings, "directory">> = {}) {
  return registerApplication({ directory, framework: "solid", aot: true, model: "compiled", entry: "App.tsx", ...settings });
}
