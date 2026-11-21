import { findHostConfig, loadHostConfig } from "../profile-resolver.ts";
import type { PocketProfile } from "../../framework/src/profile.ts";
import type { ToolchainManifest } from "./toolchain.ts";

export interface ProjectConfiguration {
  readonly config: string | null;
  readonly profiles: readonly PocketProfile[];
  readonly build: boolean;
  readonly toolchain?: ToolchainManifest;
  readonly hosts?: readonly string[];
}
export type ProjectResult =
  | { readonly ok: true; readonly project: ProjectConfiguration }
  | { readonly ok: false; readonly diagnostics: readonly string[] };

export const findProjectConfig = findHostConfig;

/** Resolve the host config nearest to a directory, or the named one. */
export async function loadProject(directory: string, explicitConfig?: string): Promise<ProjectResult> {
  const path = explicitConfig ?? findHostConfig(directory);
  if (!path) return { ok: true, project: { config: null, profiles: [], build: false } };
  try {
    const loaded = await loadHostConfig(path);
    return { ok: true, project: {
      config: loaded.path, profiles: loaded.profiles,
      build: Boolean(loaded.value.build),
      ...(loaded.value.build?.toolchain ? { toolchain: loaded.value.build.toolchain } : {}),
      ...(loaded.value.build ? { hosts: loaded.value.build.hosts } : {}),
    } };
  } catch (error) {
    return { ok: false, diagnostics: [`${path}: ${error instanceof Error ? error.message : String(error)}`] };
  }
}
