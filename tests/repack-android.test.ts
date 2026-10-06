import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodePocketPackage, type PocketPackageVariant } from "../contracts/spec/pocket-package.ts";
import { canonicalJson } from "../framework/src/manifest/plan.ts";
import { ANDROID_LAUNCHER_DENSITIES } from "../tools/android-icon.ts";
import { resolveMotoGPlayBuildPlan } from "../tools/moto-g-play-profile.ts";
import { encodeIndexedPNG, encodePNG } from "../tools/png.ts";
import { makeVariant } from "../tools/pocket-pack.ts";
import { REDMI_1S_TARGET, resolveRedmi1sBuildPlan } from "../tools/redmi-1s-profile.ts";
import {
  ANDROID_ICON_DENSITIES,
  POCKET_STUDIO_COMMUNITY_SIGNER,
  androidIdentity,
  androidString,
  expectedApkEntries,
  prepareAndroidJob,
  repackAndroid,
  type AndroidNativeJob,
} from "../tools/repack/android.ts";
import { androidNativeSteps, localAndroidSdk } from "../tools/repack/android-native.ts";
import type { RepackInput } from "../tools/repack/shared/input.ts";
import { decodePng, encodePng, scaleSquare } from "../tools/repack/shared/png.ts";
import { readZip, unzipEntry, writeZip } from "../tools/repack/shared/zip.ts";

const ROOT = join(import.meta.dir, "..");
const work = join(tmpdir(), `pocketjs-repack-android-${process.pid}`);
mkdirSync(work, { recursive: true });
afterAll(() => rmSync(work, { recursive: true, force: true }));

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const bytesOf = (text: string) => new TextEncoder().encode(text);

function square(side: number, paint: (x: number, y: number) => [number, number, number, number]): Uint8Array {
  const rgba = new Uint8Array(side * side * 4);
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) rgba.set(paint(x, y), (y * side + x) * 4);
  return rgba;
}

/** A runtime with stand-in native files: what runtime.json records, the templates from hosts/android. */
async function fixtureRuntime(overrides: Record<string, unknown> = {}): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>([
    ["AndroidManifest.xml", new Uint8Array(readFileSync(join(ROOT, "hosts/android/app/AndroidManifest.xml")))],
    ["res/values/strings.xml", new Uint8Array(readFileSync(join(ROOT, "hosts/android/app/res/values/strings.xml")))],
    ["classes.dex", bytesOf("dex\n035\0 stand-in for PocketActivity")],
    ["lib/armeabi-v7a/libpocketjs.so", bytesOf("\x7fELF stand-in armeabi-v7a")],
    ["lib/arm64-v8a/libpocketjs.so", bytesOf("\x7fELF stand-in arm64-v8a")],
  ]);
  for (const [density, side] of ANDROID_ICON_DENSITIES) {
    files.set(`res/mipmap-${density}/icon.png`, await encodePng({ width: side, height: side, rgba: square(side, () => [23, 18, 38, 255]) }));
  }
  const manifest = {
    schema: 1,
    target: REDMI_1S_TARGET,
    hostAbi: 9,
    pocketjs: "0".repeat(40),
    profile: "redmi-1s",
    viewport: { logical: [360, 640], rasterDensity: 2 },
    android: { apiLevel: 34, buildToolsVersion: "35.0.0", minSdkVersion: 18, targetSdkVersion: 34, abis: ["armeabi-v7a", "arm64-v8a"] },
    files: Object.fromEntries([...files].map(([path, bytes]) => [path, { bytes: bytes.length, sha256: sha256(bytes) }])),
    ...overrides,
  };
  files.set("runtime.json", bytesOf(JSON.stringify(manifest)));
  return files;
}

const clear = () => JSON.parse(readFileSync(join(ROOT, "apps/clear/pocket.redmi-1s.json"), "utf8"));
const GAME_JS = bytesOf("globalThis.game = 1;");
const GAME_PAK = Uint8Array.from({ length: 4096 }, (_, i) => (i * 7) & 0xff);

function variantFor(plan: ReturnType<typeof resolveRedmi1sBuildPlan>): PocketPackageVariant {
  return makeVariant({
    target: plan.target.id,
    hostAbi: plan.target.hostAbi,
    planJson: canonicalJson(plan),
    identity: { output: plan.app.output, id: plan.app.id, title: plan.app.title },
    js: GAME_JS,
    pak: GAME_PAK,
  });
}

function fixturePocket(variants?: PocketPackageVariant[]): Uint8Array {
  const manifest = clear();
  return encodePocketPackage({
    manifest: bytesOf(JSON.stringify(manifest)),
    variants: variants ?? [variantFor(resolveRedmi1sBuildPlan(manifest))],
  });
}

const IDENTITY = { id: "dev.pocket-nexus.studio.test-game", title: "Tom's \"Test\" & <Game>", author: "A Creator", version: "1.2.3" };

async function input(overrides: Partial<RepackInput> = {}): Promise<RepackInput> {
  return { runtime: await fixtureRuntime(), pocket: fixturePocket(), identity: IDENTITY, ...overrides };
}

/** A job as bytes, for byte-for-byte comparison. */
function serialize(job: AndroidNativeJob): string {
  const files = (map: ReadonlyMap<string, Uint8Array>) => [...map].map(([path, bytes]) => `${path}:${sha256(bytes)}`);
  return JSON.stringify({ manifest: job.manifest, resources: files(job.resources), assets: files(job.assets), entries: files(job.entries), sdk: job.sdk });
}

describe("Android identity", () => {
  test("the package name is the id with hyphens as underscores; versionCode comes from major.minor.patch", () => {
    expect(androidIdentity(IDENTITY)).toEqual({
      packageName: "dev.pocket_nexus.studio.test_game",
      versionCode: 1_002_003,
      versionName: "1.2.3",
      label: IDENTITY.title,
    });
    expect(() => androidIdentity({ ...IDENTITY, id: "single" })).toThrow(/Android package name/);
    expect(() => androidIdentity({ ...IDENTITY, id: "dev.pocket-nexus.2048" })).toThrow(/Android package name/);
    expect(() => androidIdentity({ ...IDENTITY, version: "1.2" })).toThrow(/major\.minor\.patch/);
    expect(() => androidIdentity({ ...IDENTITY, version: "1.1000.0" })).toThrow(/versionCode range/);
  });

  test("a label is escaped for aapt2 and XML", () => {
    expect(androidString(`Tom's "Test" & <Game>`)).toBe("Tom\\'s \\&quot;Test\\&quot; &amp; &lt;Game&gt;");
    expect(androidString("@string/x")).toBe("\\@string/x");
    expect(androidString("?attr")).toBe("\\?attr");
    expect(androidString("a\\b")).toBe("a\\\\b");
  });

  test("the repack bakes the five densities tools/android-icon.ts bakes", () => {
    expect(ANDROID_ICON_DENSITIES.map(([d, s]) => [d, s])).toEqual(ANDROID_LAUNCHER_DENSITIES.map(([d, s]) => [d, s]));
  });

  test("the community signer is a SHA-256 and not the Pocket Nexus release key", () => {
    expect(POCKET_STUDIO_COMMUNITY_SIGNER).toMatch(/^[0-9a-f]{64}$/);
    expect(POCKET_STUDIO_COMMUNITY_SIGNER).not.toBe("fb36ca939a6f03ae436d72d5309861407451f6c549e43bb1a35b05dd67ca9c21");
  });
});

describe("the TypeScript half lays out the APK", () => {
  test("manifest, label, icons, assets and runtime entries", async () => {
    const icon = await encodePng({ width: 300, height: 300, rgba: square(300, (x) => (x < 150 ? [255, 210, 63, 255] : [169, 139, 255, 255])) });
    const job = await prepareAndroidJob(await input({ identity: { ...IDENTITY, icon } }));
    expect(job.manifest).toContain('package="dev.pocket_nexus.studio.test_game"');
    expect(job.manifest).toContain('android:versionCode="1002003"');
    expect(job.manifest).toContain('android:versionName="1.2.3"');
    expect(job.manifest).toContain('android:minSdkVersion="18" android:targetSdkVersion="34"');
    expect(job.manifest).toContain('android:debuggable="false"');
    expect(job.manifest).not.toContain("@POCKET_");
    expect(new TextDecoder().decode(job.resources.get("values/strings.xml"))).toContain(
      '<string name="app_name">Tom\\\'s \\&quot;Test\\&quot; &amp; &lt;Game&gt;</string>',
    );
    for (const [density, side] of ANDROID_ICON_DENSITIES) {
      const png = await decodePng(job.resources.get(`mipmap-${density}/icon.png`)!);
      expect([png.width, png.height]).toEqual([side, side]);
      expect([...png.rgba.subarray(0, 4)]).toEqual([255, 210, 63, 255]);
      expect([...png.rgba.subarray(png.rgba.length - 4)]).toEqual([169, 139, 255, 255]);
    }
    expect([...job.assets.keys()]).toEqual(["app.js", "app.pak"]);
    expect(job.assets.get("app.js")).toEqual(GAME_JS);
    expect(job.assets.get("app.pak")).toEqual(GAME_PAK);
    expect([...job.entries.keys()]).toEqual(["classes.dex", "lib/arm64-v8a/libpocketjs.so", "lib/armeabi-v7a/libpocketjs.so"]);
    expect(job.sdk).toEqual({ apiLevel: 34, buildToolsVersion: "35.0.0", minSdkVersion: 18, targetSdkVersion: 34 });
  });

  test("without an icon the runtime's default icon goes in", async () => {
    const runtime = await fixtureRuntime();
    const job = await prepareAndroidJob(await input({ runtime }));
    for (const [density] of ANDROID_ICON_DENSITIES) {
      expect(job.resources.get(`mipmap-${density}/icon.png`)).toEqual(runtime.get(`res/mipmap-${density}/icon.png`)!);
    }
  });

  test("the same inputs give the same files", async () => {
    const icon = await encodePng({ width: 512, height: 512, rgba: square(512, (x, y) => [x & 255, y & 255, (x ^ y) & 255, 255]) });
    const a = serialize(await prepareAndroidJob(await input({ identity: { ...IDENTITY, icon } })));
    const b = serialize(await prepareAndroidJob(await input({ identity: { ...IDENTITY, icon } })));
    expect(a).toBe(b);
  });
});

describe("the repack refuses", () => {
  test("a .pocket without the runtime's target", async () => {
    const moto = resolveMotoGPlayBuildPlan(JSON.parse(readFileSync(join(ROOT, "apps/clear/pocket.android.json"), "utf8")));
    const pocket = fixturePocket([variantFor(moto)]);
    await expect(prepareAndroidJob(await input({ pocket }))).rejects.toThrow(/no redmi-1s-dev variant \(it holds moto-g-play-dev\)/);
  });

  test("a variant for another host ABI", async () => {
    const variant = variantFor(resolveRedmi1sBuildPlan(clear()));
    const pocket = fixturePocket([{ ...variant, hostAbi: 8 }]);
    await expect(prepareAndroidJob(await input({ pocket }))).rejects.toThrow(/host ABI 8, and the runtime is host ABI 9/);
  });

  test("a runtime for another host ABI", async () => {
    const runtime = await fixtureRuntime({ hostAbi: 10 });
    await expect(prepareAndroidJob(await input({ runtime }))).rejects.toThrow(/host ABI 9, and the runtime is host ABI 10/);
  });

  test("a broken footer", async () => {
    const pocket = fixturePocket();
    pocket[pocket.length - 20] ^= 1;
    await expect(prepareAndroidJob(await input({ pocket }))).rejects.toThrow(/does not read: pocket package: hash mismatch/);
  });

  test("a runtime file that differs from runtime.json", async () => {
    const runtime = await fixtureRuntime();
    runtime.set("classes.dex", bytesOf("another dex"));
    await expect(prepareAndroidJob(await input({ runtime }))).rejects.toThrow(/classes\.dex differs from runtime\.json/);
  });

  test("a runtime drawing another viewport than the game's", async () => {
    const runtime = await fixtureRuntime({ viewport: { logical: [360, 800], rasterDensity: 2 } });
    await expect(prepareAndroidJob(await input({ runtime }))).rejects.toThrow(/laid out at 360x640.*runtime draws 360x800/);
  });

  test("an icon that is not square", async () => {
    const icon = await encodePng({ width: 200, height: 100, rgba: new Uint8Array(200 * 100 * 4) });
    await expect(prepareAndroidJob(await input({ identity: { ...IDENTITY, icon } }))).rejects.toThrow(/200 by 100/);
  });
});

describe("shared helpers", () => {
  test("PNG decode reads what other encoders write: RGBA and palette", async () => {
    const rgba = square(37, (x, y) => [x * 6, y * 6, 128, x === y ? 0 : 255]);
    expect((await decodePng(new Uint8Array(encodePNG(rgba, 37, 37)))).rgba).toEqual(rgba);
    const indices = Uint8Array.from({ length: 64 }, (_, i) => i % 3);
    const palette = Uint8Array.from([255, 0, 0, 0, 255, 0, 0, 0, 255]);
    const decoded = await decodePng(new Uint8Array(encodeIndexedPNG(indices, palette, 8, 8)));
    expect([...decoded.rgba.subarray(4, 8)]).toEqual([0, 255, 0, 255]);
  });

  test("PNG encode round-trips and scaling averages covered pixels", async () => {
    const rgba = square(64, (x, y) => [(x * 4) & 255, (y * 4) & 255, 7, 200]);
    const decoded = await decodePng(await encodePng({ width: 64, height: 64, rgba }));
    expect(decoded.rgba).toEqual(rgba);
    const checker = square(4, (x, y) => ((x + y) & 1 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
    expect([...scaleSquare(checker, 4, 1)]).toEqual([128, 128, 128, 255]);
    expect(scaleSquare(checker, 4, 8).length).toBe(8 * 8 * 4);
  });

  test("zip entries round-trip, stored entries align, and the bytes are the same twice", async () => {
    const inputs = [
      { name: "a.txt", data: bytesOf("hello ".repeat(100)) },
      { name: "lib/x.so", data: Uint8Array.from({ length: 999 }, (_, i) => i & 255), compress: false, align: 4096 },
    ];
    const zip = await writeZip(inputs);
    expect(await writeZip(inputs)).toEqual(zip);
    const entries = readZip(zip);
    expect(entries.map((e) => e.name)).toEqual(["a.txt", "lib/x.so"]);
    expect(await unzipEntry(entries[0])).toEqual(inputs[0].data);
    expect(entries[1].stored.byteOffset % 4096).toBe(0);
    expect(await unzipEntry(entries[1])).toEqual(inputs[1].data);
  });
});

// The native half needs the pinned build-tools, the platform and Java 17
// (`bun tools/android.ts --profile=redmi-1s setup`). It signs with a key made
// for this test, never the community key.
const sdk = localAndroidSdk();
const nativeReady = ["build-tools/35.0.0/aapt2", "build-tools/35.0.0/apksigner", "build-tools/35.0.0/zipalign", "platforms/android-34/android.jar"]
  .every((path) => existsSync(join(sdk.root, path))) && existsSync(join(sdk.javaHome, "bin/keytool"));

describe.skipIf(!nativeReady)("the native half", () => {
  function testSigner() {
    const keystore = join(work, "test.p12"), passwordFile = join(work, "test.password"), certificate = join(work, "test.der");
    if (!existsSync(keystore)) {
      writeFileSync(passwordFile, "repack-android-test\n", { mode: 0o600 });
      const keytool = join(sdk.javaHome, "bin/keytool");
      const store = ["-storetype", "PKCS12", "-keystore", keystore, "-storepass:file", passwordFile, "-alias", "test"];
      for (const args of [
        ["-genkeypair", "-noprompt", ...store, "-keyalg", "RSA", "-keysize", "2048", "-validity", "2", "-dname", "CN=Repack Test"],
        ["-exportcert", ...store, "-file", certificate],
      ]) {
        const done = Bun.spawnSync([keytool, ...args], { stdout: "pipe", stderr: "pipe" });
        if (done.exitCode !== 0) throw new Error(done.stderr.toString());
      }
    }
    return { keystore, passwordFile, alias: "test", certificateSha256: sha256(new Uint8Array(readFileSync(certificate))) };
  }

  test("links, aligns and signs v1 + v2; the same inputs give the same APK", async () => {
    const native = androidNativeSteps({ sdk, signer: testSigner() });
    const job = await prepareAndroidJob(await input());
    const apk = await repackAndroid(await input(), { native });
    expect(await repackAndroid(await input(), { native })).toEqual(apk);
    const entries = readZip(apk);
    const names = entries.map((entry) => entry.name);
    for (const name of [...expectedApkEntries(job), ...ANDROID_ICON_DENSITIES.map(([d]) => `res/mipmap-${d}-v4/icon.png`)]) {
      expect(names).toContain(name);
    }
    expect(names.some((name) => /^META-INF\/[^/]+\.RSA$/.test(name))).toBe(true);
    const entry = (name: string) => entries.find((e) => e.name === name)!;
    expect(await unzipEntry(entry("assets/app.js"))).toEqual(GAME_JS);
    expect(await unzipEntry(entry("lib/arm64-v8a/libpocketjs.so"))).toEqual(job.entries.get("lib/arm64-v8a/libpocketjs.so")!);
    const path = join(work, "game.apk");
    writeFileSync(path, apk);
    const badging = Bun.spawnSync([join(sdk.root, "build-tools/35.0.0/aapt2"), "dump", "badging", path], { stdout: "pipe" }).stdout.toString();
    expect(badging).toContain("package: name='dev.pocket_nexus.studio.test_game' versionCode='1002003' versionName='1.2.3'");
    expect(badging).toContain("minSdkVersion:'18'");
    expect(badging).toMatch(/application-label:'Tom's \\?"Test\\?" & <Game>'/);
    expect(badging).toContain("native-code: 'arm64-v8a' 'armeabi-v7a'");
    expect(badging).not.toContain("application-debuggable");
  }, 60_000);

  test("a signer whose certificate is not the expected one is refused after signing", async () => {
    const native = androidNativeSteps({ sdk, signer: { ...testSigner(), certificateSha256: POCKET_STUDIO_COMMUNITY_SIGNER } });
    await expect(repackAndroid(await input(), { native })).rejects.toThrow(/not 54c2abe6/);
  }, 60_000);
});
