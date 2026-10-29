import { STABLE_RUST_TOOLCHAIN } from "../toolchains/rust.ts";
import { cadenceFor } from "../../../contracts/spec/admission.ts";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { cargo, type RuntimeBuild } from "../../../framework/src/runtime-config.ts";
import { POCKET_PROFILES } from "../../../profiles/index.ts";
import { writeRuntimeManifest } from "../../runtime/manifest.ts";
import { POCKET_BINDING_GENERATION } from "../../../contracts/spec/binding-generation.ts";
import { repository, buildHosts, nativeSources } from "./handheld-common.ts";
import { requireProgramProfile, requireApplication } from "./application.ts";

import { stageWebAssets, webAssetSources } from "../web-assets.ts";
const profile = POCKET_PROFILES["web-app"];

export const wasmStep = cargo({ manifest: resolve(repository, "programs/web/wasm/Cargo.toml"), toolchain: STABLE_RUST_TOOLCHAIN, env: { CARGO_PROFILE_RELEASE_LTO: "true", CARGO_PROFILE_RELEASE_OPT_LEVEL: "s" }, target: "wasm32-unknown-unknown", targetDirectory: "{outdir}/cargo-target" });
export const build: RuntimeBuild = {
  sourceInputs: [...nativeSources("engine/spec", "engine/drivers", "engine/core", "engine/package", "engine/runtime", "engine/runtime-cabi", "engine/present", "engine/raster", "engine/modules/media", "engine/render/glyph-pages", "engine/render/tex-cache", "engine/render/draw-ops", "engine/render/tri-batch", "programs/web/wasm", "engine/crates/pocket-text", "engine/guest-web"), ...webAssetSources(), resolve(repository, "programs/web/main.js"), resolve(repository, "programs/web/index.html")],
  hosts: buildHosts, input: "package",
  steps: [wasmStep, cargo({ manifest: resolve(repository, "engine/crates/pocket-text/Cargo.toml"), toolchain: STABLE_RUST_TOOLCHAIN, env: { CARGO_PROFILE_RELEASE_LTO: "true", CARGO_PROFILE_RELEASE_OPT_LEVEL: "s" }, target: "wasm32-unknown-unknown", targetDirectory: "{outdir}/cargo-text-target" })],
  artifact: "{outdir}/runtime",
  async run(context) {
    requireProgramProfile(context, profile);
    if (context.args.length) throw new Error("Web native recipe accepts no extra compiler arguments");
    const out = resolve(context.outdir, "runtime");
    mkdirSync(out, { recursive: true });
    const files = stageWebAssets(out, {
      wasm: resolve(context.outdir, "cargo-target/wasm32-unknown-unknown/release/pocketjs_wasm.wasm"),
      textWasm: resolve(context.outdir, "cargo-text-target/wasm32-unknown-unknown/release/pocket_text.wasm"),
    });
    const application = requireApplication(context);
    {
      mkdirSync(resolve(out, "dist"), { recursive: true });
      for (const [input, file] of [[application.jsPath, `dist/${context.output}.js`], [application.pakPath, `dist/${context.output}.pak`], [application.packagePath, "app.pocket"]]) {
        copyFileSync(input!, resolve(out, file!)); files.push(file!);
      }
      copyFileSync(resolve(repository, "programs/web/index.html"), resolve(out, "index.html"));
      copyFileSync(resolve(repository, "programs/web/main.js"), resolve(out, "programs/web/main.js"));
      const viewport = application.plan.viewport;
      writeFileSync(resolve(out, "program.json"), JSON.stringify({ output: context.output, packageId: application.plan.app.id, title: application.plan.app.title,
        host: context.profile.id, hostAbi: POCKET_BINDING_GENERATION, viewport: viewport.logical, rasterDensity: viewport.rasterDensity, simHz: cadenceFor(application.plan.profile.tickHz, context.profile.cadences) ?? application.plan.profile.tickHz,
        ...(application.plan.surfaces?.auxiliary ? { auxiliary: application.plan.surfaces?.auxiliary.logical } : {}),
        ...(viewport.policy === "dynamic" ? { dynamic: context.profile.display.dynamicViewport } : {}) }));
      files.push("index.html", "programs/web/main.js", "program.json");
    }
    await writeRuntimeManifest(out, { target: profile.id, profile: context.profile, hostAbi: POCKET_BINDING_GENERATION, files });
  },
};
