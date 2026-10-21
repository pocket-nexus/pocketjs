import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { findRuntimeConfig, resolveProfile, type ResolvedProfile } from "../profile-resolver.ts";

const ROOT = resolve(import.meta.dir, "../..");
export interface ProgramEntry {
  readonly id: string;
  readonly profile: string;
  readonly directory: string;
  readonly generic?: { readonly directory: string; readonly profile: string };
}
/** CLI aliases locate program-owned recipes; external programs need no entry. */
export const PROGRAMS: readonly ProgramEntry[] = [
  { id: "psp", profile: "psp", directory: "psp", generic: { directory: "psp/runtime", profile: "psp-runtime" } },
  { id: "vita", profile: "vita", directory: "vita", generic: { directory: "vita/runtime", profile: "vita" } },
  { id: "3ds", profile: "3ds-dev", directory: "3ds", generic: { directory: "3ds/runtime", profile: "3ds-runtime" } },
  { id: "pocketbook", profile: "pocketbook", directory: "pocketbook" },
  { id: "web-app", profile: "web-app", directory: "web" },
  { id: "macos-app", profile: "macos-app", directory: "desktop/macos" },
  { id: "linux-app", profile: "linux-app", directory: "desktop/linux" },
  { id: "macos-widget", profile: "macos-widget", directory: "macos-widget" },
  { id: "moto-g-play", profile: "moto-g-play-dev", directory: "moto-g-play", generic: { directory: "moto-g-play", profile: "moto-g-play-dev" } },
  { id: "redmi-1s", profile: "redmi-1s-dev", directory: "redmi-1s", generic: { directory: "redmi-1s", profile: "redmi-1s-dev" } },
  { id: "blackberry-classic", profile: "blackberry-qnx-dev", directory: "blackberry-classic" },
  { id: "meizu-m8", profile: "meizu-m8-dev", directory: "meizu-m8" },
  { id: "nokia-e7", profile: "symbian-e7-dev", directory: "nokia-e7" },
  { id: "ios-simulator", profile: "ios-dev", directory: "ios-simulator" },
  { id: "iphone2g", profile: "iphone2g-dev", directory: "iphone2g" },
  { id: "iphone4s", profile: "iphone4s-dev", directory: "iphone4s" },
  { id: "ipodtouch6", profile: "ipodtouch-dev", directory: "ipodtouch6" },
  { id: "ipodtouch4", profile: "ipodtouch4-dev", directory: "ipodtouch4", generic: { directory: "ipodtouch4", profile: "ipodtouch4-dev" } },
  { id: "gba", profile: "gba", directory: "gba" },
  { id: "ipodnano", profile: "ipodnano", directory: "ipodnano" },
  { id: "sim", profile: "psp-runtime", directory: "sim" },
  { id: "linux-kms", profile: "product-linux-kms", directory: "linux-kms" },
];

export async function resolveRuntimeProgram(options: {
  from: string; target?: string; runtimeConfig?: string; generic?: boolean;
  env?: Readonly<Record<string, string | undefined>>;
}): Promise<ResolvedProfile> {
  const target = options.target ?? options.env?.POCKET_TARGET?.trim();
  if (options.runtimeConfig || findRuntimeConfig(options.from) || !target) {
    const selected = await resolveProfile({ ...options, target, requireConfig: true });
    if (options.generic && !selected.config?.value.build?.genericRuntime)
      throw new Error("the selected runtime config has no genericRuntime.repack adapter; choose its generic runtime configuration");
    return selected;
  }
  const entry = PROGRAMS.find(program => program.id === target || program.profile === target || program.generic?.profile === target);
  if (!entry) throw new Error(`no program for ${target}; supply --config <pocket.runtime-config.ts>`);
  const useGeneric = options.generic || target === entry.generic?.profile && target !== entry.profile;
  const selection = useGeneric ? entry.generic : entry;
  if (!selection) throw new Error(`program ${entry.id} has no generic runtime; use its native build recipe`);
  const runtimeConfig = resolve(ROOT, "programs", selection.directory, "pocket.runtime-config.ts");
  if (!existsSync(runtimeConfig)) throw new Error(`program source is unavailable: ${runtimeConfig}; use a source checkout or your own --config`);
  return resolveProfile({ from: options.from, target: selection.profile, runtimeConfig, requireConfig: true, env: options.env });
}
