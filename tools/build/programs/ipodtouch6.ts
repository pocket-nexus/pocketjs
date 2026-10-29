import { nativeSources } from "./native-sources.ts";
import { compilerOnly, type RuntimeBuild } from "../../../framework/src/host-config.ts";
import { POCKET_PROFILES } from "../../../hosts/index.ts";
import { requireProgramProfile, requireApplication } from "./application.ts";
const profile = POCKET_PROFILES["ipodtouch-dev"];

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
