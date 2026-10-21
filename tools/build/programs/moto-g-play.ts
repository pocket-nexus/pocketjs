import { nativeSources } from "./native-sources.ts";
import { compilerOnly, type RuntimeBuild } from "../../../framework/src/runtime-config.ts";
import profile from "../../../profiles/moto-g-play-dev.ts";
import { requireProgramProfile } from "./application.ts";
import { repackAndroid } from "../../repack/android.ts";

export const build: RuntimeBuild = {
  hosts: ["darwin-arm64", "darwin-x64", "linux-x64"],
  sourceInputs: nativeSources("cabi",
    "hosts/android/app",
    "hosts/blackberry-classic/pocket_input.c",
    "hosts/blackberry-classic/pocket_input.h",
    "platforms/linux/offload/offload_posix.c",
    "platforms/linux/offload/offload_posix.h",
  ),
  steps: compilerOnly(),
  artifact: "{outdir}/runtime",
  genericRuntime: { repack: repackAndroid, extension: ".apk", signed: true },
  async run(context) {
    requireProgramProfile(context, profile);
    const { buildRuntimeAndroid } = await import("../../runtime/android.ts");
    await buildRuntimeAndroid(["--profile=moto-g-play", `--out=${context.outdir}/runtime`]);
  },
};
