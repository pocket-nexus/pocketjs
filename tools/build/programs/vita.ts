import { deployVita } from "./deploy.ts";
import { copyFileSync } from "node:fs";
import { resolve } from "node:path";
import { compilerOnly, type RuntimeBuild } from "../../../framework/src/runtime-config.ts";
import profile from "../../../profiles/vita.ts";
import { buildVita } from "../../vita.ts";
import { buildRuntimeVita } from "../../runtime/vita.ts";
import { repackVita } from "../../repack/vita.ts";
import { requireApplication, requireProgramProfile } from "./application.ts";
import { nativeSources, buildHosts, handheldLock, nativeArguments } from "./handheld-common.ts";

export const build: RuntimeBuild = {
  deploy: deployVita,
  sourceInputs: nativeSources("engine/spec", "engine/drivers", "engine/core", "engine/package", "engine/runtime", "engine/runtime-cabi", "engine/present", "engine/raster", "engine/modules/media", "engine/render/glyph-pages", "engine/render/tex-cache", "engine/render/draw-ops", "engine/render/tri-batch", "programs/vita", "platforms/vita", "devices/vita", "devices/vita/pocket-vita-render", "engine/guest-quickjs"),
  hosts: buildHosts, input: "package", steps: compilerOnly(), artifact: "{outdir}/{output}.vpk",
  async run(context) {
    requireProgramProfile(context, profile);
    const app = requireApplication(context);
    await handheldLock("vita", async () => {
      const built = await buildVita([`--plan=${app.planPath}`, `--outdir=${app.directory}`, `--package-outdir=${context.outdir}`, "--skip-build", "--no-usb-debug", "--release", ...nativeArguments(context)], context);
      const output = resolve(context.outdir, `${context.output}.vpk`);
      if (built !== output) copyFileSync(built, output);
    });
  },
};
export const genericBuild: RuntimeBuild = {
  sourceInputs: nativeSources("engine/spec", "engine/drivers", "engine/core", "engine/package", "engine/runtime", "engine/runtime-cabi", "engine/present", "engine/raster", "engine/modules/media", "engine/render/glyph-pages", "engine/render/tex-cache", "engine/render/draw-ops", "engine/render/tri-batch", "programs/vita", "platforms/vita", "devices/vita", "devices/vita/pocket-vita-render", "engine/guest-quickjs"),
  hosts: buildHosts, steps: compilerOnly(), artifact: "{outdir}/runtime",
  genericRuntime: { repack: repackVita, extension: ".vpk" },
  async run(context) {
    requireProgramProfile(context, profile);
    if (context.args.length) throw new Error("Vita generic runtime accepts no native overrides");
    await handheldLock("vita", () => buildRuntimeVita([`--out=${resolve(context.outdir, "runtime")}`], context));
  },
};
