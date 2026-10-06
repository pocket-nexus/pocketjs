// The native half of the Android repack (tools/repack/android.ts): the one
// step of any repack that runs SDK tools. It takes an AndroidNativeJob (the
// APK's files laid out) and returns the signed APK:
//
//   aapt2 compile --no-crunch   res/ (strings + launcher icons) into flat files
//   aapt2 link                  binary manifest + resources.arsc + res/ + assets/
//   zip merge (TypeScript)      + classes.dex + lib/<abi>/libpocketjs.so, dated 1980-01-01
//   zipalign -p 4               stored entries on 4-byte boundaries
//   apksigner sign              v1 + v2 with the signer's key (v3/v4 off)
//   apksigner verify            both schemes hold and the certificate is the expected one
//
// It needs build-tools and the platform the job names, and Java 17. The
// signer's password is the first line of a file apksigner reads itself
// (`--ks-pass file:`), so it is on no command line and in no log.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readZip, writeZip } from "./shared/zip.ts";
import { POCKET_STUDIO_COMMUNITY_SIGNER, type AndroidNativeJob, type AndroidNativeSteps } from "./android.ts";

export interface AndroidSigner {
  /** A PKCS #12 keystore. */
  readonly keystore: string;
  /** The file whose first line is the keystore's password. */
  readonly passwordFile: string;
  readonly alias: string;
  /** SHA-256 of the certificate the APK must verify under; checked after signing. */
  readonly certificateSha256: string;
}

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

/**
 * The Pocket Studio community key: the PKCS #12 keystore POCKET_STUDIO_COMMUNITY_KEY
 * names, default `~/.config/pocket-nexus/signing/pocket-studio-community.p12`
 * (alias `pocket-studio-community`), its password the first line of the
 * `.password` file beside it.
 */
export function communitySigner(env: NodeJS.ProcessEnv = process.env): AndroidSigner {
  const keystore = env.POCKET_STUDIO_COMMUNITY_KEY ||
    join(env.HOME ?? homedir(), ".config/pocket-nexus/signing/pocket-studio-community.p12");
  const passwordFile = keystore.replace(/\.[^./]*$/, "") + ".password";
  for (const file of [keystore, passwordFile]) {
    if (!existsSync(file)) {
      throw new Error(
        `repack android: a game is signed with the Pocket Studio community key, and ${file} is absent ` +
          "(POCKET_STUDIO_COMMUNITY_KEY names the keystore; its password is the first line of the .password file beside it)",
      );
    }
  }
  return { keystore, passwordFile, alias: "pocket-studio-community", certificateSha256: POCKET_STUDIO_COMMUNITY_SIGNER };
}

function run(program: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env): string {
  const done = Bun.spawnSync([program, ...args], { stdout: "pipe", stderr: "pipe", env });
  if (done.exitCode !== 0) {
    throw new Error(`repack android: ${program.split("/").pop()} exited ${done.exitCode}\n${done.stderr.toString().trim() || done.stdout.toString().trim()}`);
  }
  return done.stdout.toString();
}

function writeTree(root: string, files: ReadonlyMap<string, Uint8Array>): void {
  for (const [path, bytes] of files) {
    if (path.startsWith("/") || path.split("/").includes("..")) throw new Error(`repack android: ${path} leaves its directory`);
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, bytes);
  }
}

/** The native steps on this machine's SDK, signing with `signer` (default: the community key). */
export function androidNativeSteps(options: { sdk?: AndroidSdk; signer?: AndroidSigner } = {}): AndroidNativeSteps {
  return async (job: AndroidNativeJob) => {
    const sdk = options.sdk ?? localAndroidSdk();
    const signer = options.signer ?? communitySigner();
    const buildTools = join(sdk.root, "build-tools", job.sdk.buildToolsVersion);
    const androidJar = join(sdk.root, "platforms", `android-${job.sdk.apiLevel}`, "android.jar");
    for (const path of [join(buildTools, "aapt2"), join(buildTools, "zipalign"), join(buildTools, "apksigner"), androidJar]) {
      if (!existsSync(path)) throw new Error(`repack android: ${path} is absent (run \`bun tools/android.ts --profile=redmi-1s setup\`)`);
    }
    const javaEnv = { ...process.env, JAVA_HOME: sdk.javaHome, PATH: `${join(sdk.javaHome, "bin")}:${process.env.PATH ?? ""}` };
    const work = mkdtempSync(join(tmpdir(), "pocket-repack-android-"));
    try {
      writeFileSync(join(work, "AndroidManifest.xml"), job.manifest);
      writeTree(join(work, "res"), job.resources);
      writeTree(join(work, "assets"), job.assets);
      const flat = join(work, "res.zip");
      // `--no-crunch`: the launcher icons go in as the TypeScript half wrote them, byte for byte.
      run(join(buildTools, "aapt2"), ["compile", "--no-crunch", "--dir", join(work, "res"), "-o", flat]);
      const linked = join(work, "linked.apk");
      run(join(buildTools, "aapt2"), [
        "link", "-o", linked,
        "--manifest", join(work, "AndroidManifest.xml"),
        "-I", androidJar,
        "-A", join(work, "assets"),
        "--min-sdk-version", String(job.sdk.minSdkVersion),
        "--target-sdk-version", String(job.sdk.targetSdkVersion),
        flat,
      ]);
      const merged = await writeZip([
        ...readZip(new Uint8Array(readFileSync(linked))).map((entry) => ({ name: entry.name, entry })),
        ...[...job.entries].map(([name, data]) => ({ name, data })),
      ]);
      const unsigned = join(work, "unsigned.apk");
      writeFileSync(unsigned, merged);
      const aligned = join(work, "aligned.apk");
      run(join(buildTools, "zipalign"), ["-f", "-p", "4", unsigned, aligned]);
      const signed = join(work, "signed.apk");
      const apksigner = join(buildTools, "apksigner");
      run(apksigner, [
        "sign",
        "--ks", signer.keystore,
        "--ks-type", "PKCS12",
        "--ks-pass", `file:${signer.passwordFile}`,
        "--ks-key-alias", signer.alias,
        "--min-sdk-version", String(job.sdk.minSdkVersion),
        "--v1-signing-enabled", "true",
        "--v2-signing-enabled", "true",
        "--v3-signing-enabled", "false",
        "--v4-signing-enabled", "false",
        "--out", signed,
        aligned,
      ], javaEnv);
      const report = run(apksigner, ["verify", "--verbose", "--print-certs", "--min-sdk-version", String(job.sdk.minSdkVersion), signed], javaEnv);
      for (const scheme of ["v1 scheme (JAR signing)", "v2 scheme (APK Signature Scheme v2)"]) {
        if (!report.includes(`Verified using ${scheme}: true`)) throw new Error(`repack android: the APK does not verify under the ${scheme}`);
      }
      const certificate = /^Signer #1 certificate SHA-256 digest: ([0-9a-f]{64})$/m.exec(report)?.[1];
      if (certificate !== signer.certificateSha256) {
        throw new Error(`repack android: the APK is signed by certificate ${certificate}, not ${signer.certificateSha256}`);
      }
      return new Uint8Array(readFileSync(signed));
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  };
}
