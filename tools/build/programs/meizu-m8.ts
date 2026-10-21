import { nativeSources } from "./native-sources.ts";
import "../toolchains/meizu-m8/armv6-wince-asm.json";
import { compilerOnly, type RuntimeBuild } from "../../../framework/src/runtime-config.ts";
import profile from "../../../profiles/meizu-m8-dev.ts";
import { requireProgramProfile, requireApplication } from "./application.ts";

export const build: RuntimeBuild = {
  hosts: ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"],
  sourceInputs: nativeSources("cabi",
    "hosts/meizu-m8/runtime.c",
    "hosts/meizu-m8/compat.c",
    "hosts/meizu-m8/stop-old.c",
    "tools/meizu-m8/build-wince.sh",
    "tools/meizu-m8/quickjs-wince.patch",
  ),
  steps: compilerOnly(),
  input: "package",
  artifact: "{outdir}/PocketJS.exe",
  async run(context) {
    requireProgramProfile(context, profile);
    const { buildMeizuNative } = await import("../../meizu-m8.ts");
    await buildMeizuNative(requireApplication(context), context.outdir);
  },
};
