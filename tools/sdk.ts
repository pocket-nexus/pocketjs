// Compatibility exports for source-build consumers; CLI export downloads a release.
export { exportSdk, parseSdkExport, verifySdk, compilerRtMembers } from "./release/archive.ts";
export type { SdkOptions, SdkManifest } from "./release/archive.ts";
export { sdkCommand, SDK_USAGE } from "./release/sdk-command.ts";
