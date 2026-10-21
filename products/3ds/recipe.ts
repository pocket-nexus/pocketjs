import { resolve } from "node:path";
import { compilerOnly, type RuntimeBuild } from "../../framework/src/runtime-config.ts";
import profile from "../../profiles/3ds-dev.ts";
import { build3ds } from "./build.ts";
import { requireApplication, requireProgramProfile } from "../../tools/build/programs/application.ts";
import { repository, nativeSources, programFiles, buildHosts, handheldLock, nativeArguments } from "../../tools/build/programs/handheld-common.ts";
export const build: RuntimeBuild = {
  sourceInputs: [
    ...nativeSources("engine/spec", "engine/drivers", "engine/core", "engine/package", "engine/runtime", "engine/runtime-cabi", "engine/present", "engine/raster", "engine/modules/media", "engine/render/glyph-pages", "engine/render/tex-cache", "engine/render/draw-ops", "engine/render/tri-batch", "products/3ds", "products/3ds/core", "devices/3ds/pocket-3ds-pica", "engine/guest-quickjs"),
    ...programFiles("products/3ds", /\.(png|rsf)$/),
    resolve(repository, "platforms/3ds"), resolve(repository, "engine/modules/offload/include"),
  ],
  hosts: buildHosts, input: "package", steps: compilerOnly(), artifact: "{outdir}/{output}.3dsx",
  async run(context) {
    requireProgramProfile(context, profile);
    const app = requireApplication(context);
    await handheldLock("3ds", () => build3ds([`--plan=${app.planPath}`, `--outdir=${app.directory}`,
      `--package-outdir=${context.outdir}`, "--skip-build", ...nativeArguments(context)], context));
  },
};
