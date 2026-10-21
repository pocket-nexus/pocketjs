import { resolve } from "node:path";
import { compilerOnly, type RuntimeBuild } from "../../../framework/src/runtime-config.ts";
import profile from "../../../profiles/3ds-dev.ts";
import genericProfile from "../../../profiles/3ds-runtime.ts";
import { build3ds } from "../../3ds.ts";
import { buildRuntime3ds } from "../../runtime/3ds.ts";
import { repack3ds } from "../../repack/3ds.ts";
import { requireApplication, requireProgramProfile } from "./application.ts";
import { nativeSources, buildHosts, handheldLock, nativeArguments } from "./handheld-common.ts";

export const build: RuntimeBuild = {
  sourceInputs: nativeSources("engine/spec", "engine/drivers", "engine/core", "engine/package", "engine/runtime", "engine/runtime-cabi", "engine/present", "engine/raster", "engine/modules", "engine/media", "engine/render/glyph-pages", "engine/render/tex-cache", "engine/render/draw-ops", "engine/render/tri-batch", "hosts/3ds", "hosts/3ds/core", "devices/3ds/pocket-3ds-pica", "engine/guest-quickjs"),
  hosts: buildHosts, input: "package", steps: compilerOnly(), artifact: "{outdir}/{output}.3dsx",
  async run(context) {
    requireProgramProfile(context, profile);
    const app = requireApplication(context);
    await handheldLock("3ds", () => build3ds([`--plan=${app.planPath}`, `--outdir=${app.directory}`, `--package-outdir=${context.outdir}`, "--skip-build", ...nativeArguments(context)], context));
  },
};
export const genericBuild: RuntimeBuild = {
  sourceInputs: nativeSources("engine/spec", "engine/drivers", "engine/core", "engine/package", "engine/runtime", "engine/runtime-cabi", "engine/present", "engine/raster", "engine/modules", "engine/media", "engine/render/glyph-pages", "engine/render/tex-cache", "engine/render/draw-ops", "engine/render/tri-batch", "hosts/3ds", "hosts/3ds/core", "devices/3ds/pocket-3ds-pica", "engine/guest-quickjs"),
  hosts: buildHosts, steps: compilerOnly(), artifact: "{outdir}/runtime",
  genericRuntime: { repack: repack3ds, extension: ".3dsx" },
  async run(context) {
    requireProgramProfile(context, genericProfile);
    if (context.args.length) throw new Error("3DS generic runtime accepts no native overrides");
    await handheldLock("3ds", () => buildRuntime3ds([`--out=${resolve(context.outdir, "runtime")}`], context));
  },
};
