/** Stable API for Pocket manifests and custom native hosts. */
export {
  POCKET_MANIFEST_SCHEMA_ID,
  POCKET_MANIFEST_VERSION,
  pocketManifestV2Schema,
  type PocketManifestV2,
  type PocketFramework,
  type AnimationTheme,
} from "../../../contracts/spec/pocket-manifest.ts";
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
  expandThemeReference,
  readAuthoredManifest,
  readPocketManifest,
  type LoadedManifest,
} from "./load.ts";
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
export { vitaTitleId } from "./vita-package.ts";
export { createHostExtension, isHostExtension, type HostExtension } from "./host-extension.ts";
