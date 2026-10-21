import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { RuntimeBuildContext } from "../../../framework/src/runtime-config.ts";

function verifiedCopy(source: string, destination: string): string {
  const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
  const expected = digest(source);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
  if (digest(destination) !== expected) throw new Error("deployment readback differs from the built artifact");
  return expected;
}
function outputName(context: RuntimeBuildContext): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(context.output)) throw new Error("invalid deployment output name");
  return context.output;
}
/** Called by the executor only for --deploy; never rebuilds or launches an app. */
export function deployPsp(context: RuntimeBuildContext): void {
  const volume = context.env.POCKET_PSP_VOLUME ?? process.env.POCKET_PSP_VOLUME;
  if (!volume || !existsSync(resolve(volume, "PSP/GAME"))) throw new Error("PSP deploy requires POCKET_PSP_VOLUME pointing to a mounted volume with PSP/GAME");
  const output = outputName(context);
  const destination = resolve(volume, "PSP/GAME", output, "EBOOT.PBP");
  const sha = verifiedCopy(resolve(context.outdir, `${output}.pbp`), destination);
  console.log(`Copied ${destination} (sha256:${sha})`);
}
/** Stages this build's VPK; VitaShell owns installation and LiveArea launch. */
export function deployVita(context: RuntimeBuildContext): void {
  const volume = context.env.POCKET_VITA_VOLUME ?? process.env.POCKET_VITA_VOLUME;
  if (!volume || !existsSync(resolve(volume, "VitaShell"))) throw new Error("Vita deploy requires POCKET_VITA_VOLUME pointing to the VitaShell USB volume");
  const output = outputName(context);
  const destination = resolve(volume, "data/pocketjs-dev", `${output}.vpk`);
  const sha = verifiedCopy(resolve(context.outdir, `${output}.vpk`), destination);
  console.log(`Staged ${destination} (sha256:${sha}); install the VPK in VitaShell.`);
}
