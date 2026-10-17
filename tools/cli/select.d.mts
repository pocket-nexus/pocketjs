// Types for tests importing tools/cli/select.mjs; not part of the published
// tarball (tools/cli/package.json "files").

export const SETTINGS_SCHEMA: string;
export const NO_SELECTION: string;

export interface Settings {
  readonly schema: string;
  readonly default?: string;
  readonly overrides: Readonly<Record<string, string>>;
}

export interface ExplicitSelection {
  readonly id?: string;
  readonly hostProfile?: string;
  readonly origin: string;
}

export interface Selection extends ExplicitSelection {
  readonly source: "explicit" | "env" | "override" | "project" | "default";
}

export function settingsPath(env?: Record<string, string | undefined>): string;
export function readSettings(env?: Record<string, string | undefined>): Settings;
export function writeSettings(settings: Settings, env?: Record<string, string | undefined>): void;
export function overrideFor(cwd: string, settings: Settings): { readonly id: string; readonly directory: string } | null;
export function takeExplicitSelection(
  args: readonly string[],
  leading?: string,
): { readonly args: string[]; readonly explicit: ExplicitSelection | null; readonly error?: undefined } | { readonly error: string };
export function select(input: {
  readonly explicit: ExplicitSelection | null;
  readonly env?: Record<string, string | undefined>;
  readonly cwd?: string;
  readonly settings: Settings;
  readonly project: { readonly config: string | null; readonly targets: readonly { readonly id: string }[] } | null;
}): Selection | null;
