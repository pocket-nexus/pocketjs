import { resolve } from "node:path";
import { compilerOnly, type RuntimeBuild } from "../../../framework/src/runtime-config.ts";
import gbaProfile from "../../../profiles/gba.ts";
import nanoProfile from "../../../profiles/ipodnano.ts";
import { buildGba } from "../gba/build.ts";
import { buildIpodNano } from "../ipodnano/build.ts";
import { buildHosts, repository, nativeSources } from "./handheld-common.ts";
import { requireProgramProfile } from "./application.ts";

const runtimeSources = ["engine/core", "engine/spec", "engine/drivers", "engine/package", "engine/runtime", "engine/present", "engine/raster", "engine/modules/media", "engine/render/draw-ops", "engine/render/glyph-pages", "engine/render/tex-cache", "engine/render/tri-batch", "engine/crates/microts", "engine/profile-build"];

export const gbaBuild: RuntimeBuild = {
  sourceInputs: [...nativeSources("programs/gba", "platforms/gba/video", "tools/build/gba/bake", ...runtimeSources), resolve(repository, "programs/gba/gba.ld")],
  hosts: buildHosts, input: "aot", steps: compilerOnly(), artifact: "{outdir}/gba-hero.gba",
  async run(context) {
    requireProgramProfile(context, gbaProfile);
    await buildGba(context.args, context);
  },
};
export const ipodNanoBuild: RuntimeBuild = {
  sourceInputs: [...nativeSources("programs/ipodnano", "platforms/rockbox/input", "programs/ipodnano/preview", ...runtimeSources), resolve(repository, "programs/ipodnano/rockbox"), resolve(repository, "platforms/rockbox/display")],
  hosts: buildHosts, input: "aot", steps: compilerOnly(), artifact: "{outdir}/pockethero.rock",
  async run(context) {
    requireProgramProfile(context, nanoProfile);
    await buildIpodNano(context.args, context);
  },
};
