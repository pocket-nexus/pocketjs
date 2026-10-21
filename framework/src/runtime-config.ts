import type { PocketProfile } from "./profile.ts";
import type { ToolchainManifest } from "../../tools/targets/toolchain.ts";

export type RuntimeBuildHost = "darwin-arm64" | "darwin-x64" | "linux-arm64" | "linux-x64";
export interface RuntimeBuildContext {
  readonly profile: PocketProfile;
  readonly profileHash: string;
  readonly configDirectory: string;
  readonly outdir: string;
  readonly env: Readonly<Record<string, string>>;
  readonly toolchainPaths: Readonly<Record<string, string>>;
  run(command: readonly string[], options?: { cwd?: string; env?: Readonly<Record<string, string>> }): Promise<void>;
}
interface StepOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly args?: readonly string[];
}
export interface CargoStep extends StepOptions {
  readonly kind: "cargo";
  readonly package?: string;
  readonly manifest?: string;
  readonly target?: string;
  readonly buildStd?: readonly string[];
  readonly features?: readonly string[];
  readonly release?: boolean;
}
export interface CmakeStep extends StepOptions {
  readonly kind: "cmake";
  readonly source?: string;
  readonly buildDirectory?: string;
  readonly target?: string;
  readonly definitions?: Readonly<Record<string, string>>;
}
export interface MakeStep extends StepOptions {
  readonly kind: "make";
  readonly target?: string;
  readonly variables?: Readonly<Record<string, string>>;
}
export interface CompilerOnlyStep { readonly kind: "compilerOnly" }
export type RuntimeBuildStep = CargoStep | CmakeStep | MakeStep | CompilerOnlyStep;
export interface RuntimeBuild {
  readonly hosts: readonly RuntimeBuildHost[];
  readonly toolchain?: ToolchainManifest;
  readonly steps: RuntimeBuildStep | readonly RuntimeBuildStep[];
  readonly artifact?: string;
  readonly run?: (context: RuntimeBuildContext) => void | Promise<void>;
  readonly genericRuntime?: { readonly repack: (...args: never[]) => unknown };
  readonly deploy?: (context: RuntimeBuildContext) => void | Promise<void>;
}
export type PocketRuntimeConfig = (
  | { readonly profile: PocketProfile; readonly profiles?: never }
  | { readonly profiles: readonly PocketProfile[]; readonly profile?: never }
) & { readonly build?: RuntimeBuild };

/** A program's software promises and optional native build recipe. */
export function defineRuntimeConfig<const C extends PocketRuntimeConfig>(config: C): C {
  if (!config || typeof config !== "object" || ("profile" in config) === ("profiles" in config)) {
    throw new TypeError("runtime config requires exactly one of profile or profiles");
  }
  if (Object.keys(config).some(key => !["profile", "profiles", "build"].includes(key))) {
    throw new TypeError("runtime config accepts profile/profiles and build only");
  }
  const profiles = config.profiles ?? [config.profile];
  if (!profiles.length || profiles.some(profile => !profile || typeof profile !== "object")) {
    throw new TypeError("runtime config requires at least one profile");
  }
  if (new Set(profiles.map(profile => profile.id)).size !== profiles.length) {
    throw new TypeError("runtime config profile ids must be unique");
  }
  if (config.build !== undefined) {
    const build = config.build;
    if (!build || !Array.isArray(build.hosts) || !build.hosts.length ||
        build.hosts.some(host => !["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"].includes(host))) {
      throw new TypeError("runtime build requires supported hosts");
    }
    const steps = Array.isArray(build.steps) ? build.steps : [build.steps];
    if (!steps.length || steps.some(step => !step || !["cargo", "cmake", "make", "compilerOnly"].includes(step.kind))) {
      throw new TypeError("runtime build requires cargo, cmake, make or compilerOnly steps");
    }
    if (build.run !== undefined && typeof build.run !== "function") throw new TypeError("runtime build.run must be a function");
  }
  return config;
}
export const cargo = (options: Omit<CargoStep, "kind"> = {}): CargoStep => ({ ...options, kind: "cargo" });
export const cmake = (options: Omit<CmakeStep, "kind"> = {}): CmakeStep => ({ ...options, kind: "cmake" });
export const make = (options: Omit<MakeStep, "kind"> = {}): MakeStep => ({ ...options, kind: "make" });
export const compilerOnly = (): CompilerOnlyStep => ({ kind: "compilerOnly" });
