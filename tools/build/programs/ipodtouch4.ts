import { nativeSources } from "./native-sources.ts";
import "../toolchains/ios/armv7-apple-ios.json";
import { compilerOnly, type RuntimeBuild } from "../../../framework/src/runtime-config.ts";
import { POCKET_PROFILES } from "../../../profiles/index.ts";
import { requireProgramProfile } from "./application.ts";
import { repackIPod } from "../../repack/ipod.ts";
const profile = POCKET_PROFILES["ipodtouch4-dev"];

export const build: RuntimeBuild = {
  hosts: ["darwin-arm64", "darwin-x64"],
  sourceInputs: nativeSources("cabi",
    "programs/shared/ios-legacy",
    "programs/ipodtouch4/runtime.c",
    "programs/ipodtouch4/PkgInfo",
    "programs/iphone2g/Icon.png",
    "programs/iphone4s/Icon.svg",
  ),
  steps: compilerOnly(),
  artifact: "{outdir}/runtime",
  genericRuntime: { repack: repackIPod, extension: ".ipa", signed: true },
  async run(context) {
    requireProgramProfile(context, profile);
    const { buildRuntimeIPod } = await import("../../runtime/ipod.ts");
    await buildRuntimeIPod([`--out=${context.outdir}/runtime`]);
  },
};
