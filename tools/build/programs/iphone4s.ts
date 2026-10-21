import { nativeSources } from "./native-sources.ts";
import "../toolchains/ios/armv7-apple-ios.json";
import { compilerOnly, type RuntimeBuild } from "../../../framework/src/runtime-config.ts";
import profile from "../../../profiles/iphone4s-dev.ts";
import { requireProgramProfile, requireApplication } from "./application.ts";

export const build: RuntimeBuild = {
  hosts: ["darwin-arm64", "darwin-x64"],
  sourceInputs: nativeSources("cabi",
    "hosts/ios-legacy",
    "hosts/iphone4s/runtime.c",
    "hosts/iphone4s/Info.plist",
    "hosts/iphone4s/PkgInfo",
    "hosts/iphone4s/Icon.svg",
    "hosts/iphone2g/Icon.png",
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
