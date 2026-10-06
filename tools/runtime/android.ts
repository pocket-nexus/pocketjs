#!/usr/bin/env bun
// The generic Android runtime: what tools/android.ts build-app compiles for
// every game of a profile, built once, with no game in it.
//
//   bun tools/runtime/android.ts [--profile=redmi-1s] [--out=dist/runtime/android]
//
// Writes into the output directory:
//   lib/armeabi-v7a/libpocketjs.so, lib/arm64-v8a/libpocketjs.so
//                        Rust core + QuickJS + host, compiled with the
//                        profile's target id, host ABI and viewport only
//   classes.dex          PocketActivity (reads assets/app.js and app.pak)
//   AndroidManifest.xml  the manifest template (@POCKET_*@ placeholders)
//   res/values/strings.xml   the label template
//   res/mipmap-*/icon.png    the default launcher icon (PocketJS's mark)
//   runtime.json         { target, hostAbi, pocketjs, profile, viewport, android, files }
//
// tools/repack/android.ts turns it and a `.pocket` into an APK.

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import { REDMI_1S_CONTRACTS, REDMI_1S_TARGET } from "../redmi-1s-profile.ts";
import { MOTO_G_PLAY_CONTRACTS, MOTO_G_PLAY_TARGET } from "../moto-g-play-profile.ts";

const ROOT = resolve(import.meta.dir, "../..");
const argv = Bun.argv.slice(2);
const option = (name: string) => argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const profile = option("profile") ?? "redmi-1s";
const PROFILES: Record<string, { target: string; contract: { hostAbi: number; display: { logicalViewports: readonly (readonly number[])[]; rasterDensity: number } } }> = {
  "redmi-1s": { target: REDMI_1S_TARGET, contract: REDMI_1S_CONTRACTS.targets[REDMI_1S_TARGET] },
  "moto-g-play": { target: MOTO_G_PLAY_TARGET, contract: MOTO_G_PLAY_CONTRACTS.targets[MOTO_G_PLAY_TARGET] },
};
if (!(profile in PROFILES)) throw new Error(`runtime android: no profile ${profile}; use ${Object.keys(PROFILES).join(" or ")}`);
const out = resolve(option("out") ?? join(ROOT, profile === "redmi-1s" ? "dist/runtime/android" : `dist/runtime/android-${profile}`));

const started = performance.now();
const build = Bun.spawnSync(["bun", join(ROOT, "tools/android.ts"), `--profile=${profile}`, "runtime", `--out=${out}`], {
  cwd: ROOT,
  stdout: "inherit",
  stderr: "inherit",
});
if (build.exitCode !== 0) process.exit(build.exitCode ?? 1);

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const git = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: ROOT, stdout: "pipe" }).stdout.toString().trim();
const toolchain = JSON.parse(readFileSync(join(ROOT, `tools/cli/${profile}-toolchain.json`), "utf8"));
const { target, contract } = PROFILES[profile];
const files: Record<string, { bytes: number; sha256: string }> = {};
for (const path of walk(out).sort()) {
  const name = relative(out, path);
  if (name === "runtime.json") continue;
  const bytes = readFileSync(path);
  files[name] = { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}
const manifest = {
  schema: 1,
  target,
  hostAbi: contract.hostAbi,
  pocketjs: git(["rev-parse", "HEAD"]),
  dirty: git(["status", "--porcelain", "--untracked-files=no"]) !== "",
  profile,
  viewport: { logical: contract.display.logicalViewports[0], rasterDensity: contract.display.rasterDensity },
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
  files,
};
writeFileSync(join(out, "runtime.json"), `${JSON.stringify(manifest, null, 2)}\n`);
const total = Object.values(files).reduce((sum, file) => sum + file.bytes, 0);
console.log(`runtime android (${profile}): ${relative(ROOT, out)}, ${Object.keys(files).length} files, ${total} bytes, ${((performance.now() - started) / 1000).toFixed(1)} s`);
