import type { ResolvedBuildPlan } from "./manifest/plan.ts";
import type { RepackInput } from "../../tools/repack/shared/runtime.ts";
import type { PocketProfile } from "./profile.ts";
import type { ToolchainManifest } from "../../tools/targets/toolchain.ts";

export type RuntimeBuildHost = "darwin-arm64" | "darwin-x64" | "linux-arm64" | "linux-x64";
export interface RuntimeApplication {
  readonly packagePath: string;
  readonly directory: string;
  readonly planPath: string;
  readonly plan: ResolvedBuildPlan;
  readonly jsPath: string;
  readonly pakPath: string;
  readonly manifestPath: string;
}
export interface RuntimeAotInput {
  readonly directory: string;
  readonly includeFile: string;
  readonly dependencyManifest: string;
}
export interface RuntimeBuildContext {
  readonly profile: PocketProfile;
  readonly profileHash: string;
  readonly configDirectory: string;
  readonly outdir: string;
  readonly output: string;
  readonly args: readonly string[];
  readonly application?: RuntimeApplication;
  readonly aot?: RuntimeAotInput;
  readonly env: Readonly<Record<string, string>>;
  readonly toolchainPaths: Readonly<Record<string, string>>;
  run(command: readonly string[], options?: { cwd?: string; env?: Readonly<Record<string, string>> }): Promise<void>;
}
/** Inputs available before any build command or toolchain is started. */
export type RuntimeSourceContext = Readonly<Pick<RuntimeBuildContext,
  "profile" | "profileHash" | "configDirectory" | "outdir" | "output" | "args" | "application" | "aot"
>> & { readonly invocationDirectory: string };
export type RuntimeSourceInputs = readonly string[] | ((context: RuntimeSourceContext) => readonly string[]);
interface StepOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly args?: readonly string[];
}
export interface CargoStep extends StepOptions {
  readonly kind: "cargo";
  readonly executable?: string;
  readonly toolchain?: string;
  readonly package?: string;
  readonly targetDirectory?: string;
  readonly noDefaultFeatures?: boolean;
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
  /** An already compiled input required by the native recipe. */
  readonly input?: "package" | "aot";
  /** Source files or directories, relative to the config, for the receipt and
   * input-change checks. A synchronous function can declare inputs selected by
   * build arguments. It is evaluated before and after the build; both the path
   * set and file contents must remain unchanged. Return exact input files, not
   * a parent directory that also contains generated outputs. */
  readonly sourceInputs?: RuntimeSourceInputs;
  readonly artifact?: string;
  readonly run?: (context: RuntimeBuildContext) => void | Promise<void>;
  readonly genericRuntime?: { readonly repack: (input: RepackInput) => Promise<Uint8Array>; readonly extension?: string; readonly signed?: boolean };
  readonly deploy?: (context: RuntimeBuildContext) => void | Promise<void>;
}
/** `profile` names one pocket-profile/2 document, `profiles` several; paths
 * are relative to the config file. */
export type PocketRuntimeConfig = (
  | { readonly profile: string; readonly profiles?: never }
  | { readonly profiles: readonly string[]; readonly profile?: never }
) & { readonly build?: RuntimeBuild };

/** A program's profile documents and optional native build recipe. */
export function defineRuntimeConfig<const C extends PocketRuntimeConfig>(config: C): C {
  if (!config || typeof config !== "object" || ("profile" in config) === ("profiles" in config)) {
    throw new TypeError("runtime config requires exactly one of profile or profiles");
  }
  if (Object.keys(config).some(key => !["profile", "profiles", "build"].includes(key))) {
    throw new TypeError("runtime config accepts profile/profiles and build only");
  }
  const profiles = config.profiles ?? [config.profile];
  if (!profiles.length || profiles.some(profile => typeof profile !== "string" || !profile.endsWith(".json"))) {
    throw new TypeError("runtime config profiles are paths of pocket-profile.json documents");
  }
  if (new Set(profiles).size !== profiles.length) {
    throw new TypeError("runtime config profile paths must be unique");
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
    if (build.input !== undefined && !["package", "aot"].includes(build.input)) throw new TypeError("runtime build input must be package or aot");
    if (build.sourceInputs !== undefined && typeof build.sourceInputs !== "function" &&
        (!Array.isArray(build.sourceInputs) || build.sourceInputs.some(path => typeof path !== "string" || !path)))
      throw new TypeError("runtime build sourceInputs must be a path array or synchronous function");
    if (build.artifact !== undefined && (typeof build.artifact !== "string" || !build.artifact)) throw new TypeError("runtime build artifact must be a nonempty path");
    if (build.genericRuntime !== undefined && typeof build.genericRuntime?.repack !== "function") throw new TypeError("runtime genericRuntime requires a repack function");
    if (build.deploy !== undefined && typeof build.deploy !== "function") throw new TypeError("runtime build.deploy must be a function");
    if (build.run !== undefined && typeof build.run !== "function") throw new TypeError("runtime build.run must be a function");
  }
  return config;
}
export const cargo = (options: Omit<CargoStep, "kind"> = {}): CargoStep => ({ ...options, kind: "cargo" });
export const cmake = (options: Omit<CmakeStep, "kind"> = {}): CmakeStep => ({ ...options, kind: "cmake" });
export const make = (options: Omit<MakeStep, "kind"> = {}): MakeStep => ({ ...options, kind: "make" });
export const compilerOnly = (): CompilerOnlyStep => ({ kind: "compilerOnly" });
