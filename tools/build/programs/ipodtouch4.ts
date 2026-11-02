import { nativeSources } from "./native-sources.ts";
import "../toolchains/ios/armv7-apple-ios.json";
import { compilerOnly, type RuntimeBuild } from "../../../framework/src/host-config.ts";
import { POCKET_PROFILES } from "../../../hosts/index.ts";
import { requireProgramProfile } from "./application.ts";
import { repackIPod } from "../../repack/ipod.ts";
const profile = POCKET_PROFILES["ipodtouch4-dev"];

export const build: RuntimeBuild = {
  hosts: ["darwin-arm64", "darwin-x64"],
  sourceInputs: nativeSources("native",
    "programs/ipodtouch4",
    "programs/ipodtouch4/runtime.c",
    "programs/ipodtouch4/PkgInfo",
    "assets/brand/pocketjs-icon.png",
    "assets/brand/pocketjs-icon.svg",
  ),
  steps: compilerOnly(),
  artifact: "{outdir}/runtime",
  genericRuntime: { repack: repackIPod, extension: ".ipa" },
  async run(context) {
    requireProgramProfile(context, profile);
    const { buildRuntimeIPod } = await import("../../runtime/ipod.ts");
    await buildRuntimeIPod([`--out=${context.outdir}/runtime`]);
  },
};
