// tools/runtime/vita.ts [--out=<dir>] — the generic PS Vita runtime: a
// release eboot.bin with no game in it and no USB debug driver
// (tools/vita.ts --runtime --no-usb-debug --release, cargo feature
// `runtime`), in dist/runtime/vita/.
//
//   eboot.bin                                 the program; started without a game, it
//                                             says on screen that app0:app.pocket is missing
//   sce_sys/icon0.png, sce_sys/livearea/...   PocketJS's default bubble and LiveArea
//                                             (hosts/vita/assets/sce_sys/)
//   runtime.json                              { target, hostAbi, pocketjs, profile, files }
//
// At startup the program reads app0:app.pocket (hosts/vita/src/package_file.rs).
// tools/repack/vita.ts gives it a game: param.sfo, icon and the game's .pocket.

import { $ } from "bun";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { POCKET_TARGETS } from "../../contracts/spec/platforms.ts";
import { VITA_ICON, VITA_LIVEAREA, VITA_RUNTIME_FILE, VITA_RUNTIME_TARGET } from "../repack/vita.ts";
import { DEFAULT_VITA_PACKAGE_ASSETS } from "../vita-package.ts";
import { writeRuntimeManifest } from "./manifest.ts";

const repository = resolvePath(new URL("../..", import.meta.url).pathname);

export async function buildRuntimeVita(argv: readonly string[] = []): Promise<string> {
  let out = join(repository, "dist/runtime/vita");
  for (const argument of argv) {
    if (argument.startsWith("--out=")) out = resolvePath(argument.slice("--out=".length));
    else throw new Error(`usage: bun tools/runtime.ts vita [--out=<dir>] (unknown argument ${argument})`);
  }
  mkdirSync(join(repository, ".pocket-build"), { recursive: true });
  const build = mkdtempSync(join(repository, ".pocket-build/vita-runtime-"));
  try {
    await $`bun tools/vita.ts --runtime --no-usb-debug --release --package-outdir=${build}`.cwd(repository);
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    copyFileSync(join(build, "pocket-runtime.self"), join(out, VITA_RUNTIME_FILE));
  } finally {
    rmSync(build, { recursive: true, force: true });
  }
  const assets = [VITA_ICON, ...VITA_LIVEAREA];
  for (const name of assets) {
    mkdirSync(dirname(join(out, name)), { recursive: true });
    copyFileSync(join(DEFAULT_VITA_PACKAGE_ASSETS, name), join(out, name));
  }
  const manifest = await writeRuntimeManifest(out, {
    target: VITA_RUNTIME_TARGET,
    hostAbi: POCKET_TARGETS.vita.hostAbi,
    profile: "vita",
    files: [VITA_RUNTIME_FILE, ...assets],
  });
  console.log(`output: ${join(out, VITA_RUNTIME_FILE)} (${manifest.files[VITA_RUNTIME_FILE]!.bytes} bytes, PocketJS ${manifest.pocketjs})`);
  return out;
}

if (import.meta.main) {
  try {
    await buildRuntimeVita(Bun.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
