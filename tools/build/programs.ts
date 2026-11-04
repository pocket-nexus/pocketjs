import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { findHostConfig, resolveProfile, type ResolvedProfile } from "../profile-resolver.ts";

const ROOT = resolve(import.meta.dir, "../..");
export interface ProgramEntry {
  readonly id: string;
  readonly profile: string;
  readonly directory: string;
  /** Repository-relative config override for an independent product. */
  readonly hostConfig?: string;
  readonly generic?: { readonly directory: string; readonly profile: string };
}
/** CLI aliases locate program-owned recipes; external programs need no entry. */
export const PROGRAMS: readonly ProgramEntry[] = [
  { id: "pocketbook", profile: "pocketbook", directory: "pocketbook" },
  { id: "nokia-e7", profile: "symbian-e7-dev", directory: "nokia-e7" },
  { id: "ios-simulator", profile: "ios-dev", directory: "ios-simulator" },
  { id: "ipodtouch6", profile: "ipodtouch-dev", directory: "ipodtouch6" },
  { id: "ipodtouch4", profile: "ipodtouch4-dev", directory: "ipodtouch4", generic: { directory: "ipodtouch4", profile: "ipodtouch4-dev" } },
  { id: "psp", profile: "psp", directory: "psp", generic: { directory: "psp/runtime", profile: "psp-runtime" } },
  { id: "vita", profile: "vita", directory: "vita", generic: { directory: "vita/runtime", profile: "vita" } },
  { id: "3ds", profile: "3ds-dev", directory: "3ds", hostConfig: "products/3ds/pocket.host.config.ts", generic: { directory: "3ds", profile: "3ds-runtime" } },
  { id: "web-app", profile: "web-app", directory: "web" },
  { id: "macos-widget", profile: "macos-widget", directory: "macos-widget" },
  { id: "gba", profile: "gba", directory: "gba" },
  { id: "ipodnano", profile: "ipodnano", directory: "ipodnano" },
  { id: "sim", profile: "psp-runtime", directory: "sim" },
  { id: "linux-kms", profile: "product-linux-kms", directory: "linux-kms" },
];

export async function resolveRuntimeProgram(options: {
  from: string; target?: string; hostConfig?: string; generic?: boolean;
  env?: Readonly<Record<string, string | undefined>>;
}): Promise<ResolvedProfile> {
  const target = options.target ?? options.env?.POCKET_TARGET?.trim();
  if (options.hostConfig || findHostConfig(options.from) || !target) {
    const selected = await resolveProfile({ ...options, target, requireConfig: true });
    if (options.generic && !selected.config?.value.build?.genericRuntime)
      throw new Error("the selected host config has no genericRuntime.repack adapter; choose its generic host configuration");
    return selected;
  }
  const entry = PROGRAMS.find(program => program.id === target || program.profile === target || program.generic?.profile === target);
  if (!entry) throw new Error(`no program for ${target}; supply --config <pocket.host.config.ts>`);
  const useGeneric = options.generic || target === entry.generic?.profile && target !== entry.profile;
  const selection = useGeneric ? entry.generic : entry;
  if (!selection) throw new Error(`program ${entry.id} has no generic runtime; use its native build recipe`);
  const hostConfig = !useGeneric && entry.hostConfig
    ? resolve(ROOT, entry.hostConfig)
    : resolve(ROOT, "programs", selection.directory, "pocket.host.config.ts");
  if (!existsSync(hostConfig)) throw new Error(`program source is unavailable: ${hostConfig}; use a source checkout or your own --config`);
  return resolveProfile({ from: options.from, target: selection.profile, hostConfig, requireConfig: true, env: options.env });
}
