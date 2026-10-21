import { nativeSources } from "./native-sources.ts";
import "../toolchains/symbian/armv6-symbian-eabi.json";
import { compilerOnly, type RuntimeBuild } from "../../../framework/src/runtime-config.ts";
import profile from "../../../profiles/symbian-e7-dev.ts";
import { nativeOption, requireProgramProfile, requireApplication } from "./application.ts";

export const build: RuntimeBuild = {
  hosts: ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"],
  sourceInputs: nativeSources("cabi",
    "hosts/nokia-e7/runtime",
    "tools/symbian/container",
    "tools/symbian/Dockerfile",
  ),
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
