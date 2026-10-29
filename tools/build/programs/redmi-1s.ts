import { nativeSources } from "./native-sources.ts";
import { compilerOnly, type RuntimeBuild } from "../../../framework/src/runtime-config.ts";
import { POCKET_PROFILES } from "../../../profiles/index.ts";
import { requireProgramProfile } from "./application.ts";
import { repackAndroid } from "../../../tools/repack/android.ts";
const profile = POCKET_PROFILES["redmi-1s-dev"];

export const build: RuntimeBuild = {
  hosts: ["darwin-arm64", "darwin-x64", "linux-x64"],
  sourceInputs: nativeSources("android",
    "programs/android/app",
  ),
  steps: compilerOnly(),
  artifact: "{outdir}/runtime",
  genericRuntime: { repack: repackAndroid, extension: ".apk", signed: true },
  async run(context) {
    requireProgramProfile(context, profile);
    const { buildRuntimeAndroid } = await import("../../runtime/android.ts");
    await buildRuntimeAndroid(["--profile=redmi-1s", `--out=${context.outdir}/runtime`]);
  },
};
