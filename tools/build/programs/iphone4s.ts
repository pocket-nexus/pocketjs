import { nativeSources } from "./native-sources.ts";
import "../toolchains/ios/armv7-apple-ios.json";
import { compilerOnly, type RuntimeBuild } from "../../../framework/src/runtime-config.ts";
import profile from "../../../profiles/iphone4s-dev.ts";
import { requireProgramProfile, requireApplication } from "./application.ts";

export const build: RuntimeBuild = {
  hosts: ["darwin-arm64", "darwin-x64"],
  sourceInputs: nativeSources("cabi",
    "programs/shared/ios-legacy",
    "programs/iphone4s/runtime.c",
    "programs/iphone4s/Info.plist",
    "programs/iphone4s/PkgInfo",
    "programs/iphone4s/Icon.svg",
    "programs/iphone2g/Icon.png",
  ),
  steps: compilerOnly(),
  input: "package",
  artifact: "{outdir}/PocketJSiPhone4S.app",
  async run(context) {
    requireProgramProfile(context, profile);
    const { buildIPhone4SNative } = await import("../../iphone4s.ts");
    await buildIPhone4SNative(requireApplication(context), context.outdir);
  },
};
