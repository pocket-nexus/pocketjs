import { mkdirSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { compilerOnly, type RuntimeBuild, type RuntimeBuildContext } from "../../../framework/src/runtime-config.ts";
import { canonicalProfileJson, hashPocketProfile } from "../../../framework/src/profile.ts";
import { POCKET_BINDING_GENERATION } from "../../../contracts/spec/binding-generation.ts";
import profile from "../../../profiles/3ds-runtime.ts";
import { prepareNative3ds, runNative3dsMake, containerPathFor } from "../3ds/native.ts";
import { repack3ds, THREE_DS_RUNTIME_FILE } from "../../repack/3ds.ts";
import { writeRuntimeManifest } from "../../runtime/manifest.ts";
import { exportProfile } from "../../profile-export.ts";
import { requireProgramProfile } from "./application.ts";
import { repository, nativeSources, programFiles, buildHosts, handheldLock } from "./handheld-common.ts";

/** Build the file-loaded program, with no product sources or package parser. */
export async function buildMinimal3ds(out: string, context?: RuntimeBuildContext): Promise<string> {
  const outdir = resolve(out), buildDirectory = context ? resolve(context.outdir, "native") : `${outdir}.native`;
  mkdirSync(buildDirectory, { recursive: true });
  exportProfile({ profile, profileHash: hashPocketProfile(profile), hostAbi: POCKET_BINDING_GENERATION,
    dependencies: [] }, buildDirectory);
  const native = await prepareNative3ds({ packageName: "pocket-runtime-cabi",
    archiveName: "libpocket_runtime_cabi.a", targetDirectory: join(repository, ".pocket-build/native/3ds/minimal"),
    roots: [outdir], context });
  const program = join(outdir, THREE_DS_RUNTIME_FILE);
  rmSync(program, { force: true });
  await runNative3dsMake({ directory: join(repository, "programs/3ds"), mounts: native.mounts, profile, context,
    environment: {
      POCKETJS_ROOT: containerPathFor(repository, native.mounts),
      POCKETJS_PROFILE_JSON: canonicalProfileJson(profile), POCKETJS_PROFILE_HASH: hashPocketProfile(profile),
      POCKETJS_RUNTIME_LIB: containerPathFor(native.library, native.mounts),
      POCKETJS_QUICKJS_DIR: containerPathFor(native.quickJsDirectory, native.mounts),
      POCKETJS_BUILD_DIR: containerPathFor(buildDirectory, native.mounts),
      POCKETJS_OUT_3DSX: containerPathFor(program, native.mounts),
    } });
  await writeRuntimeManifest(outdir, { target: profile.id, hostAbi: POCKET_BINDING_GENERATION,
    profile: profile.id, profileHash: hashPocketProfile(profile), files: [THREE_DS_RUNTIME_FILE] });
  return outdir;
}
export const build: RuntimeBuild = {
  sourceInputs: [
    ...nativeSources("engine/spec", "engine/drivers", "engine/core", "engine/package", "engine/runtime", "engine/runtime-cabi", "engine/present", "engine/raster", "engine/modules/media", "engine/render/glyph-pages", "engine/render/tex-cache", "engine/render/draw-ops", "engine/render/tri-batch", "devices/3ds/pocket-3ds-pica", "engine/guest-quickjs"),
    ...programFiles("programs/3ds", /\.(c|h|png)$/), resolve(repository, "programs/3ds/Makefile"),
    ...["hooks.c", "input.c", "input.h", "input_source.c", "input_source.h"].map(path => resolve(repository, "platforms/3ds", path)),
  ],
  hosts: buildHosts, steps: compilerOnly(), artifact: "{outdir}/runtime",
  genericRuntime: { repack: repack3ds, extension: ".3dsx" },
  async run(context) {
    requireProgramProfile(context, profile);
    if (context.args.length) throw new Error("3DS generic runtime accepts no native overrides");
    await handheldLock("3ds", () => buildMinimal3ds(resolve(context.outdir, "runtime"), context));
  },
};
