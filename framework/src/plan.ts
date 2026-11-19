/** Stable API for build plans and custom native hosts: resolve an application
 *  for a host, verify a plan, and project it onto native build inputs. */
export {
  canonicalJson,
  finalizeBuildPlan,
  hashBuildPlanContent,
  planProfileDocument,
  verifyPlanHash,
  verifyPlanProfile,
  type PlanProfile,
  type ResolvedBuildPlan,
  type ResolvedBuildPlanContent,
} from "../compiler/plan.ts";
export {
  appIdentity,
  appOutput,
  resolveAppPlan,
  validatePlatformContractRegistry,
  type ResolutionResult,
  type ResolveAppRequest,
} from "../compiler/app-plan.ts";
export {
  extractHostBuildInputs,
  hostBuildEnvironment,
  type ExtractHostBuildInputsOptions,
  type HostBuildEnvironmentOptions,
  type HostBuildInputs,
} from "../compiler/host-build-inputs.ts";
export { createHostExtension, isHostExtension, type HostExtension } from "../compiler/host-extension.ts";
export { vitaTitleId } from "../compiler/vita-title-id.ts";
export {
  POCKET_FRAMEWORKS,
  validateAppConfig,
  type AppConfig,
  type PocketFramework,
} from "../../contracts/spec/app-config.ts";
export type { AnimationTheme } from "../../contracts/spec/animation-theme.ts";
export type { AppViewport, AuxiliarySurfaceSpec, SurfacesSpec } from "../../contracts/spec/viewport.ts";
export type { ContractDiagnostic, ValidationResult } from "../../contracts/spec/json-schema.ts";
export type { FeatureId, PackageRole, PocketCapabilityId, PresentationMode, Viewport } from "../../contracts/spec/platforms.ts";
