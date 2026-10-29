import { parsePocketProfile } from "../../framework/src/profile.ts";
import { profileRegistry } from "../../tools/profile-resolver.ts";
import { validateAndResolveBuildPlan } from "../../framework/src/manifest/resolve.ts";
import { POCKET_BINDING_GENERATION } from "../../contracts/spec/binding-generation.ts";
import type { ResolvedBuildPlan } from "../../framework/src/manifest/plan.ts";
import { runtimeDirectory } from "./runtime-directory.ts";
// The Android repack's test fixture: a runtime directory around
// tests/fixtures/repack-android/template.apk and a `.pocket` of Clear's
// external Android profile under a test id. Shared by tests/repack-android.test.ts and
// tests/repack-worker.test.ts.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodePocketPackage, type PocketPackageVariant } from "../../contracts/spec/pocket-package.ts";
import { canonicalJson } from "../../framework/src/manifest/plan.ts";
import { linkAndroidApk } from "../../tools/android-link.ts";
import { makeVariant } from "../../tools/pocket-pack.ts";
export const ANDROID_FIXTURE_TARGET = "test-android-product";
export const ANDROID_FIXTURE_PROFILE = parsePocketProfile({
  format: "pocket-profile/2", id: ANDROID_FIXTURE_TARGET, platform: "android", form: "takeover", cadences: [60, 30],
  display: { logicalViewports: [[360, 640]], presentations: ["native"], rasterDensity: 2, animation: "composited" },
  panel: { primary: [720, 1280] },
  capabilities: ["input.touch", "text.glyphs.baked", "io.offload"],
});
export function resolveAndroidFixturePlan(manifest: unknown, target = ANDROID_FIXTURE_TARGET): ResolvedBuildPlan {
  const profile = parsePocketProfile({ ...ANDROID_FIXTURE_PROFILE, id: target });
  const result = validateAndResolveBuildPlan(manifest, { target }, profileRegistry(profile));
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.plan;
}
import { ANDROID_ICON_DENSITIES, ANDROID_TEMPLATE, androidTemplateJob } from "../../tools/repack/android.ts";
import { encodePng } from "../../tools/repack/shared/png.ts";

const ROOT = join(import.meta.dir, "../..");
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const bytesOf = (text: string) => new TextEncoder().encode(text);

export const HOST = join(ROOT, "tests/fixtures/repack-android/sources");
/**
 * aapt2's link of the maintained Android test templates's templates with ANDROID_TEMPLATE_IDENTITY,
 * stand-in classes.dex and libraries and a plain icon. Rewrite it with
 * `POCKETJS_WRITE_ANDROID_FIXTURE=1 bun test tests/repack-android.test.ts`
 * (Android SDK required); tests/repack-android.test.ts checks it against aapt2.
 */
export const FIXTURE = join(ROOT, "tests/fixtures/repack-android/template.apk");
export const ABIS = ["armeabi-v7a", "arm64-v8a"] as const;
export const SDK_LEVELS = { apiLevel: 34, buildToolsVersion: "35.0.0", minSdkVersion: 18, targetSdkVersion: 34 } as const;
export const HOST_ABI = POCKET_BINDING_GENERATION;

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

/** A runtime directory around a template: the maintained template sources, runtime.json describing them. */
export function fixtureRuntime(overrides: Record<string, unknown> = {}, template: Uint8Array = TEMPLATE): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>([
    [ANDROID_TEMPLATE, template],
    ["AndroidManifest.xml", new Uint8Array(readFileSync(join(HOST, "AndroidManifest.xml")))],
    ["res/values/strings.xml", new Uint8Array(readFileSync(join(HOST, "res/values/strings.xml")))],
  ]);
  const runtime = runtimeDirectory(ANDROID_FIXTURE_PROFILE, files, {
    hostAbi: HOST_ABI, extra: { viewport: { logical: [360, 640], rasterDensity: 2 }, android: { ...SDK_LEVELS, abis: [...ABIS] } },
  });
  const manifest = { ...JSON.parse(new TextDecoder().decode(runtime.get("runtime.json"))), ...overrides };
  runtime.set("runtime.json", bytesOf(JSON.stringify(manifest)));
  return runtime;
}

export const IDENTITY = { id: "dev.pocket-nexus.studio.test-game", title: "Tom's \"Test\" & <Game>", author: "A Creator", version: "1.2.3" };
/** A fixture application: repack must keep package and application identity equal. */
export const clear = (id = IDENTITY.id) => ({
  $schema: "https://pocketjs.dev/schema/pocket-2.json", pocket: 2, id, name: "fixture-android", title: "Android Fixture", version: "0.1.0",
  engine: { capabilities: { requires: ["input.touch", "text.glyphs.baked", "io.offload"] } },
  app: { entry: "fixture.ts", output: "clear-main", framework: "solid",
    viewport: { fixed: { logical: [360, 640], presentation: "native" } } },
});
export const GAME_JS = bytesOf("globalThis.game = 1;\n".repeat(64));
export const GAME_PAK = Uint8Array.from({ length: 4096 }, (_, i) => (i * 7) & 0xff);

export function variantFor(plan: ResolvedBuildPlan): PocketPackageVariant {
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
    variants: variants ?? [variantFor(resolveAndroidFixturePlan(manifest))],
  });
}

