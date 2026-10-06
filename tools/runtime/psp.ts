// tools/runtime/psp.ts [--out=<dir>] — the generic PSP runtime: an
// EBOOT.PBP with no game in it (tools/psp.ts --runtime, cargo feature
// `runtime`), in dist/runtime/psp/.
//
//   EBOOT.PBP      the program; started as it is, it says on screen that its
//                  folder holds no app.pocket
//   runtime.json   { target, hostAbi, pocketjs, profile, files }
//
// At boot the program reads app.pocket from its own folder
// (hosts/psp/src/package_file.rs). tools/repack/psp.ts gives it a game: a new
// PARAM.SFO and ICON0, and the game's .pocket beside it.
//
// The runtime has no io.offload slot; the repack refuses a plan that asks for it.

import { $ } from "bun";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { POCKET_TARGETS } from "../../contracts/spec/platforms.ts";
import { PSP_RUNTIME_FILE, PSP_RUNTIME_TARGET } from "../repack/psp.ts";
import { writeRuntimeManifest } from "./manifest.ts";

const repository = resolvePath(new URL("../..", import.meta.url).pathname);

export async function buildRuntimePsp(argv: readonly string[] = []): Promise<string> {
  let out = join(repository, "dist/runtime/psp");
  for (const argument of argv) {
    if (argument.startsWith("--out=")) out = resolvePath(argument.slice("--out=".length));
    else throw new Error(`usage: bun tools/runtime.ts psp [--out=<dir>] (unknown argument ${argument})`);
  }
  await $`bun tools/psp.ts --runtime --release`.cwd(repository);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  copyFileSync(join(repository, "hosts/psp/target/mipsel-sony-psp/release/EBOOT.PBP"), join(out, PSP_RUNTIME_FILE));
  const manifest = await writeRuntimeManifest(out, {
    target: PSP_RUNTIME_TARGET,
    hostAbi: POCKET_TARGETS.psp.hostAbi,
    profile: "psp",
    files: [PSP_RUNTIME_FILE],
  });
  console.log(`output: ${join(out, PSP_RUNTIME_FILE)} (${manifest.files[PSP_RUNTIME_FILE]!.bytes} bytes, PocketJS ${manifest.pocketjs})`);
  return out;
}

if (import.meta.main) {
  try {
    await buildRuntimePsp(Bun.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
