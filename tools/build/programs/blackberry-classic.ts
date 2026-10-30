import { nativeSources } from "./native-sources.ts";
import "../toolchains/blackberry-qnx/armv7-qnx-eabi.json";
import { compilerOnly, type RuntimeBuild } from "../../../framework/src/host-config.ts";
import { POCKET_PROFILES } from "../../../hosts/index.ts";
import { requireProgramProfile, requireApplication } from "./application.ts";
const profile = POCKET_PROFILES["blackberry-qnx-dev"];

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
