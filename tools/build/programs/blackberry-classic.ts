import { nativeSources } from "./native-sources.ts";
import "../toolchains/blackberry-qnx/armv7-qnx-eabi.json";
import { compilerOnly, type RuntimeBuild } from "../../../framework/src/runtime-config.ts";
import profile from "../../../profiles/blackberry-qnx-dev.ts";
import { requireProgramProfile, requireApplication } from "./application.ts";

export const build: RuntimeBuild = {
  hosts: ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"],
  sourceInputs: nativeSources("cabi",
    "programs/blackberry-classic/main.c",
    "programs/blackberry-classic/bar-descriptor.xml",
    "tools/blackberry-qnx/build.sh",
    "tools/blackberry-qnx/quickjs-qnx.patch",
  ),
  steps: compilerOnly(),
  input: "package",
  artifact: "{outdir}/pocketjs-blackberry-classic-hero.bar",
  async run(context) {
    requireProgramProfile(context, profile);
    const { buildBlackBerryNative } = await import("../../blackberry-qnx.ts");
    await buildBlackBerryNative(requireApplication(context), context.outdir);
  },
};
