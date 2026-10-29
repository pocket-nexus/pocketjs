import { copyFileSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { resolve } from "node:path";
import { cargo, type RuntimeBuild, type RuntimeBuildContext } from "../../../framework/src/runtime-config.ts";
import { POCKET_PROFILES } from "../../../profiles/index.ts";
import { requireApplication, requireProgramProfile } from "./application.ts";
import { repository, nativeSources } from "./handheld-common.ts";
const macosProfile = POCKET_PROFILES["macos-app"];
const linuxProfile = POCKET_PROFILES["linux-app"];
const widgetProfile = POCKET_PROFILES["macos-widget"];

function stageApplication(context: RuntimeBuildContext, directory = resolve(context.outdir, "application")): void {
  const app = requireApplication(context);
  mkdirSync(directory, { recursive: true });
  copyFileSync(app.jsPath, resolve(directory, `${context.output}.js`));
  copyFileSync(app.pakPath, resolve(directory, `${context.output}.pak`));
  copyFileSync(app.packagePath, resolve(directory, "app.pocket"));
  copyFileSync(app.planPath, resolve(directory, "app.plan.json"));
}
function desktopBuild(platform: "macos" | "linux"): RuntimeBuild {
  const profile = platform === "macos" ? macosProfile : linuxProfile;
  return {
    sourceInputs: nativeSources("engine/spec", "engine/drivers", "engine/core", "engine/package", "engine/runtime", "engine/runtime-cabi", "engine/present", "engine/raster", "engine/modules/media", "engine/render/glyph-pages", "engine/render/tex-cache", "engine/render/draw-ops", "engine/render/tri-batch", "engine/profile-build", "programs/desktop", "platforms/posix/svc-wire", "engine/crates/pocket-ui-surface", "engine/crates/pocket-ui-wgpu", "engine/crates/pocket-mod", "engine/guest-rquickjs", "devices/web/pocket-web-wgpu"),
    input: "package",
    hosts: platform === "macos" ? ["darwin-arm64", "darwin-x64"] : ["linux-arm64", "linux-x64"],
    steps: cargo({ manifest: resolve(repository, "programs/desktop/Cargo.toml"), targetDirectory: "{outdir}/cargo-target" }),
    artifact: "{outdir}/program",
    async run(context) {
      requireProgramProfile(context, profile);
      if (context.args.length) throw new Error("Desktop native recipe accepts no extra compiler arguments");
      const app = requireApplication(context);
      const directory = resolve(context.outdir, "program");
      stageApplication(context, directory);
      copyFileSync(resolve(context.outdir, "cargo-target/release/pocket-desktop-host"), resolve(directory, "pocket-desktop-host"));
      const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
      const args = ["--app", context.output, "--js", `${context.output}.js`, "--pak", `${context.output}.pak`,
        "--viewport", app.plan.viewport.logical.join("x"), "--density", String(app.plan.viewport.rasterDensity), "--title", app.plan.app.title,
        ...(app.plan.viewport.policy === "fixed" ? ["--fixed"] : [])];
      writeFileSync(resolve(directory, "run"), '#!/bin/sh\ncd -- "$(dirname -- "$0")" || exit 1\nexec ./pocket-desktop-host ' + args.map(quote).join(" ") + ' "$@"\n');
      chmodSync(resolve(directory, "run"), 0o755);
    },
  };
}
export const macosBuild = desktopBuild("macos");
export const linuxBuild = desktopBuild("linux");
export const widgetBuild: RuntimeBuild = {
  sourceInputs: nativeSources("engine/spec", "engine/drivers", "engine/core", "engine/package", "engine/runtime", "engine/runtime-cabi", "engine/present", "engine/raster", "engine/modules/media", "engine/render/glyph-pages", "engine/render/tex-cache", "engine/render/draw-ops", "engine/render/tri-batch", "engine/profile-build", "engine/pocket3d/examples/note-widget", "engine/crates/pocket-ui-surface", "engine/crates/pocket-ui-wgpu", "engine/crates/pocket-mod", "engine/guest-rquickjs", "devices/web/pocket-web-wgpu"),
  hosts: ["darwin-arm64", "darwin-x64"], input: "package",
  steps: cargo({ manifest: resolve(repository, "Cargo.toml"), package: "note-widget", targetDirectory: "{outdir}/cargo-target" }),
  artifact: "{outdir}/application",
  async run(context) {
    requireProgramProfile(context, widgetProfile);
    stageApplication(context);
    const directory = resolve(context.outdir, "application");
    copyFileSync(resolve(context.outdir, "cargo-target/release/note-widget"), resolve(directory, "pocket-widget"));
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    writeFileSync(resolve(directory, "run"), '#!/bin/sh\ncd -- "$(dirname -- "$0")" || exit 1\nexport POCKETJS_DIST="$PWD"\nexec ./pocket-widget --app ' + quote(context.output) + ' "$@"\n');
    chmodSync(resolve(directory, "run"), 0o755);
  },
};
