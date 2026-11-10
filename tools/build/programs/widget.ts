import { copyFileSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { resolve } from "node:path";
import { cargo, type RuntimeBuild, type RuntimeBuildContext } from "../../../framework/src/host-config.ts";
import { POCKET_PROFILES } from "../../../hosts/index.ts";
import { requireApplication, requireProgramProfile } from "./application.ts";
import { repository, nativeSources } from "./handheld-common.ts";
const widgetProfile = POCKET_PROFILES["macos-widget"];

function stageApplication(context: RuntimeBuildContext, directory = resolve(context.outdir, "application")): void {
  const app = requireApplication(context);
  mkdirSync(directory, { recursive: true });
  copyFileSync(app.jsPath, resolve(directory, `${context.output}.js`));
  copyFileSync(app.pakPath, resolve(directory, `${context.output}.pak`));
  copyFileSync(app.packagePath, resolve(directory, "app.pocket"));
  copyFileSync(app.planPath, resolve(directory, "app.plan.json"));
}
export const widgetBuild: RuntimeBuild = {
  sourceInputs: nativeSources("engine/spec", "engine/drivers", "engine/core", "engine/package", "engine/runtime", "programs/sdk/archive", "engine/physics", "engine/modules/media", "engine/render", "engine/profile-build", "engine/pocket3d/examples/note-widget", "engine/ui-surface", "engine/ui-wgpu", "engine/mod", "engine/guest-rquickjs", "engine/pocket3d/crates/pocket-web-wgpu"),
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
