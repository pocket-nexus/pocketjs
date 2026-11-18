import type { ResolvedBuildPlan } from "../compiler/plan.ts";
import type { RepackInput } from "../../tools/repack/shared/runtime.ts";
import type { PocketProfile } from "./profile.ts";
import type { ToolchainManifest } from "../../tools/targets/toolchain.ts";
import { validateAppConfig, type AppConfig } from "../../contracts/spec/app-config.ts";
import { BUILTIN_PROFILE_IDS } from "../../hosts/ids.ts";

export type { AppConfig, PocketFramework } from "../../contracts/spec/app-config.ts";
export type { AnimationTheme } from "../../contracts/spec/animation-theme.ts";
export type { AppViewport, SurfacesSpec } from "../../contracts/spec/viewport.ts";
export type { WorkerDeclarationSource } from "../../contracts/spec/worker.ts";

export type RuntimeBuildHost = "darwin-arm64" | "darwin-x64" | "linux-arm64" | "linux-x64";
export interface RuntimeApplication {
  readonly packagePath: string;
  readonly directory: string;
  readonly planPath: string;
  readonly plan: ResolvedBuildPlan;
  readonly jsPath: string;
  readonly pakPath: string;
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
  /** The `app` section of the host config `pocket build` compiled the
   *  application from, when it compiled it. */
  readonly app?: AppConfig;
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
  readonly genericRuntime?: { readonly repack: (input: RepackInput) => Promise<Uint8Array>; readonly extension?: string };
  readonly deploy?: (context: RuntimeBuildContext) => void | Promise<void>;
}
/** `host` names one host contract, `hosts` several: each entry is the path of
 * a pocket.host.json, relative to the config file, or the id of a built-in
 * host contract (hosts/<id>/pocket.host.json). `app` is the application the
 * config builds; `build` is a program's native recipe. */
export type PocketHostConfig = (
  | { readonly host: string; readonly hosts?: never }
  | { readonly hosts: readonly string[]; readonly host?: never }
) & { readonly build?: RuntimeBuild; readonly app?: AppConfig };

/** A host entry that names a built-in host contract rather than a file. */
export const isBuiltinHostId = (host: string): boolean => BUILTIN_PROFILE_IDS.includes(host);

/** A program's or an application's host contracts, its application and its
 *  optional native build recipe. */
export function defineHostConfig<const C extends PocketHostConfig>(config: C): C {
  if (!config || typeof config !== "object" || ("host" in config) === ("hosts" in config)) {
    throw new TypeError("host config requires exactly one of host or hosts");
  }
  if (Object.keys(config).some(key => !["host", "hosts", "build", "app"].includes(key))) {
    throw new TypeError("host config accepts host/hosts, app and build only");
  }
  const hosts = config.hosts ?? [config.host];
  if (!hosts.length || hosts.some(host => typeof host !== "string" || !host.endsWith(".json") && !isBuiltinHostId(host))) {
    throw new TypeError(`host config hosts are paths of pocket.host.json host contracts or built-in host ids (${BUILTIN_PROFILE_IDS.join(", ")})`);
  }
  if (new Set(hosts).size !== hosts.length) {
    throw new TypeError("host config hosts must be unique");
  }
  if (config.app !== undefined) {
    const diagnostics = validateAppConfig(config.app);
    if (diagnostics.length) {
      throw new TypeError(`host config app section: ${diagnostics.map(item => `${item.path}: ${item.message}`).join("; ")}`);
    }
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
