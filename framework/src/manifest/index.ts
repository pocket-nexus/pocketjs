/** Stable API for Pocket manifests and custom native hosts. */
export {
  POCKET_IDF_HOST_ABI,
  POCKET_IDF_HOST_SCHEMA_ID,
  POCKET_IDF_HOST_VERSION,
  POCKET_IDF_UI_CAPABILITIES,
  pocketIdfHostSchema,
  type PocketIdfHostProfile,
} from "../../../contracts/spec/idf-host.ts";
export {
  POCKET_MANIFEST_SCHEMA_ID,
  POCKET_MANIFEST_VERSION,
  pocketManifestV2Schema,
  type PocketManifestV2,
} from "../../../contracts/spec/pocket-manifest.ts";
export {
  BACKGROUND_EXECUTION_POLICIES,
  POCKET_SYSTEM_SCHEMA_ID,
  POCKET_SYSTEM_VERSION,
  pocketSystemV1Schema,
  type BackgroundExecutionPolicy,
  type PocketSystemInstallationStateV1,
  type PocketSystemManifestV1,
  type PocketSystemPackageV1,
  type PocketSystemV1,
} from "../../../contracts/spec/pocket-system.ts";
export {
  type PackageRole,
  type PocketCapabilityId,
  type PresentationMode,
  type Viewport,
} from "../../../contracts/spec/platforms.ts";
export {
  extractHostBuildInputs,
  hostBuildEnvironment,
  type ExtractHostBuildInputsOptions,
  type HostBuildEnvironmentOptions,
  type HostBuildInputs,
} from "./host-build-inputs.ts";
export {
  validatePocketManifest,
  type ContractDiagnostic,
  type ValidationResult,
} from "./validate.ts";
export {
  validateAndResolveBuildPlan,
  type ResolutionResult,
  type ResolveBuildRequest,
} from "./resolve.ts";
export {
  resolveSystemPlan,
  validateAndResolveSystemPlan,
  validatePocketSystem,
  type ResolvedSystemPackage,
  type ResolvedSystemPlan,
  type ResolveSystemRequest,
  type SystemPackageInput,
  type SystemResolutionResult,
} from "./system.ts";
export { vitaTitleId } from "./vita-package.ts";
export { createHostExtension, isHostExtension, type HostExtension } from "./host-extension.ts";

export { desktopNativeExtension, isDesktopNativeModule, type DesktopNativeModule } from "./desktop-native.ts";
