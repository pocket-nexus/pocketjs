// Types for tests importing tools/cli/create.mjs; not part of the published
// tarball (tools/cli/package.json "files").

export type CreateFramework = "solid" | "vue-vapor" | "octane";
export type CreateTarget = "psp" | "vita" | "pocketbook" | "web-app" | "macos-app" | "linux-app" | "esp-idf";

export const FRAMEWORKS: readonly CreateFramework[];
export const TARGETS: readonly CreateTarget[];
export const FRAMEWORK_DEPENDENCIES: Readonly<Record<CreateFramework, Readonly<Record<string, string>>>>;
export const CREATE_USAGE: string;

export class CreateUsageError extends Error {}

export interface CreateOptions {
  readonly name: string;
  readonly framework: CreateFramework;
  readonly target: CreateTarget;
  readonly hostProfile: string | undefined;
}

export function parseCreateArgs(argv: readonly string[]): CreateOptions;

export interface PocketCommands {
  readonly check: string;
  readonly compile: string;
  readonly build: string;
}

export function pocketCommands(input: {
  readonly name: string;
  readonly target: CreateTarget;
  readonly manifest?: string;
}): PocketCommands;

export interface CreateResult {
  readonly name: string;
  readonly directory: string;
  readonly standalone: boolean;
  readonly target: CreateTarget;
  readonly framework: CreateFramework;
  readonly hostProfilePath: string | undefined;
  readonly files: readonly string[];
}

export function create(
  argv: readonly string[],
  context: { readonly checkoutRoot: string | null; readonly cliVersion: string; readonly cwd?: string },
): CreateResult;
