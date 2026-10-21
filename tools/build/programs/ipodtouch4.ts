import { nativeSources } from "./native-sources.ts";
import "../toolchains/ios/armv7-apple-ios.json";
import { compilerOnly, type RuntimeBuild } from "../../../framework/src/runtime-config.ts";
import profile from "../../../profiles/ipodtouch4-dev.ts";
import { requireProgramProfile } from "./application.ts";
import { repackIPod } from "../../repack/ipod.ts";

export const build: RuntimeBuild = {
  hosts: ["darwin-arm64", "darwin-x64"],
  sourceInputs: nativeSources("cabi",
    "hosts/ios-legacy",
    "hosts/ipodtouch4/runtime.c",
    "hosts/ipodtouch4/PkgInfo",
    "hosts/iphone2g/Icon.png",
    "hosts/iphone4s/Icon.svg",
    "platforms/linux/offload/offload_posix.c",
    "platforms/linux/offload/offload_posix.h",
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
