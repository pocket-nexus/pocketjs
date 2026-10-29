import { POCKET_BINDING_GENERATION } from "../../../contracts/spec/binding-generation.ts";
import { cadenceFor } from "../../../contracts/spec/admission.ts";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { type RuntimeBuild } from "../../../framework/src/host-config.ts";
import { wasmStep } from "./web.ts";
import { repository, buildHosts, nativeSources, programFiles } from "./handheld-common.ts";
import { requireApplication } from "./application.ts";

export const build: RuntimeBuild = {
  sourceInputs: [...nativeSources("engine/spec", "engine/drivers", "engine/core", "engine/package", "engine/runtime", "engine/runtime-cabi", "engine/present", "engine/raster", "engine/modules/media", "engine/render/glyph-pages", "engine/render/tex-cache", "engine/render/draw-ops", "engine/render/tri-batch", "engine/guest-web", "programs/web/wasm"), ...programFiles("platforms/web", /\.js$/), ...programFiles("platforms/sim", /\.ts$/), ...programFiles("programs/sim", /\.ts$/), resolve(repository, "programs/sim/main.ts")],
  hosts: buildHosts, input: "package", steps: wasmStep, artifact: "{outdir}/simulation",
  async run(context) {
    const app = requireApplication(context), out = resolve(context.outdir, "simulation");
    mkdirSync(out, { recursive: true });
    await context.run([process.execPath, "build", resolve(repository, "programs/sim/main.ts"), "--target=bun", `--outfile=${resolve(out, "run.js")}`]);
    copyFileSync(resolve(context.outdir, "cargo-target/wasm32-unknown-unknown/release/pocketjs_wasm.wasm"), resolve(out, "pocketjs.wasm"));
    copyFileSync(app.jsPath, resolve(out, "app.js")); copyFileSync(app.pakPath, resolve(out, "app.pak"));
    copyFileSync(app.packagePath, resolve(out, "app.pocket"));
    const viewport = app.plan.viewport;
    writeFileSync(resolve(out, "program.json"), JSON.stringify({ js: "app.js", pak: "app.pak", app: context.output, hz: cadenceFor(app.plan.profile.tickHz, context.profile.cadences) ?? app.plan.profile.tickHz,
      viewport: { host: context.profile.id, hostAbi: POCKET_BINDING_GENERATION, width: viewport.logical[0], height: viewport.logical[1], rasterDensity: viewport.rasterDensity, ...(app.plan.surfaces?.auxiliary ? { auxiliary: app.plan.surfaces?.auxiliary.logical } : {}) } }));
  },
};
