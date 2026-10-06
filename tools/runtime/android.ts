// The generic Android runtime: what tools/android.ts build-app compiles for
// every game of a profile, built once, with no game in it.
//
//   bun tools/runtime.ts android [--profile=redmi-1s] [--out=dist/runtime/android]
//
// Writes into the output directory:
//   lib/armeabi-v7a/libpocketjs.so, lib/arm64-v8a/libpocketjs.so
//                        Rust core + QuickJS + host, compiled with the
//                        profile's target id, host ABI and viewport only
//   classes.dex          PocketActivity (reads assets/app.js and app.pak)
//   AndroidManifest.xml  the manifest template (@POCKET_*@ placeholders)
//   res/values/strings.xml   the label template
//   res/mipmap-*/icon.png    the default launcher icon (PocketJS's mark)
//   runtime.json         target, hostAbi, pocketjs, profile, viewport, android, files
//
// tools/repack/android.ts turns it and a `.pocket` into an APK.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { MOTO_G_PLAY_CONTRACTS, MOTO_G_PLAY_TARGET } from "../moto-g-play-profile.ts";
import { REDMI_1S_CONTRACTS, REDMI_1S_TARGET } from "../redmi-1s-profile.ts";
import { writeRuntimeManifest } from "./manifest.ts";

const repository = resolve(import.meta.dir, "../..");

interface Contract {
  readonly hostAbi: number;
  readonly display: { readonly logicalViewports: readonly (readonly number[])[]; readonly rasterDensity: number };
}

/** The Android profiles a runtime can be built for, by tools/android.ts profile name. */
export const ANDROID_RUNTIME_PROFILES: Readonly<Record<string, { readonly target: string; readonly contract: Contract }>> = {
  "redmi-1s": { target: REDMI_1S_TARGET, contract: REDMI_1S_CONTRACTS.targets[REDMI_1S_TARGET] },
  "moto-g-play": { target: MOTO_G_PLAY_TARGET, contract: MOTO_G_PLAY_CONTRACTS.targets[MOTO_G_PLAY_TARGET] },
};

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

export async function buildRuntimeAndroid(argv: readonly string[] = []): Promise<string> {
  let profile = "redmi-1s";
  let out: string | undefined;
  for (const argument of argv) {
    if (argument.startsWith("--profile=")) profile = argument.slice("--profile=".length);
    else if (argument.startsWith("--out=")) out = resolve(argument.slice("--out=".length));
    else throw new Error(`usage: bun tools/runtime.ts android [--profile=<${Object.keys(ANDROID_RUNTIME_PROFILES).join("|")}>] [--out=<dir>] (unknown argument ${argument})`);
  }
  const chosen = ANDROID_RUNTIME_PROFILES[profile];
  if (!chosen) throw new Error(`runtime android: no profile ${profile}; use ${Object.keys(ANDROID_RUNTIME_PROFILES).join(" or ")}`);
  out ??= join(repository, profile === "redmi-1s" ? "dist/runtime/android" : `dist/runtime/android-${profile}`);

  const started = performance.now();
  const build = Bun.spawnSync(["bun", join(repository, "tools/android.ts"), `--profile=${profile}`, "runtime", `--out=${out}`], {
    cwd: repository,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (build.exitCode !== 0) throw new Error(`runtime android: tools/android.ts runtime exited ${build.exitCode}`);

  const toolchain = JSON.parse(readFileSync(join(repository, `tools/cli/${profile}-toolchain.json`), "utf8"));
  const files = walk(out).map((path) => relative(out!, path).split("\\").join("/")).filter((name) => name !== "runtime.json").sort();
  const manifest = await writeRuntimeManifest(out, {
    target: chosen.target,
    hostAbi: chosen.contract.hostAbi,
    profile,
    files,
    extra: {
      viewport: { logical: chosen.contract.display.logicalViewports[0], rasterDensity: chosen.contract.display.rasterDensity },
      android: {
        toolchain: toolchain.toolchainVersion,
        apiLevel: toolchain.android.apiLevel,
        buildToolsVersion: toolchain.android.buildToolsVersion,
        ndkVersion: toolchain.android.ndkVersion,
        minSdkVersion: toolchain.android.minSdkVersion,
        targetSdkVersion: toolchain.android.targetSdkVersion,
        abis: toolchain.android.abis.map((abi: { abi: string }) => abi.abi),
        quickjs: toolchain.quickjs.revision,
        rust: toolchain.rust.toolchain,
      },
    },
  });
  const total = Object.values(manifest.files).reduce((sum, file) => sum + file.bytes, 0);
  console.log(
    `output: ${out} (${files.length} files, ${total} bytes, PocketJS ${manifest.pocketjs}, ` +
      `${((performance.now() - started) / 1000).toFixed(1)} s)`,
  );
  return out;
}

if (import.meta.main) {
  try {
    await buildRuntimeAndroid(Bun.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
