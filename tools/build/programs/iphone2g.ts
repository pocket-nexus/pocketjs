import { nativeSources } from "./native-sources.ts";
import "../toolchains/iphone2g/armv6-apple-ios.json";
import { compilerOnly, type RuntimeBuild } from "../../../framework/src/runtime-config.ts";
import { POCKET_PROFILES } from "../../../profiles/index.ts";
import { requireProgramProfile, requireApplication } from "./application.ts";
const profile = POCKET_PROFILES["iphone2g-dev"];

export const build: RuntimeBuild = {
  hosts: ["darwin-arm64", "darwin-x64"],
  sourceInputs: nativeSources("cabi",
    "programs/shared/ios-legacy",
    "programs/iphone2g/Info.plist",
    "programs/iphone2g/PkgInfo",
    "programs/iphone2g/Icon.png",
  ),
  steps: compilerOnly(),
  input: "package",
  artifact: "{outdir}/PocketJSDemo.app",
  async run(context) {
    requireProgramProfile(context, profile);
    const { buildIPhone2GNative } = await import("../../iphone2g.ts");
    await buildIPhone2GNative(requireApplication(context), context.outdir);
  },
};
