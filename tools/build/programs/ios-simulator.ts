import { nativeSources } from "./native-sources.ts";
import { compilerOnly, type RuntimeBuild } from "../../../framework/src/runtime-config.ts";
import profile from "../../../profiles/ios-dev.ts";
import { requireProgramProfile, requireApplication } from "./application.ts";

export const build: RuntimeBuild = {
  hosts: ["darwin-arm64"],
  sourceInputs: nativeSources("apple",
    "engine/ios/build-xcframework.sh",
    "hosts/ios-nativescript/src",
    "hosts/ios-nativescript/App_Resources",
    "hosts/ios-nativescript/pocketjs",
    "hosts/ios-nativescript/package.json",
    "hosts/ios-nativescript/tsconfig.json",
    "hosts/ios-nativescript/references.d.ts",
    "hosts/ios-nativescript/nativescript.config.ts",
    "hosts/ios-nativescript/webpack.config.js",
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
