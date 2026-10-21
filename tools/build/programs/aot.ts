import { resolve } from "node:path";
import { compilerOnly, type RuntimeBuild } from "../../../framework/src/runtime-config.ts";
import gbaProfile from "../../../profiles/gba.ts";
import nanoProfile from "../../../profiles/ipodnano.ts";
import { buildGba } from "../../../hosts/gba/build.ts";
import { buildIpodNano } from "../../../hosts/ipodnano/build.ts";
import { buildHosts, repository, nativeSources } from "./handheld-common.ts";
import { requireProgramProfile } from "./application.ts";

export const gbaBuild: RuntimeBuild = {
  sourceInputs: [...nativeSources("hosts/gba", "hosts/gba/bake", "engine/core", "engine/spec", "engine/raster"), resolve(repository, "hosts/gba/gba.ld")],
  hosts: buildHosts, input: "aot", steps: compilerOnly(), artifact: "{outdir}/gba-hero.gba",
  async run(context) {
    requireProgramProfile(context, gbaProfile);
    await buildGba(context.args, context);
  },
};
export const ipodNanoBuild: RuntimeBuild = {
  sourceInputs: [...nativeSources("hosts/ipodnano", "hosts/ipodnano/preview", "engine/core", "engine/spec", "engine/raster"), resolve(repository, "hosts/ipodnano/rockbox")],
  hosts: buildHosts, input: "aot", steps: compilerOnly(), artifact: "{outdir}/pockethero.rock",
  async run(context) {
    requireProgramProfile(context, nanoProfile);
    await buildIpodNano(context.args, context);
  },
};
