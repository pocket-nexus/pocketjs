import { nativeSources } from "./native-sources.ts";
import "../toolchains/meizu-m8/armv6-wince-asm.json";
import { compilerOnly, type RuntimeBuild } from "../../../framework/src/runtime-config.ts";
import { POCKET_PROFILES } from "../../../profiles/index.ts";
import { requireProgramProfile, requireApplication } from "./application.ts";
const profile = POCKET_PROFILES["meizu-m8-dev"];

export const build: RuntimeBuild = {
  hosts: ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"],
  sourceInputs: nativeSources("cabi",
    "programs/meizu-m8/runtime.c",
    "programs/meizu-m8/compat.c",
    "programs/meizu-m8/stop-old.c",
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
