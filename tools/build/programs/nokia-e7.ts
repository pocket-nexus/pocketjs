import { nativeSources } from "./native-sources.ts";
import { lstatSync } from "node:fs";
import { resolve } from "node:path";
import "../toolchains/symbian/armv6-symbian-eabi.json";
import { compilerOnly, type RuntimeBuild, type RuntimeSourceContext } from "../../../framework/src/host-config.ts";
import { POCKET_PROFILES } from "../../../hosts/index.ts";
import { nativeOption, requireProgramProfile, requireApplication } from "./application.ts";
const profile = POCKET_PROFILES["symbian-e7-dev"];

/** Match buildApp's invocation-relative optional file arguments. Generated
 * payloads beside these files are outputs, so their parent is not an input. */
export function nokiaSourceInputs(context: Pick<RuntimeSourceContext, "args" | "invocationDirectory">): string[] {
  const inputs = nativeSources("cabi", "programs/nokia-e7/runtime", "tools/symbian/container", "tools/symbian/Dockerfile");
  for (const option of ["--catalog-index", "--catalog-blob", "--core-library", "--navigation"]) {
    const value = nativeOption(context.args, option);
    if (value === undefined) continue;
    const path = resolve(context.invocationDirectory, value);
    if (!lstatSync(path).isFile()) throw new Error(`Symbian ${option} input is not a regular file: ${path}`);
    inputs.push(path);
  }
  return inputs;
}

export const build: RuntimeBuild = {
  hosts: ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"],
  sourceInputs: nokiaSourceInputs,
  steps: compilerOnly(),
  input: "package",
  artifact: "{outdir}/{output}.sis",
  async run(context) {
    requireProgramProfile(context, profile);
    const { buildApp } = await import("../../symbian.ts");
    const application = requireApplication(context);
    const option = (name: string) => nativeOption(context.args, name);
    const version = option("--sis-version") ?? application.plan.app.version;
    const built = await buildApp(application.manifestPath, version, {
      application, outputRoot: context.outdir,
      perfTrace: context.args.includes("--perf-trace"),
      frameRate: option("--frame-rate") === undefined ? undefined : Number(option("--frame-rate")),
      uid: option("--uid"), navigation: option("--navigation"),
      catalogIndex: option("--catalog-index"), catalogBlob: option("--catalog-blob"),
      coreLibrary: option("--core-library"), massStorageDataRoot: option("--mass-storage-data-root"),
    });
    const { copyFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const output = resolve(context.outdir, `${context.output}.sis`);
    if (resolve(built) !== output) copyFileSync(built, output);
  },
};
