// Application settings the AOT frontends and model lowering consult: the
// execution class (`aot`), the model mode, the recursion limit, the framework
// and the entry module. The compiler reads no file to find them. The build
// driver registers each application before compiling it: tools/build.ts and
// `pocket compile` from the host config or the build plan, the browser
// builds and the tests from their own data. A lookup walks up from a source
// file to the nearest registered application directory.
import { dirname, resolve } from "node:path";

export interface ApplicationSettings {
  /** The application directory; every file below it belongs to the application. */
  readonly directory: string;
  readonly aot?: boolean;
  readonly model?: "rust" | "compiled";
  readonly recursionLimit?: number;
  readonly framework?: string;
  /** The entry module: absolute, or relative to `directory`. */
  readonly entry?: string;
}

export interface ModelConfiguration {
  readonly mode: "rust" | "compiled";
  readonly recursionLimit: number;
  readonly aot?: boolean;
  readonly directory?: string;
  readonly framework?: string;
  /** Absolute path of the entry module. */
  readonly entry?: string;
}

const applications = new Map<string, ModelConfiguration>();

/** Register (or replace) the settings of the application at `settings.directory`. */
export function registerApplication(settings: ApplicationSettings): ModelConfiguration {
  const directory = resolve(settings.directory);
  const mode = settings.model ?? "rust", recursionLimit = settings.recursionLimit ?? 256;
  if (mode !== "rust" && mode !== "compiled") throw new Error(`${directory}: app.model must be rust or compiled`);
  if (!Number.isInteger(recursionLimit) || recursionLimit < 1) throw new Error(`${directory}: app.recursionLimit must be a positive integer`);
  if (mode === "compiled" && settings.aot !== true) throw new Error(`${directory}: app.model = compiled requires app.aot = true`);
  const configuration: ModelConfiguration = {
    mode, recursionLimit, aot: settings.aot === true, directory,
    ...(settings.framework !== undefined ? { framework: settings.framework } : {}),
    ...(settings.entry !== undefined ? { entry: resolve(directory, settings.entry) } : {}),
  };
  applications.set(directory, configuration);
  return configuration;
}

/** Forget the application registered at `directory`. */
export function unregisterApplication(directory: string): void {
  applications.delete(resolve(directory));
}

/** The settings registered at exactly `directory`, if any. */
export function registeredApplication(directory: string): ModelConfiguration | undefined {
  return applications.get(resolve(directory));
}

/** The settings of the application `file` belongs to: the nearest registered
 *  directory above it. A file outside every application compiles as an
 *  ordinary guest module. */
export function modelConfiguration(file: string): ModelConfiguration {
  for (let directory = dirname(resolve(file)); ; directory = dirname(directory)) {
    const registered = applications.get(directory);
    if (registered) return registered;
    if (dirname(directory) === directory) return { mode: "rust", recursionLimit: 256 };
  }
}
