// aapt2 link of an AndroidLinkJob (tools/repack/android.ts) on this machine's
// Android SDK: compile the resources, link the manifest, resources and
// assets, and add classes.dex and the libraries. The result is unsigned and
// unaligned.
//
// Two callers: tools/runtime/android.ts links the runtime's template.apk, and
// tests/repack-android.test.ts links a game to compare with the TypeScript
// repack. A repack itself runs no SDK tool.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AndroidLinkJob } from "./repack/android.ts";
import { readZip, writeZip } from "./repack/shared/zip.ts";

export interface AndroidSdk {
  /** The SDK root holding build-tools/<version> and platforms/android-<level>. */
  readonly root: string;
  readonly javaHome: string;
}

/** The SDK tools/android.ts uses: POCKETJS_ANDROID_SDK_ROOT, else the Homebrew SDK on macOS, else the toolchain cache. */
export function localAndroidSdk(env: NodeJS.ProcessEnv = process.env): AndroidSdk {
  return {
    root: env.POCKETJS_ANDROID_SDK_ROOT ??
      (process.platform === "darwin" ? "/opt/homebrew/share/android-commandlinetools" : join(homedir(), ".cache/pocket-nexus/android/sdk")),
    javaHome: env.JAVA_HOME ?? "/opt/homebrew/opt/openjdk@17",
  };
}

/** build-tools/<version>/<tool>. */
export function buildTool(sdk: AndroidSdk, version: string, tool: string): string {
  return join(sdk.root, "build-tools", version, tool);
}

export function runTool(program: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env): string {
  const done = Bun.spawnSync([program, ...args], { stdout: "pipe", stderr: "pipe", env });
  if (done.exitCode !== 0) {
    throw new Error(`${program.split("/").pop()} exited ${done.exitCode}\n${done.stderr.toString().trim() || done.stdout.toString().trim()}`);
  }
  return done.stdout.toString();
}

function writeTree(root: string, files: ReadonlyMap<string, Uint8Array>): void {
  for (const [path, bytes] of files) {
    if (path.startsWith("/") || path.split("/").includes("..")) throw new Error(`android link: ${path} leaves its directory`);
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, bytes);
  }
}

/** aapt2 compile --no-crunch + aapt2 link, then the job's entries after aapt2's, dated 1980-01-01. */
export async function linkAndroidApk(job: AndroidLinkJob, sdk: AndroidSdk = localAndroidSdk()): Promise<Uint8Array> {
  const aapt2 = buildTool(sdk, job.sdk.buildToolsVersion, "aapt2");
  const androidJar = join(sdk.root, "platforms", `android-${job.sdk.apiLevel}`, "android.jar");
  for (const path of [aapt2, androidJar]) {
    if (!existsSync(path)) throw new Error(`android link: ${path} is absent (run \`bun tools/android.ts --profile=redmi-1s setup\`)`);
  }
  const work = mkdtempSync(join(tmpdir(), "pocket-android-link-"));
  try {
    writeFileSync(join(work, "AndroidManifest.xml"), job.manifest);
    writeTree(join(work, "res"), job.resources);
    mkdirSync(join(work, "assets"), { recursive: true });
    writeTree(join(work, "assets"), job.assets);
    const flat = join(work, "res.zip");
    // `--no-crunch`: the launcher icons go in byte for byte.
    runTool(aapt2, ["compile", "--no-crunch", "--dir", join(work, "res"), "-o", flat]);
    const linked = join(work, "linked.apk");
    runTool(aapt2, [
      "link", "-o", linked,
      "--manifest", join(work, "AndroidManifest.xml"),
      "-I", androidJar,
      "-A", join(work, "assets"),
      "--min-sdk-version", String(job.sdk.minSdkVersion),
      "--target-sdk-version", String(job.sdk.targetSdkVersion),
      flat,
    ]);
    return await writeZip([
      ...readZip(new Uint8Array(readFileSync(linked))).map((entry) => ({ name: entry.name, entry })),
      ...[...job.entries].map(([name, data]) => ({ name, data })),
    ]);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
