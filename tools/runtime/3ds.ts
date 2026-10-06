// tools/runtime/3ds.ts [--out=<dir>] — the generic Nintendo 3DS runtime: the
// hosts/3ds program with no game, in dist/runtime/3ds/.
//
//   runtime.3dsx   the program, the host's SMDH (PocketJS mark, "PocketJS
//                  Runtime") and no RomFS: started as it is, it says on the
//                  bottom screen that it carries no game
//   runtime.json   { target, hostAbi, pocketjs, profile, files }
//
// The host reads a game's surfaces and its state directory on the SD card
// from the plan and identity of romfs:/app.pocket at boot (hosts/3ds/src/
// main.c), so nothing here depends on a game. tools/repack/3ds.ts gives the
// program a game: a new SMDH and a RomFS holding the game's `.pocket`.
//
// The runtime leaves out io.offload and media.playback; the repack refuses a
// plan that asks for either.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { containerPathFor } from "../3ds-toolchain.ts";
import { prepare3dsNative, run3dsMake } from "../3ds.ts";
import { THREE_DS_DEV_HOST_ABI, THREE_DS_DEV_TARGET_ID } from "../3ds-profile.ts";
import { THREE_DS_RUNTIME_FILE } from "../repack/3ds.ts";
import { writeRuntimeManifest } from "./manifest.ts";

const repository = resolvePath(new URL("../..", import.meta.url).pathname);

export async function buildRuntime3ds(argv: readonly string[] = []): Promise<string> {
  let out = join(repository, "dist/runtime/3ds");
  for (const argument of argv) {
    if (argument.startsWith("--out=")) out = resolvePath(argument.slice("--out=".length));
    else throw new Error(`usage: bun tools/runtime.ts 3ds [--out=<dir>] (unknown argument ${argument})`);
  }
  const native = await prepare3dsNative({ cargoArgs: [], roots: [out] });
  const buildDirectory = join(repository, "dist/3ds/build/runtime");
  mkdirSync(buildDirectory, { recursive: true });
  mkdirSync(out, { recursive: true });
  const program = join(out, THREE_DS_RUNTIME_FILE);
  rmSync(program, { force: true });
  await run3dsMake(
    {
      POCKETJS_TARGET: THREE_DS_DEV_TARGET_ID,
      POCKETJS_HOST_ABI: String(THREE_DS_DEV_HOST_ABI),
      POCKETJS_PICA_INCLUDE: containerPathFor(join(repository, "devices/3ds/pocket-3ds-pica/include"), native.mounts),
      POCKETJS_CORE_LIB: containerPathFor(native.coreLibrary, native.mounts),
      POCKETJS_QUICKJS_DIR: containerPathFor(native.quickJsDirectory, native.mounts),
      POCKETJS_APP_POCKET: "",
      POCKETJS_BUILD_DIR: containerPathFor(buildDirectory, native.mounts),
      POCKETJS_OUT_3DSX: containerPathFor(program, native.mounts),
      POCKETJS_OFFLOAD: "",
      POCKETJS_MEDIA: "",
      POCKETJS_SMDH_TITLE: "PocketJS Runtime",
      POCKETJS_SMDH_AUTHOR: "Pocket Nexus",
      POCKETJS_SMDH_DESC: "PocketJS 3DS runtime: repack it with a game",
      POCKETJS_CAPTURE: "",
      POCKETJS_CAPTURE_INPUT: "",
      POCKETJS_CAPTURE_TOUCH: "",
      POCKETJS_CAP_START: "",
      POCKETJS_CAP_N: "",
      POCKETJS_OUT_CIA: "",
    },
    native.mounts,
    ["runtime"],
  );
  const manifest = await writeRuntimeManifest(out, {
    target: THREE_DS_DEV_TARGET_ID,
    hostAbi: THREE_DS_DEV_HOST_ABI,
    profile: THREE_DS_DEV_TARGET_ID,
    files: [THREE_DS_RUNTIME_FILE],
  });
  console.log(`output: ${program} (${manifest.files[THREE_DS_RUNTIME_FILE]!.bytes} bytes, PocketJS ${manifest.pocketjs})`);
  return out;
}

if (import.meta.main) {
  try {
    await buildRuntime3ds(Bun.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
