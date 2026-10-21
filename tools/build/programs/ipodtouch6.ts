import { nativeSources } from "./native-sources.ts";
import { compilerOnly, type RuntimeBuild } from "../../../framework/src/runtime-config.ts";
import profile from "../../../profiles/ipodtouch-dev.ts";
import { requireProgramProfile, requireApplication } from "./application.ts";

export const build: RuntimeBuild = {
  hosts: ["darwin-arm64", "darwin-x64"],
  sourceInputs: nativeSources("apple",
    "hosts/ipodtouch6/runtime.m",
    "hosts/ipodtouch6/Info.plist",
    "hosts/ipodtouch6/PkgInfo",
    "hosts/ipodtouch6/Icon.svg",
  ),
  steps: compilerOnly(),
  input: "package",
  artifact: "{outdir}/PocketJSiPod.app",
  async run(context) {
    requireProgramProfile(context, profile);
    const { buildIPodTouchNative } = await import("../../ipodtouch.ts");
    await buildIPodTouchNative(requireApplication(context), context.outdir);
  },
};
