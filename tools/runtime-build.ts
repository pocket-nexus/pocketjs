// Compatibility import; runtime builds execute through the shared build system.
export { buildRuntime, executeBuildStep, expandBuildValue } from "./build/executor.ts";
export type { RuntimeBuildOptions, RuntimeBuildResult } from "./build/executor.ts";
