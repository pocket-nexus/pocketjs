// Application settings the AOT frontends and model lowering consult: the
// execution class (`aot`), the model mode, the recursion limit, the framework,
// the entry module, and the animation theme and tick rate class literals bake
// with. The compiler reads no file to find them. The build driver registers
// each application before compiling it: tools/build.ts and `pocket compile`
// from the host config or the build plan, the browser builds and the tests
// from their own data. A lookup walks up from a source file to the nearest
// registered application directory.
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import type { AnimationTheme } from "../../contracts/spec/animation-theme.ts";

export interface ApplicationSettings {
  /** The application directory; every file below it belongs to the application. */
  readonly directory: string;
  readonly aot?: boolean;
  readonly model?: "rust" | "compiled";
  readonly recursionLimit?: number;
  readonly framework?: string;
  /** The entry module: absolute, or relative to `directory`. */
  readonly entry?: string;
  /** The `app.theme` animations class literals resolve against. */
  readonly theme?: AnimationTheme;
  /** The tick rate keyframe timelines bake at; absent, 60. */
  readonly tickHz?: number;
}

export interface ModelConfiguration {
  readonly mode: "rust" | "compiled";
  readonly recursionLimit: number;
  readonly aot?: boolean;
  readonly directory?: string;
  readonly framework?: string;
  /** Absolute path of the entry module. */
  readonly entry?: string;
  readonly theme?: AnimationTheme;
  readonly tickHz: number;
}

/** Applications by the real path of their directory: a directory reached
 *  through a symbolic link and its target are one application. */
const applications = new Map<string, ModelConfiguration>();

/** `path` with the symbolic links of its existing prefix resolved. */
function realPath(path: string): string {
  const absolute = resolve(path);
  if (existsSync(absolute)) return realpathSync(absolute);
  const parent = dirname(absolute);
  return parent === absolute ? absolute : resolve(realPath(parent), basename(absolute));
}

/** Register (or replace) the settings of the application at `settings.directory`. */
export function registerApplication(settings: ApplicationSettings): ModelConfiguration {
  const directory = resolve(settings.directory);
  const mode = settings.model ?? "rust", recursionLimit = settings.recursionLimit ?? 256, tickHz = settings.tickHz ?? 60;
  if (mode !== "rust" && mode !== "compiled") throw new Error(`${directory}: app.model must be rust or compiled`);
  if (!Number.isInteger(recursionLimit) || recursionLimit < 1) throw new Error(`${directory}: app.recursionLimit must be a positive integer`);
  if (!Number.isInteger(tickHz) || tickHz < 1 || tickHz > 240) throw new Error(`${directory}: the tick rate must be an integer from 1 through 240`);
  if (mode === "compiled" && settings.aot !== true) throw new Error(`${directory}: app.model = compiled requires app.aot = true`);
  const configuration: ModelConfiguration = {
    mode, recursionLimit, tickHz, aot: settings.aot === true, directory,
    ...(settings.framework !== undefined ? { framework: settings.framework } : {}),
    ...(settings.entry !== undefined ? { entry: resolve(directory, settings.entry) } : {}),
    ...(settings.theme !== undefined ? { theme: settings.theme } : {}),
  };
  applications.set(realPath(directory), configuration);
  return configuration;
}

/** Set the animation theme and tick rate of the application registered at
 *  `directory`. A build whose style table bakes with other values than the
 *  application's config states (a low-level build's --hz) passes its own, so
 *  AOT admission bakes the class literals the same way. */
export function setApplicationAnimation(directory: string, animation: { theme?: AnimationTheme; tickHz: number }): ModelConfiguration {
  const registered = applications.get(realPath(directory));
  if (!registered) throw new Error(`${resolve(directory)}: no application is registered here`);
  return registerApplication({ directory, aot: registered.aot, model: registered.mode, recursionLimit: registered.recursionLimit,
    framework: registered.framework, entry: registered.entry, theme: animation.theme, tickHz: animation.tickHz });
}

/** Forget the application registered at `directory`. */
export function unregisterApplication(directory: string): void {
  applications.delete(realPath(directory));
}

/** The settings registered at exactly `directory`, if any. */
export function registeredApplication(directory: string): ModelConfiguration | undefined {
  return applications.get(realPath(directory));
}

/** The settings of the application `file` belongs to: the nearest registered
 *  directory above it. A file outside every application compiles as an
 *  ordinary guest module. */
export function modelConfiguration(file: string): ModelConfiguration {
  for (let directory = dirname(realPath(file)); ; directory = dirname(directory)) {
    const registered = applications.get(directory);
    if (registered) return registered;
    if (dirname(directory) === directory) return { mode: "rust", recursionLimit: 256, tickHz: 60 };
  }
}
