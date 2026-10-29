import { deployPsp } from "./deploy.ts";
import { copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { compilerOnly, type RuntimeBuild } from "../../../framework/src/host-config.ts";
import { POCKET_PROFILES } from "../../../hosts/index.ts";
import { buildPsp } from "../../psp.ts";
import { buildRuntimePsp } from "../../runtime/psp.ts";
import { repackPsp } from "../../repack/psp.ts";
import { pspToolchain } from "../toolchains/psp.ts";
import { requireApplication, requireProgramProfile } from "./application.ts";
import { nativeSources, buildHosts, handheldLock, nativeArguments } from "./handheld-common.ts";
import { launcherSourceInputs } from "../psp/launcher.ts";
const profile = POCKET_PROFILES["psp"];
const genericProfile = POCKET_PROFILES["psp-runtime"];

export const build: RuntimeBuild = {
  deploy: deployPsp,
  sourceInputs: context => [resolve(import.meta.dir, "../embedded-apps.rs"), ...nativeSources("engine/spec", "engine/drivers", "engine/core", "engine/package", "engine/runtime", "engine/runtime-cabi", "engine/profile-build", "engine/present", "engine/raster", "engine/modules/media", "engine/render/glyph-pages", "engine/render/tex-cache", "engine/render/draw-ops", "engine/render/tri-batch", "programs/psp", "platforms/psp", "devices/psp", "devices/psp/pocket-psp-render", "engine/guest-quickjs"), ...launcherSourceInputs(context)],
  hosts: buildHosts, toolchain: pspToolchain, input: "package", steps: compilerOnly(), artifact: "{outdir}/{output}.pbp",
  async run(context) {
    requireProgramProfile(context, profile);
    const app = requireApplication(context);
    await handheldLock("psp", async () => {
      const built = await buildPsp([`--plan=${app.planPath}`, `--outdir=${app.directory}`, "--skip-build", "--release", ...nativeArguments(context)], context);
      mkdirSync(context.outdir, { recursive: true });
      copyFileSync(built, resolve(context.outdir, `${context.output}.pbp`));
    });
  },
};
export const genericBuild: RuntimeBuild = {
  sourceInputs: [resolve(import.meta.dir, "../embedded-apps.rs"), ...nativeSources("engine/spec", "engine/drivers", "engine/core", "engine/package", "engine/runtime", "engine/runtime-cabi", "engine/profile-build", "engine/present", "engine/raster", "engine/modules/media", "engine/render/glyph-pages", "engine/render/tex-cache", "engine/render/draw-ops", "engine/render/tri-batch", "programs/psp", "platforms/psp", "devices/psp", "devices/psp/pocket-psp-render", "engine/guest-quickjs")],
  hosts: buildHosts, toolchain: pspToolchain, steps: compilerOnly(), artifact: "{outdir}/runtime",
  genericRuntime: { repack: repackPsp, extension: ".zip" },
  async run(context) {
    requireProgramProfile(context, genericProfile);
    if (context.args.length) throw new Error("PSP generic runtime accepts no native overrides");
    await handheldLock("psp", () => buildRuntimePsp([`--out=${resolve(context.outdir, "runtime")}`], context));
  },
};
