import { nativeSources } from "./native-sources.ts";
import { compilerOnly, type RuntimeBuild } from "../../../framework/src/runtime-config.ts";
import profile from "../../../profiles/ipodtouch-dev.ts";
import { requireProgramProfile, requireApplication } from "./application.ts";

export const build: RuntimeBuild = {
  hosts: ["darwin-arm64", "darwin-x64"],
  sourceInputs: nativeSources("apple",
    "programs/ipodtouch6/runtime.m",
    "programs/ipodtouch6/Info.plist",
    "programs/ipodtouch6/PkgInfo",
    "programs/ipodtouch6/Icon.svg",
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
