import { nativeSources } from "./native-sources.ts";
import "../toolchains/ios/armv7-apple-ios.json";
import { compilerOnly, type RuntimeBuild } from "../../../framework/src/host-config.ts";
import { POCKET_PROFILES } from "../../../hosts/index.ts";
import { requireProgramProfile, requireApplication } from "./application.ts";
const profile = POCKET_PROFILES["iphone4s-dev"];

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
