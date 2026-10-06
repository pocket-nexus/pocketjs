// The Android repack's test fixture: a runtime directory around
// tests/fixtures/repack-android/template.apk and a `.pocket` of Clear's
// Redmi 1S plan under a test id. Shared by tests/repack-android.test.ts and
// tests/repack-worker.test.ts.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodePocketPackage, type PocketPackageVariant } from "../../contracts/spec/pocket-package.ts";
import { canonicalJson } from "../../framework/src/manifest/plan.ts";
import { linkAndroidApk } from "../../tools/android-link.ts";
import { makeVariant } from "../../tools/pocket-pack.ts";
import { REDMI_1S_CONTRACTS, REDMI_1S_TARGET, resolveRedmi1sBuildPlan } from "../../tools/redmi-1s-profile.ts";
import { ANDROID_ICON_DENSITIES, ANDROID_TEMPLATE, androidTemplateJob } from "../../tools/repack/android.ts";
import { encodePng } from "../../tools/repack/shared/png.ts";

const ROOT = join(import.meta.dir, "../..");
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const bytesOf = (text: string) => new TextEncoder().encode(text);

export const HOST = join(ROOT, "hosts/android/app");
/**
 * aapt2's link of hosts/android/app's templates with ANDROID_TEMPLATE_IDENTITY,
 * stand-in classes.dex and libraries and a plain icon. Rewrite it with
 * `POCKETJS_WRITE_ANDROID_FIXTURE=1 bun test tests/repack-android.test.ts`
 * (Android SDK required); tests/repack-android.test.ts checks it against aapt2.
 */
export const FIXTURE = join(ROOT, "tests/fixtures/repack-android/template.apk");
export const ABIS = ["armeabi-v7a", "arm64-v8a"] as const;
export const SDK_LEVELS = { apiLevel: 34, buildToolsVersion: "35.0.0", minSdkVersion: 18, targetSdkVersion: 34 } as const;
export const HOST_ABI = REDMI_1S_CONTRACTS.targets[REDMI_1S_TARGET].hostAbi;

export function square(side: number, paint: (x: number, y: number) => [number, number, number, number]): Uint8Array {
  const rgba = new Uint8Array(side * side * 4);
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) rgba.set(paint(x, y), (y * side + x) * 4);
  return rgba;
}

/** The runtime build's files the fixture template is linked from. */
export async function fixtureParts(): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>([
    ["AndroidManifest.xml", new Uint8Array(readFileSync(join(HOST, "AndroidManifest.xml")))],
    ["res/values/strings.xml", new Uint8Array(readFileSync(join(HOST, "res/values/strings.xml")))],
    ["classes.dex", bytesOf("dex\n035\0 stand-in for PocketActivity")],
    ...ABIS.map((abi) => [`lib/${abi}/libpocketjs.so`, bytesOf(`\x7fELF stand-in ${abi}`)] as [string, Uint8Array]),
  ]);
  for (const [density, side] of ANDROID_ICON_DENSITIES) {
    files.set(`res/mipmap-${density}/icon.png`, await encodePng({ width: side, height: side, rgba: square(side, () => [23, 18, 38, 255]) }));
  }
  return files;
}

if (process.env.POCKETJS_WRITE_ANDROID_FIXTURE === "1") {
  mkdirSync(join(FIXTURE, ".."), { recursive: true });
  writeFileSync(FIXTURE, await linkAndroidApk(androidTemplateJob(await fixtureParts(), SDK_LEVELS, ABIS)));
}
export const TEMPLATE = new Uint8Array(readFileSync(FIXTURE));

/** A runtime directory around a template: the sources from hosts/android, runtime.json describing them. */
export function fixtureRuntime(overrides: Record<string, unknown> = {}, template: Uint8Array = TEMPLATE): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>([
    [ANDROID_TEMPLATE, template],
    ["AndroidManifest.xml", new Uint8Array(readFileSync(join(HOST, "AndroidManifest.xml")))],
    ["res/values/strings.xml", new Uint8Array(readFileSync(join(HOST, "res/values/strings.xml")))],
  ]);
  const manifest = {
    target: REDMI_1S_TARGET,
    hostAbi: HOST_ABI,
    pocketjs: "0".repeat(40),
    profile: "redmi-1s",
    viewport: { logical: [360, 640], rasterDensity: 2 },
    android: { ...SDK_LEVELS, abis: [...ABIS] },
    files: Object.fromEntries([...files].map(([path, bytes]) => [path, { bytes: bytes.length, sha256: sha256(bytes) }])),
    ...overrides,
  };
  files.set("runtime.json", bytesOf(JSON.stringify(manifest)));
  return files;
}

export const IDENTITY = { id: "dev.pocket-nexus.studio.test-game", title: "Tom's \"Test\" & <Game>", author: "A Creator", version: "1.2.3" };
/** Clear's Redmi 1S manifest under an id: the repack refuses an identity that is not the .pocket's app. */
export const clear = (id = IDENTITY.id) => ({ ...JSON.parse(readFileSync(join(ROOT, "apps/clear/pocket.redmi-1s.json"), "utf8")), id });
export const GAME_JS = bytesOf("globalThis.game = 1;\n".repeat(64));
export const GAME_PAK = Uint8Array.from({ length: 4096 }, (_, i) => (i * 7) & 0xff);

export function variantFor(plan: ReturnType<typeof resolveRedmi1sBuildPlan>): PocketPackageVariant {
  return makeVariant({
    target: plan.target.id,
    hostAbi: plan.target.hostAbi,
    planJson: canonicalJson(plan),
    identity: { output: plan.app.output, id: plan.app.id, title: plan.app.title },
    js: GAME_JS,
    pak: GAME_PAK,
  });
}

export function fixturePocket(id = IDENTITY.id, variants?: PocketPackageVariant[]): Uint8Array {
  const manifest = clear(id);
  return encodePocketPackage({
    manifest: bytesOf(JSON.stringify(manifest)),
    variants: variants ?? [variantFor(resolveRedmi1sBuildPlan(manifest))],
  });
}

