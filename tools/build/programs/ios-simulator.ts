import { nativeSources } from "./native-sources.ts";
import { compilerOnly, type RuntimeBuild } from "../../../framework/src/runtime-config.ts";
import profile from "../../../profiles/ios-dev.ts";
import { requireProgramProfile, requireApplication } from "./application.ts";

export const build: RuntimeBuild = {
  hosts: ["darwin-arm64"],
  sourceInputs: nativeSources("apple",
    "tools/build-xcframework.sh",
    "programs/ios-simulator/shell/src",
    "programs/ios-simulator/shell/App_Resources",
    "programs/ios-simulator/shell/pocketjs",
    "programs/ios-simulator/shell/package.json",
    "programs/ios-simulator/shell/tsconfig.json",
    "programs/ios-simulator/shell/references.d.ts",
    "programs/ios-simulator/shell/nativescript.config.ts",
    "programs/ios-simulator/shell/webpack.config.js",
  ),
  steps: compilerOnly(),
  input: "package",
  artifact: "{outdir}/PocketShell.app",
  async run(context) {
    requireProgramProfile(context, profile);
    const { buildIOSSimulatorNative } = await import("../../ios.ts");
    await buildIOSSimulatorNative(requireApplication(context), context.outdir, context.args);
  },
};
