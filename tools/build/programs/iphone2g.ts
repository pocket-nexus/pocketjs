import { nativeSources } from "./native-sources.ts";
import "../toolchains/iphone2g/armv6-apple-ios.json";
import { compilerOnly, type RuntimeBuild } from "../../../framework/src/runtime-config.ts";
import profile from "../../../profiles/iphone2g-dev.ts";
import { requireProgramProfile, requireApplication } from "./application.ts";

export const build: RuntimeBuild = {
  hosts: ["darwin-arm64", "darwin-x64"],
  sourceInputs: nativeSources("cabi",
    "hosts/ios-legacy",
    "hosts/iphone2g/Info.plist",
    "hosts/iphone2g/PkgInfo",
    "hosts/iphone2g/Icon.png",
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
