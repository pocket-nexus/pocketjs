import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { findHostConfig, resolveProfile, type LoadedHostConfig, type ResolvedProfile } from "../profile-resolver.ts";

const ROOT = resolve(import.meta.dir, "../..");
export interface ProgramEntry {
  readonly id: string;
  readonly profile: string;
  readonly directory: string;
  readonly generic?: { readonly directory: string; readonly profile: string };
}
/** The program recipes this repository ships, by CLI alias and host. A host
 * config with its own `build` needs no entry. */
export const PROGRAMS: readonly ProgramEntry[] = [
  { id: "pocketbook", profile: "pocketbook", directory: "pocketbook" },
  { id: "nokia-e7", profile: "symbian-e7-dev", directory: "nokia-e7" },
  { id: "ios-simulator", profile: "ios-dev", directory: "ios-simulator" },
  { id: "ipodtouch6", profile: "ipodtouch-dev", directory: "ipodtouch6" },
  { id: "ipodtouch4", profile: "ipodtouch4-dev", directory: "ipodtouch4", generic: { directory: "ipodtouch4", profile: "ipodtouch4-dev" } },
  { id: "psp", profile: "psp", directory: "psp", generic: { directory: "psp/runtime", profile: "psp-runtime" } },
  { id: "vita", profile: "vita", directory: "vita", generic: { directory: "vita/runtime", profile: "vita" } },
  { id: "3ds", profile: "3ds-runtime", directory: "3ds", generic: { directory: "3ds", profile: "3ds-runtime" } },
  { id: "web-app", profile: "web-app", directory: "web" },
  { id: "macos-widget", profile: "macos-widget", directory: "macos-widget" },
  { id: "gba", profile: "gba", directory: "gba" },
  { id: "ipodnano", profile: "ipodnano", directory: "ipodnano" },
  { id: "sim", profile: "psp-runtime", directory: "sim" },
  { id: "linux-kms", profile: "product-linux-kms", directory: "linux-kms" },
];

/** A program selection; `application` is the host config whose `app` the
 *  build compiles when it ran from an application's directory. */
export interface ResolvedProgram extends ResolvedProfile {
  readonly application?: LoadedHostConfig;
}

/** The stock program recipe for a host this repository ships. */
async function stockProgram(target: string, options: { from: string; generic?: boolean; env?: Readonly<Record<string, string | undefined>> }): Promise<ResolvedProfile> {
  const entry = PROGRAMS.find(program => program.id === target || program.profile === target || program.generic?.profile === target);
  if (!entry) throw new Error(`no program for ${target}; supply --config <pocket.host.config.ts>`);
  const useGeneric = options.generic || target === entry.generic?.profile && target !== entry.profile;
  const selection = useGeneric ? entry.generic : entry;
  if (!selection) throw new Error(`program ${entry.id} has no generic runtime; use its native build recipe`);
  const hostConfig = resolve(ROOT, "programs", selection.directory, "pocket.host.config.ts");
  if (!existsSync(hostConfig)) throw new Error(`program source is unavailable: ${hostConfig}; use a source checkout or your own --config`);
  return resolveProfile({ from: options.from, target: selection.profile, hostConfig, requireConfig: true, env: options.env });
}

export async function resolveRuntimeProgram(options: {
  from: string; target?: string; hostConfig?: string; generic?: boolean;
  env?: Readonly<Record<string, string | undefined>>;
}): Promise<ResolvedProgram> {
  const target = options.target ?? options.env?.POCKET_TARGET?.trim();
  if (options.hostConfig || findHostConfig(options.from) || !target) {
    const selected = await resolveProfile({ ...options, target, requireConfig: true });
    const config = selected.config!;
    // An application config without a recipe builds with the stock program
    // of the built-in host it selected.
    if (!config.value.build && config.value.app && PROGRAMS.some(program => program.profile === selected.profile.id || program.generic?.profile === selected.profile.id)) {
      const program = await stockProgram(selected.profile.id, options);
      // A generic runtime takes no application; pocket pack reads its identity defaults.
      if (options.generic) return { ...program, application: config };
      if (program.profileHash !== selected.profileHash) throw new Error(`the stock ${selected.profile.id} program implements a different host contract than ${config.path} lists`);
      return { ...program, application: config };
    }
    if (options.generic && !config.value.build?.genericRuntime)
      throw new Error("the selected host config has no genericRuntime.repack adapter; choose its generic host configuration");
    return { ...selected, ...(config.value.app ? { application: config } : {}) };
  }
  return stockProgram(target, options);
}
