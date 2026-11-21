// Types for tests importing tools/cli/framework.mjs; not part of the published
// tarball (tools/cli/package.json "files").

export const CLI_PROTOCOL: number;
export const INSTALL_PATH: string;

export interface FrameworkMarker {
  readonly protocol: number;
  readonly name: string | null;
  readonly version: string | null;
}

export interface ResolvedFramework extends FrameworkMarker {
  readonly root: string;
  readonly source: "env" | "checkout" | "project";
  readonly origin: string;
  readonly error?: undefined;
}

export function readMarker(directory: string): FrameworkMarker | null;

export function resolveFramework(options?: {
  readonly cwd?: string;
  readonly env?: Record<string, string | undefined>;
}): ResolvedFramework | { readonly error: string };

export function protocolMismatch(framework: ResolvedFramework, cliVersion: string): string | null;
