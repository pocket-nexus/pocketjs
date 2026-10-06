import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodePocketPackage } from "../contracts/spec/pocket-package.ts";
import { ANDROID_LAUNCHER_DENSITIES } from "../tools/android-icon.ts";
import { buildTool, linkAndroidApk, localAndroidSdk, runTool } from "../tools/android-link.ts";
import { MOTO_G_PLAY_TARGET, resolveMotoGPlayBuildPlan } from "../tools/moto-g-play-profile.ts";
import { REDMI_1S_TARGET, resolveRedmi1sBuildPlan } from "../tools/redmi-1s-profile.ts";
import { readRuntimeDirectory } from "../tools/repack.ts";
import {
  ANDROID_ICON_DENSITIES,
  ANDROID_RUNTIME_TARGETS,
  ANDROID_TEMPLATE,
  ANDROID_TEMPLATE_IDENTITY,
  POCKET_STUDIO_COMMUNITY_SIGNER,
  androidIdentity,
  androidLabel,
  androidLinkJob,
  androidPackageName,
  androidString,
  androidTemplateJob,
  repackAndroid,
} from "../tools/repack/android.ts";
import {
  patchManifest,
  patchResourceTable,
  readManifest,
  readResourceTable,
  readStringPool,
  writeStringPool,
} from "../tools/repack/shared/android-resources.ts";
import { decodePng, encodePng } from "../tools/repack/shared/png.ts";
import type { RepackInput } from "../tools/repack/shared/runtime.ts";
import { readZip, unzipEntry, writeZip, ZIP_STORED, type ZipEntry } from "../tools/repack/shared/zip.ts";
import {
  ABIS,
  clear,
  fixtureParts,
  fixturePocket,
  fixtureRuntime,
  GAME_JS,
  GAME_PAK,
  HOST_ABI,
  IDENTITY,
  SDK_LEVELS,
  square,
  TEMPLATE,
  variantFor,
} from "./helpers/android-fixture.ts";
import { makeTestSigner, verifyApkSignatures } from "./helpers/apk-test-signer.ts";

const ROOT = join(import.meta.dir, "..");
const work = join(tmpdir(), `pocketjs-repack-android-${process.pid}`);
mkdirSync(work, { recursive: true });
afterAll(() => rmSync(work, { recursive: true, force: true }));

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const bytesOf = (text: string) => new TextEncoder().encode(text);
const signer = await makeTestSigner();
const options = { certificateSha256: signer.certificateSha256 };

function input(overrides: Partial<RepackInput> = {}): RepackInput {
  return {
    runtime: fixtureRuntime(),
    pocket: fixturePocket(overrides.identity?.id),
    identity: IDENTITY,
    signer: { privateKey: signer.privateKey, certificate: signer.certificate },
    ...overrides,
  };
}

const ICON = await encodePng({ width: 300, height: 300, rgba: square(300, (x) => (x < 150 ? [255, 210, 63, 255] : [169, 139, 255, 255])) });
const templateEntry = async (name: string) => unzipEntry(readZip(TEMPLATE).find((entry) => entry.name === name)!);
const entryOf = (entries: readonly ZipEntry[], name: string) => entries.find((entry) => entry.name === name)!;

describe("Android identity", () => {
  test("the package name is the id with `-` as `_`, and `x` before a segment that starts with a digit", () => {
    expect(androidPackageName("dev.pocket-nexus.studio.test-game")).toBe("dev.pocket_nexus.studio.test_game");
    expect(androidPackageName("dev.pocket-nexus.studio.2pac.8-ball")).toBe("dev.pocket_nexus.studio.x2pac.x8_ball");
    expect(androidPackageName("dev.pocket-nexus.2048")).toBe("dev.pocket_nexus.x2048");
    expect(androidPackageName("dev.pocket-nexus.studio.twenty48")).toBe("dev.pocket_nexus.studio.twenty48");
    expect(() => androidPackageName("single")).toThrow(/Android package name/);
    expect(() => androidPackageName("dev..game")).toThrow(/Android package name/);
    expect(() => androidPackageName("dev.-game")).toThrow(/Android package name \(dev\._game\)/);
    expect(() => androidPackageName(`dev.${"a".repeat(124)}`)).toThrow(/longer than 127 characters/);
    expect(androidPackageName(`dev.${"a".repeat(123)}`)).toHaveLength(127);
  });

  test("versionCode comes from major.minor.patch", () => {
    expect(androidIdentity(IDENTITY)).toEqual({
      packageName: "dev.pocket_nexus.studio.test_game",
      versionCode: 1_002_003,
      versionName: "1.2.3",
      label: IDENTITY.title,
    });
    expect(androidIdentity({ ...IDENTITY, version: "1999.999.999" }).versionCode).toBe(1_999_999_999);
    expect(() => androidIdentity({ ...IDENTITY, version: "1.2" })).toThrow(/major\.minor\.patch/);
    expect(() => androidIdentity({ ...IDENTITY, version: "1.1000.0" })).toThrow(/versionCode range/);
    expect(() => androidIdentity({ ...IDENTITY, version: "0.0.0" })).toThrow(/versionCode 0/);
  });

  test("the label is the title with its ASCII whitespace trimmed and collapsed", () => {
    expect(androidLabel("  Space \t  Game\n ")).toBe("Space Game");
    expect(androidLabel("ゲーム\u3000タイトル")).toBe("ゲーム\u3000タイトル");
    expect(() => androidIdentity({ ...IDENTITY, title: " \n " })).toThrow(/title is empty/);
    expect(() => androidIdentity({ ...IDENTITY, title: "bell\u0007" })).toThrow(/control character/);
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

  test("an Android runtime boots the targets of the two Android profiles", () => {
    expect([...ANDROID_RUNTIME_TARGETS]).toEqual([REDMI_1S_TARGET, MOTO_G_PLAY_TARGET]);
  });

  test("the community signer is a SHA-256 and not the Pocket Nexus release key", () => {
    expect(POCKET_STUDIO_COMMUNITY_SIGNER).toMatch(/^[0-9a-f]{64}$/);
    expect(POCKET_STUDIO_COMMUNITY_SIGNER).not.toBe("fb36ca939a6f03ae436d72d5309861407451f6c549e43bb1a35b05dd67ca9c21");
  });
});

describe("binary manifest and resource table", () => {
  const IDENTITIES = [
    { packageName: "dev.pocket_nexus.studio.x2pac.x8_ball", versionCode: 1000, versionName: "0.1.0", label: "8 Ball" },
    { packageName: "app.a", versionCode: 10_020_030, versionName: "10.20.30", label: "日本語のゲーム" },
    { packageName: "zz.zz", versionCode: 1_999_999_999, versionName: "1999.999.999", label: "zebra 🦓 game" },
    { packageName: "com.x.y", versionCode: 1, versionName: "0.0.1", label: "@home" },
  ];

  test("the template reads back as the template identity, SDK 18 to 34, not debuggable", async () => {
    expect(readManifest(await templateEntry("AndroidManifest.xml"))).toMatchObject({
      packageName: androidPackageName(ANDROID_TEMPLATE_IDENTITY.id),
      versionCode: 1,
      versionName: ANDROID_TEMPLATE_IDENTITY.version,
      minSdkVersion: 18,
      targetSdkVersion: 34,
      debuggable: false,
    });
    expect(readResourceTable(await templateEntry("resources.arsc"))).toMatchObject({
      packageId: 0x7f,
      packageName: androidPackageName(ANDROID_TEMPLATE_IDENTITY.id),
      label: ANDROID_TEMPLATE_IDENTITY.title,
    });
  });

  test("a rewrite reads back, and depends on the identity alone, not on the one before it", async () => {
    const manifest = await templateEntry("AndroidManifest.xml");
    const table = await templateEntry("resources.arsc");
    for (const identity of IDENTITIES) {
      const once = patchManifest(manifest, identity);
      expect(readManifest(once)).toMatchObject({ packageName: identity.packageName, versionCode: identity.versionCode, versionName: identity.versionName });
      const onceTable = patchResourceTable(table, identity);
      expect(readResourceTable(onceTable)).toMatchObject({ packageName: identity.packageName, label: identity.label });
      for (const before of IDENTITIES) {
        expect(patchManifest(patchManifest(manifest, before), identity)).toEqual(once);
        expect(patchResourceTable(patchResourceTable(table, before), identity)).toEqual(onceTable);
      }
    }
  });

  test("the table's pool stays sorted by UTF-8 bytes, and a label equal to a path shares its entry", async () => {
    const table = await templateEntry("resources.arsc");
    for (const identity of IDENTITIES) {
      const pool = readStringPool(patchResourceTable(table, identity), 12).strings;
      const bytes = pool.map((text) => Buffer.from(text, "utf8"));
      for (let index = 1; index < bytes.length; index++) expect(Buffer.compare(bytes[index - 1]!, bytes[index]!)).toBe(-1);
    }
    const shared = patchResourceTable(table, { packageName: "a.b", label: "res/mipmap-hdpi-v4/icon.png" });
    expect(readStringPool(shared, 12).strings).toHaveLength(5);
    const strings = new Map(readResourceTable(shared).strings);
    expect(strings.get("string/app_name")).toBe("res/mipmap-hdpi-v4/icon.png");
    expect(readResourceTable(shared).strings.filter(([key]) => key === "mipmap/icon").map(([, path]) => path).sort())
      .toEqual(ANDROID_ICON_DENSITIES.map(([density]) => `res/mipmap-${density}-v4/icon.png`).sort());
  });

  test("a UTF-8 pool writes a character past U+FFFF as two 3-byte surrogates, as aapt2 does", () => {
    const pool = writeStringPool(["🦓", "é"], true);
    expect([...pool.subarray(28 + 8, 28 + 8 + 9)]).toEqual([2, 6, 0xed, 0xa0, 0xbe, 0xed, 0xb6, 0x93, 0]);
    expect(readStringPool(pool, 0).strings).toEqual(["🦓", "é"]);
    expect(readStringPool(writeStringPool(["🦓", "ab"], false), 0).strings).toEqual(["🦓", "ab"]);
  });

  test("a rewrite refuses what a table or manifest cannot hold", async () => {
    await expect(async () => patchResourceTable(await templateEntry("resources.arsc"), { packageName: `a.${"b".repeat(126)}`, label: "x" }))
      .toThrow(/at most 127 characters/);
    await expect(async () => patchManifest(await templateEntry("AndroidManifest.xml"), { packageName: "a.b", versionCode: 0, versionName: "0" }))
      .toThrow(/positive 31-bit integer/);
  });
});

describe("the repack", () => {
  test("the template's entries in order, the game's files and identity, then the signature files", async () => {
    const apk = await repackAndroid(input({ identity: { ...IDENTITY, icon: ICON } }), options);
    const entries = readZip(apk);
    expect(entries.map((entry) => entry.name)).toEqual([
      ...readZip(TEMPLATE).map((entry) => entry.name),
      "META-INF/MANIFEST.MF",
      "META-INF/CERT.SF",
      "META-INF/CERT.RSA",
    ]);
    expect(readManifest(await unzipEntry(entryOf(entries, "AndroidManifest.xml")))).toMatchObject({
      packageName: "dev.pocket_nexus.studio.test_game",
      versionCode: 1_002_003,
      versionName: "1.2.3",
      minSdkVersion: 18,
      targetSdkVersion: 34,
      debuggable: false,
    });
    expect(readResourceTable(await unzipEntry(entryOf(entries, "resources.arsc")))).toMatchObject({
      packageName: "dev.pocket_nexus.studio.test_game",
      label: IDENTITY.title,
    });
    expect(await unzipEntry(entryOf(entries, "assets/app.js"))).toEqual(GAME_JS);
    expect(await unzipEntry(entryOf(entries, "assets/app.pak"))).toEqual(GAME_PAK);
    for (const [density, side] of ANDROID_ICON_DENSITIES) {
      const png = await decodePng(await unzipEntry(entryOf(entries, `res/mipmap-${density}-v4/icon.png`)));
      expect([png.width, png.height]).toEqual([side, side]);
      expect([...png.rgba.subarray(0, 4)]).toEqual([255, 210, 63, 255]);
      expect([...png.rgba.subarray(png.rgba.length - 4)]).toEqual([169, 139, 255, 255]);
    }
    for (const name of ["classes.dex", ...ABIS.map((abi) => `lib/${abi}/libpocketjs.so`)]) {
      expect(await unzipEntry(entryOf(entries, name))).toEqual(await templateEntry(name));
    }
  });

  test("stored entries sit where zipalign -p 4 puts them; the table is stored", async () => {
    const apk = await repackAndroid(input(), options);
    const entries = readZip(apk);
    expect(entryOf(entries, "resources.arsc").method).toBe(ZIP_STORED);
    const stored = entries.filter((entry) => entry.method === ZIP_STORED && !entry.name.startsWith("META-INF/"));
    expect(stored.some((entry) => entry.name.endsWith(".so"))).toBe(true);
    for (const entry of stored) {
      expect((entry.stored.byteOffset - apk.byteOffset) % (entry.name.endsWith(".so") ? 4096 : 4)).toBe(0);
    }
  });

  test("v1 and v2 signatures verify under the signer's certificate", async () => {
    const apk = await repackAndroid(input({ identity: { ...IDENTITY, icon: ICON } }), options);
    const report = await verifyApkSignatures(apk);
    expect(report.v1Certificate).toEqual(signer.certificate);
    expect(report.v2Certificate).toEqual(signer.certificate);
    expect([...report.v1Entries].sort()).toEqual(readZip(TEMPLATE).map((entry) => entry.name).sort());
  });

  test("the same inputs give the same bytes, from PKCS #8 bytes or a CryptoKey", async () => {
    const apk = await repackAndroid(input({ identity: { ...IDENTITY, icon: ICON } }), options);
    expect(await repackAndroid(input({ identity: { ...IDENTITY, icon: ICON } }), options)).toEqual(apk);
    const withKey = input({ identity: { ...IDENTITY, icon: ICON }, signer: { privateKey: signer.cryptoKey, certificate: signer.certificate } });
    expect(await repackAndroid(withKey, options)).toEqual(apk);
  });

  test("without an icon the template's default icon stays", async () => {
    const entries = readZip(await repackAndroid(input(), options));
    for (const [density] of ANDROID_ICON_DENSITIES) {
      const name = `res/mipmap-${density}-v4/icon.png`;
      expect(await unzipEntry(entryOf(entries, name))).toEqual(await templateEntry(name));
    }
  });
});

describe("the repack refuses", () => {
  test("no signer", async () => {
    await expect(repackAndroid({ ...input(), signer: undefined })).rejects.toThrow(/no signer/);
  });

  test("a certificate other than the community certificate, unless the caller names it", async () => {
    await expect(repackAndroid(input())).rejects.toThrow(
      new RegExp(`certificate is ${signer.certificateSha256}, not the Pocket Studio community certificate ${POCKET_STUDIO_COMMUNITY_SIGNER}`),
    );
    await expect(repackAndroid(input(), { certificateSha256: "0".repeat(64) })).rejects.toThrow(/not 0{64}/);
  });

  test("a key that is not the certificate's", async () => {
    const other = await makeTestSigner("Another Key");
    await expect(repackAndroid(input({ signer: { privateKey: other.privateKey, certificate: signer.certificate } }), options))
      .rejects.toThrow(/not the certificate's key/);
    await expect(repackAndroid(input({ signer: { privateKey: bytesOf("not a key"), certificate: signer.certificate } }), options))
      .rejects.toThrow(/not an RSA PKCS #8 key/);
  });

  test("a runtime without template.apk, or with a signed one", async () => {
    const runtime = fixtureRuntime();
    const manifest = JSON.parse(new TextDecoder().decode(runtime.get("runtime.json")));
    delete manifest.files[ANDROID_TEMPLATE];
    runtime.set("runtime.json", bytesOf(JSON.stringify(manifest)));
    await expect(repackAndroid(input({ runtime }), options)).rejects.toThrow(/lacks template\.apk/);
    const signed = await writeZip([...readZip(TEMPLATE).map((entry) => ({ name: entry.name, entry })), { name: "META-INF/MANIFEST.MF", data: bytesOf("x") }]);
    await expect(repackAndroid(input({ runtime: fixtureRuntime({}, signed) }), options)).rejects.toThrow(/template\.apk is signed/);
  });

  test("a .pocket without the runtime's target", async () => {
    const moto = resolveMotoGPlayBuildPlan({ ...JSON.parse(readFileSync(join(ROOT, "apps/clear/pocket.android.json"), "utf8")), id: IDENTITY.id });
    const pocket = fixturePocket(IDENTITY.id, [variantFor(moto)]);
    await expect(repackAndroid(input({ pocket }), options)).rejects.toThrow(/no redmi-1s-dev variant \(it has moto-g-play-dev\)/);
  });

  test("a variant for another host ABI", async () => {
    const variant = variantFor(resolveRedmi1sBuildPlan(clear()));
    const pocket = fixturePocket(IDENTITY.id, [{ ...variant, hostAbi: HOST_ABI - 1 }]);
    await expect(repackAndroid(input({ pocket }), options)).rejects.toThrow(new RegExp(`host ABI ${HOST_ABI - 1}; this runtime is ABI ${HOST_ABI}`));
  });

  test("a runtime for another host ABI", async () => {
    await expect(repackAndroid(input({ runtime: fixtureRuntime({ hostAbi: HOST_ABI + 1 }) }), options))
      .rejects.toThrow(new RegExp(`host ABI ${HOST_ABI}; this runtime is ABI ${HOST_ABI + 1}`));
  });

  test("a broken footer", async () => {
    const pocket = fixturePocket();
    pocket[pocket.length - 20] ^= 1;
    await expect(repackAndroid(input({ pocket }), options)).rejects.toThrow(/\.pocket is damaged: pocket package: hash mismatch/);
  });

  test("a runtime file that differs from runtime.json", async () => {
    const runtime = fixtureRuntime();
    runtime.set(ANDROID_TEMPLATE, bytesOf("another template"));
    await expect(repackAndroid(input({ runtime }), options)).rejects.toThrow(/template\.apk is not the file runtime\.json describes/);
  });

  test("a runtime drawing another viewport than the game's", async () => {
    const runtime = fixtureRuntime({ viewport: { logical: [360, 800], rasterDensity: 2 } });
    await expect(repackAndroid(input({ runtime }), options)).rejects.toThrow(/laid out at 360x640.*runtime draws 360x800/);
  });

  test("an icon that is not square", async () => {
    const icon = await encodePng({ width: 200, height: 100, rgba: new Uint8Array(200 * 100 * 4) });
    await expect(repackAndroid(input({ identity: { ...IDENTITY, icon } }), options)).rejects.toThrow(/200x100 is not square/);
  });

  test("an identity that is not the .pocket's app", async () => {
    await expect(repackAndroid({ ...input(), identity: { ...IDENTITY, id: "dev.pocket-nexus.studio.other" } }, options))
      .rejects.toThrow(/the identity says "dev\.pocket-nexus\.studio\.other"/);
  });

  test("a runtime for another device", async () => {
    await expect(repackAndroid(input({ runtime: fixtureRuntime({ target: "3ds-dev" }) }), options))
      .rejects.toThrow(/this runtime is for "3ds-dev", not "redmi-1s-dev"/);
  });
});

describe("zip", () => {
  test("entries round-trip, stored entries align, and the bytes are the same twice", async () => {
    const inputs = [
      { name: "a.txt", data: bytesOf("hello ".repeat(100)), align: 4 },
      { name: "lib/x.so", data: Uint8Array.from({ length: 999 }, (_, i) => i & 255), compress: false, align: 4096 },
    ];
    const zip = await writeZip(inputs);
    expect(await writeZip(inputs)).toEqual(zip);
    const entries = readZip(zip);
    expect(entries.map((e) => [e.name, e.method])).toEqual([["a.txt", 8], ["lib/x.so", 0]]);
    expect(await unzipEntry(entries[0]!)).toEqual(inputs[0]!.data);
    expect(entries[1]!.stored.byteOffset % 4096).toBe(0);
    expect(await unzipEntry(entries[1]!)).toEqual(inputs[1]!.data);
  });
});

// Where the Android SDK is installed (`bun tools/android.ts --profile=redmi-1s
// setup`): aapt2 links each game of a corpus, zipalign aligns it and
// apksigner signs it with the test key, and the TypeScript repack gives the
// same entries in the same order with the same bytes, apart from META-INF/;
// apksigner verifies the TypeScript APK (v1 + v2) and zipalign -c accepts it.
const sdk = localAndroidSdk();
const sdkReady = ["build-tools/35.0.0/aapt2", "build-tools/35.0.0/apksigner", "build-tools/35.0.0/zipalign", "platforms/android-34/android.jar"]
  .every((path) => existsSync(join(sdk.root, path))) && existsSync(join(sdk.javaHome, "bin/java"));

describe.skipIf(!sdkReady)("aapt2, zipalign and apksigner agree", () => {
  const javaEnv = { ...process.env, JAVA_HOME: sdk.javaHome, PATH: `${join(sdk.javaHome, "bin")}:${process.env.PATH ?? ""}` };
  const tool = (name: string) => buildTool(sdk, SDK_LEVELS.buildToolsVersion, name);
  const key = join(work, "test.pk8");
  const certificate = join(work, "test.der");
  writeFileSync(key, signer.privateKey);
  writeFileSync(certificate, signer.certificate);

  async function aapt2Apk(game: RepackInput, name: string): Promise<Uint8Array> {
    const unsigned = join(work, `${name}-unsigned.apk`), aligned = join(work, `${name}-aligned.apk`), signed = join(work, `${name}-signed.apk`);
    writeFileSync(unsigned, await linkAndroidApk(await androidLinkJob(game), sdk));
    runTool(tool("zipalign"), ["-f", "-p", "4", unsigned, aligned]);
    runTool(tool("apksigner"), [
      "sign", "--key", key, "--cert", certificate, "--min-sdk-version", "18",
      "--v1-signing-enabled", "true", "--v2-signing-enabled", "true", "--v3-signing-enabled", "false", "--v4-signing-enabled", "false",
      "--out", signed, aligned,
    ], javaEnv);
    return new Uint8Array(readFileSync(signed));
  }

  test("the fixture template is aapt2's link of hosts/android/app with the stand-in files", async () => {
    const linked = await linkAndroidApk(androidTemplateJob(await fixtureParts(), SDK_LEVELS, ABIS), sdk);
    // A change to hosts/android/app's templates needs POCKETJS_WRITE_ANDROID_FIXTURE=1 (see FIXTURE).
    expect(sha256(linked)).toBe(sha256(TEMPLATE));
  }, 60_000);

  const CORPUS = [
    { id: "dev.pocket-nexus.studio.test-game", title: `Tom's "Test" & <Game> 100%`, version: "1.2.3", icon: true },
    { id: "dev.pocket-nexus.studio.2pac.8-ball", title: "8 Ball", version: "0.1.0" },
    { id: "app.a", title: "日本語のゲーム\u3000タイトル", version: "10.20.30" },
    { id: "zz.zz", title: "Zebra 🦓 game", version: "1999.999.999" },
    { id: "dev.pocket-nexus.studio.twenty48-remix", title: "  Space \t  Game  ", version: "0.0.1" },
    { id: "com.x.y", title: "@home \\ ?", version: "1.0.0" },
  ];
  /** The runtimes compared: the fixture, and dist/runtime/android when a build of this tree left one. */
  const runtimes: Array<[string, Map<string, Uint8Array>]> = [["fixture", fixtureRuntime()]];
  if (existsSync(join(ROOT, "dist/runtime/android", ANDROID_TEMPLATE))) runtimes.push(["dist/runtime/android", readRuntimeDirectory(join(ROOT, "dist/runtime/android"))]);

  for (const [label, runtime] of runtimes) {
    test(`a corpus repacked on ${label} matches aapt2's, and apksigner verifies it`, async () => {
      for (const game of CORPUS) {
        const manifest = clear(game.id);
        const plan = resolveRedmi1sBuildPlan(manifest);
        if (label !== "fixture" && plan.target.hostAbi !== JSON.parse(new TextDecoder().decode(runtime.get("runtime.json"))).hostAbi) continue;
        const repackInput = input({
          runtime,
          pocket: encodePocketPackage({ manifest: bytesOf(JSON.stringify(manifest)), variants: [variantFor(plan)] }),
          identity: { id: game.id, title: game.title, author: "A Creator", version: game.version, ...(game.icon ? { icon: ICON } : {}) },
        });
        const typescript = await repackAndroid(repackInput, options);
        const oracle = await aapt2Apk(repackInput, "oracle");
        const files = async (apk: Uint8Array) =>
          Promise.all(readZip(apk).filter((entry) => !entry.name.startsWith("META-INF/")).map(async (entry) => [entry.name, sha256(await unzipEntry(entry))]));
        expect(await files(typescript)).toEqual(await files(oracle));

        const path = join(work, "typescript.apk");
        writeFileSync(path, typescript);
        const report = runTool(tool("apksigner"), ["verify", "--verbose", "--print-certs", "--min-sdk-version", "18", path], javaEnv);
        expect(report).toContain("Verified using v1 scheme (JAR signing): true");
        expect(report).toContain("Verified using v2 scheme (APK Signature Scheme v2): true");
        expect(report).toContain(`Signer #1 certificate SHA-256 digest: ${signer.certificateSha256}`);
        expect(Bun.spawnSync([tool("zipalign"), "-c", "-p", "4", path]).exitCode).toBe(0);
        const badging = runTool(tool("aapt2"), ["dump", "badging", path]);
        expect(badging).toContain(`package: name='${androidPackageName(game.id)}'`);
        // aapt2 dump badging prints a backslash and a double quote escaped.
        expect(badging).toContain(`application-label:'${androidLabel(game.title).replace(/[\\"]/g, "\\$&")}'`);
      }
    }, 240_000);
  }
});
