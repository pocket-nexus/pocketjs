// Repack: one signed Android APK from the generic Android runtime
// (tools/runtime/android.ts), a game's `.pocket`, its identity and a signer.
// TypeScript and Web APIs only (crypto.subtle, CompressionStream): no SDK,
// no file system, so a Cloudflare Worker runs it as the CLI does.
//
// The runtime carries `template.apk`: aapt2's link of the runtime with
// ANDROID_TEMPLATE_IDENTITY, the default icon, empty assets, classes.dex and
// lib/<abi>/libpocketjs.so, unsigned. The repack keeps its entries in their
// order and replaces five things:
//
//   AndroidManifest.xml   package, android:versionCode and android:versionName
//                         rewritten in the compiled XML (shared/android-resources.ts)
//   resources.arsc        the package name and string/app_name (the label)
//   res/mipmap-*/icon.png the identity's icon scaled to 48 … 192 pixels, or
//                         the template's default icon
//   assets/app.js, assets/app.pak  the `.pocket` variant's bundle (without the
//                         section's NUL) and pack, the files PocketActivity reads
//   META-INF/             v1 (JAR) and v2 signatures (shared/apk-sign.ts)
//
// Stored entries are 4-byte aligned and stored .so files 4096-byte aligned,
// as `zipalign -p 4` places them. Where the Android SDK is installed,
// tests/repack-android.test.ts compares the APK with aapt2 + zipalign +
// apksigner's output for the same identity: the same entries in the same
// order and the same bytes in each, apart from the signature files.
//
// Names, from the identity:
//
//   package name  the id with each `-` as `_`; a dot-separated segment that
//                 then starts with a digit gets `x` in front
//                 (dev.pocket-nexus.studio.2pac.8-ball →
//                 dev.pocket_nexus.studio.x2pac.x8_ball). Each segment is a
//                 letter, then letters, digits and `_`; at most 127 characters.
//   versionCode   major * 1 000 000 + minor * 1 000 + patch
//   versionName   the version as given
//   label         the title with leading and trailing ASCII whitespace
//                 removed and each inner run of it as one space (what aapt2
//                 makes of a string resource); a control character is refused
//
// The signer is the Pocket Studio community key: the repack refuses a
// certificate whose SHA-256 is not POCKET_STUDIO_COMMUNITY_SIGNER, unless the
// caller names another certificate in `options.certificateSha256` (a test's
// throwaway key). The Pocket Nexus release key signs Pocket Nexus's own apps
// only.

import { POCKET_SECTION, findSection } from "../../contracts/spec/pocket-package.ts";
import { signApk } from "./shared/apk-sign.ts";
import { MAX_PACKAGE_NAME, patchManifest, patchResourceTable, readManifest, readResourceTable } from "./shared/android-resources.ts";
import { decodePng, encodePng } from "./shared/png.ts";
import { squareIcon } from "./shared/scale.ts";
import {
  admitPocket,
  checkIdentity,
  readRuntime,
  RUNTIME_MANIFEST,
  sha256Hex,
  type RepackIdentity,
  type RepackInput,
  type RuntimeManifest,
} from "./shared/runtime.ts";
import { readZip, unzipEntry, ZIP_STORED, type ZipEntry, type ZipInput } from "./shared/zip.ts";

/**
 * SHA-256 of the certificate of the Pocket Studio community key
 * (`~/.config/pocket-nexus/signing/pocket-studio-community.p12`, alias
 * `pocket-studio-community`, RSA 4096, CN=Pocket Studio Community,
 * O=Pocket Nexus Inc., C=US). Creators' games are signed with it; the Pocket
 * Nexus release key signs Pocket Nexus's own apps only.
 */
export const POCKET_STUDIO_COMMUNITY_SIGNER = "54c2abe6c53e5ead78b7d6c20ebcf23ed03b61d6d7ff081256e155fcdff6095c";

/** The launcher icon's file per density bucket (tools/android-icon.ts bakes the same five). */
export const ANDROID_ICON_DENSITIES = [
  ["mdpi", 48],
  ["hdpi", 72],
  ["xhdpi", 96],
  ["xxhdpi", 144],
  ["xxxhdpi", 192],
] as const;

/** The `.pocket` targets an Android runtime boots: the redmi-1s and moto-g-play profiles (tools/runtime/android.ts). */
export const ANDROID_RUNTIME_TARGETS = ["redmi-1s-dev", "moto-g-play-dev"] as const;

/** The runtime's unsigned APK, which every repack starts from. */
export const ANDROID_TEMPLATE = "template.apk";
/** The identity template.apk is linked with. */
export const ANDROID_TEMPLATE_IDENTITY: RepackIdentity = {
  id: "dev.pocket-nexus.runtime.template",
  title: "PocketJS",
  author: "Pocket Nexus",
  version: "0.0.1",
};
/** The text template.apk was linked from, kept in the runtime for the aapt2 comparison. */
export const ANDROID_TEMPLATE_SOURCES = ["AndroidManifest.xml", "res/values/strings.xml"] as const;

/** runtime.json of an Android runtime. */
export interface AndroidRuntimeManifest extends RuntimeManifest {
  readonly viewport: { readonly logical: readonly [number, number]; readonly rasterDensity: number };
  readonly android: {
    readonly apiLevel: number;
    readonly buildToolsVersion: string;
    readonly minSdkVersion: number;
    readonly targetSdkVersion: number;
    readonly abis: readonly string[];
  };
}

/**
 * What aapt2 links for an APK: the manifest and resources as source, the
 * assets, and the entries added to the linked APK as they are. The runtime
 * build links template.apk from one; the aapt2 comparison links each game.
 */
export interface AndroidLinkJob {
  /** AndroidManifest.xml, as text. */
  readonly manifest: string;
  /** Resource files by path under `res/`. */
  readonly resources: ReadonlyMap<string, Uint8Array>;
  /** Asset files by path under `assets/`. */
  readonly assets: ReadonlyMap<string, Uint8Array>;
  /** `classes.dex`, `lib/<abi>/libpocketjs.so`. */
  readonly entries: ReadonlyMap<string, Uint8Array>;
  readonly sdk: {
    /** The platform whose android.jar the manifest links against. */
    readonly apiLevel: number;
    readonly buildToolsVersion: string;
    readonly minSdkVersion: number;
    readonly targetSdkVersion: number;
  };
}

export interface AndroidPackageIdentity {
  readonly packageName: string;
  readonly versionCode: number;
  readonly versionName: string;
  readonly label: string;
}

export interface AndroidRepackOptions {
  /** The certificate SHA-256 (hex) the signer must have; default POCKET_STUDIO_COMMUNITY_SIGNER. */
  readonly certificateSha256?: string;
}

function fail(message: string): never {
  throw new Error(`repack android: ${message}`);
}

/**
 * The Android package name of an app id: each `-` as `_`, and `x` in front
 * of a dot-separated segment that then starts with a digit.
 */
export function androidPackageName(id: string): string {
  const segments = id.split(".").map((segment) => {
    const name = segment.replaceAll("-", "_");
    return /^[0-9]/.test(name) ? `x${name}` : name;
  });
  const packageName = segments.join(".");
  if (segments.length < 2 || !segments.every((segment) => /^[A-Za-z][A-Za-z0-9_]*$/.test(segment))) {
    fail(`${id} does not make an Android package name (${packageName})`);
  }
  if (packageName.length > MAX_PACKAGE_NAME) fail(`the package name of ${id} is longer than ${MAX_PACKAGE_NAME} characters`);
  return packageName;
}

/** The launcher label of a title: ASCII whitespace trimmed, each inner run of it one space. */
export function androidLabel(title: string): string {
  return title.replace(/^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g, "").replace(/[ \t\n\r\f\v]+/g, " ");
}

/** The Android names of an identity. */
export function androidIdentity(identity: Pick<RepackIdentity, "id" | "title" | "version">): AndroidPackageIdentity {
  const packageName = androidPackageName(identity.id);
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(identity.version);
  if (!match) fail(`version ${identity.version} is not major.minor.patch`);
  const [major, minor, patch] = match.slice(1, 4).map(Number) as [number, number, number];
  if (major >= 2000 || minor >= 1000 || patch >= 1000) fail(`version ${identity.version} is past the versionCode range`);
  const versionCode = major * 1_000_000 + minor * 1_000 + patch;
  if (versionCode === 0) fail("version 0.0.0 gives versionCode 0, which Android refuses");
  const label = androidLabel(identity.title);
  if (!label) fail("the title is empty");
  if (/[\u0000-\u001f\u007f]/.test(label)) fail("the title holds a control character");
  return { packageName, versionCode, versionName: identity.version, label };
}

function xmlEscape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * A string resource's source text for aapt2: XML-escaped, with the characters
 * aapt2 reads as syntax (backslash, both quotes, a leading `@` or `?`)
 * escaped by a backslash.
 */
export function androidString(text: string): string {
  const escaped = text.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/"/g, '\\"').replace(/^([@?])/, "\\$1");
  return xmlEscape(escaped).replace(/\n/g, "\\n");
}

function render(template: string, values: Readonly<Record<string, string | number>>): string {
  return template.replace(/@POCKET_([A-Z_]+)@/g, (token, name: string) => {
    if (!(name in values)) fail(`the runtime's template has no value for ${token}`);
    return String(values[name]);
  });
}

/** The manifest and strings sources rendered for an identity: what aapt2 links. */
export function renderAndroidSources(
  sources: { readonly manifest: string; readonly strings: string },
  names: AndroidPackageIdentity,
  sdk: { readonly minSdkVersion: number; readonly targetSdkVersion: number },
): { manifest: string; strings: string } {
  return {
    manifest: render(sources.manifest, {
      PACKAGE: names.packageName,
      VERSION_CODE: names.versionCode,
      VERSION_NAME: xmlEscape(names.versionName),
      MIN_SDK: sdk.minSdkVersion,
      TARGET_SDK: sdk.targetSdkVersion,
      DEBUGGABLE: "false",
    }),
    strings: render(sources.strings, { TITLE: androidString(names.label) }),
  };
}

/** The runtime's runtime.json, checked as an Android runtime. */
export async function readAndroidRuntime(runtime: ReadonlyMap<string, Uint8Array>): Promise<AndroidRuntimeManifest> {
  let target: unknown;
  try {
    target = JSON.parse(new TextDecoder().decode(runtime.get(RUNTIME_MANIFEST) ?? new Uint8Array())).target;
  } catch {
    target = undefined;
  }
  // readRuntime refuses a missing or broken runtime.json with the reason; a known target goes to it as is.
  const expected = (ANDROID_RUNTIME_TARGETS as readonly unknown[]).includes(target) ? String(target) : ANDROID_RUNTIME_TARGETS[0];
  const manifest = (await readRuntime(runtime as Map<string, Uint8Array>, expected)) as AndroidRuntimeManifest;
  const android = manifest.android;
  if (!android || !Array.isArray(android.abis) || !android.abis.length || !Number.isInteger(android.minSdkVersion)) {
    fail("runtime.json has no android section; build it with tools/runtime/android.ts");
  }
  for (const path of [ANDROID_TEMPLATE, ...ANDROID_TEMPLATE_SOURCES]) {
    if (!manifest.files[path]) fail(`the runtime lacks ${path}; build it with tools/runtime/android.ts`);
  }
  return manifest;
}

interface Template {
  readonly entries: readonly ZipEntry[];
  readonly entry: (name: string) => ZipEntry;
  /** The launcher icon's entry name per density (`res/mipmap-<density>-v4/icon.png`). */
  readonly icons: ReadonlyMap<string, string>;
}

/** template.apk's entries, checked: the files the repack replaces and the runtime's program are there, no signature. */
function readTemplate(bytes: Uint8Array, runtime: AndroidRuntimeManifest): Template {
  const entries = readZip(bytes);
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const entry = (name: string) => byName.get(name) ?? fail(`${ANDROID_TEMPLATE} has no ${name}`);
  for (const name of ["AndroidManifest.xml", "resources.arsc", "assets/app.js", "assets/app.pak", "classes.dex", ...runtime.android.abis.map((abi) => `lib/${abi}/libpocketjs.so`)]) {
    entry(name);
  }
  if (entries.some((candidate) => candidate.name.startsWith("META-INF/"))) fail(`${ANDROID_TEMPLATE} is signed; the runtime's template is unsigned`);
  const icons = new Map<string, string>();
  for (const [density] of ANDROID_ICON_DENSITIES) {
    const found = entries.filter((candidate) => new RegExp(`^res/mipmap-${density}(-v\\d+)?/icon\\.png$`).test(candidate.name));
    if (found.length !== 1) fail(`${ANDROID_TEMPLATE} has ${found.length} ${density} launcher icons`);
    icons.set(density, found[0]!.name);
  }
  return { entries, entry, icons };
}

interface AdmittedGame {
  readonly names: AndroidPackageIdentity;
  readonly runtime: AndroidRuntimeManifest;
  readonly template: Template;
  readonly js: Uint8Array;
  readonly pak: Uint8Array;
  /** The identity's icon at each density, by density; none without an icon. */
  readonly icons: ReadonlyMap<string, Uint8Array> | null;
}

/** The checks every Android repack makes, and the game's files. */
async function admitAndroidGame(input: RepackInput): Promise<AdmittedGame> {
  checkIdentity(input.identity);
  const names = androidIdentity(input.identity);
  const runtime = await readAndroidRuntime(input.runtime);
  const game = admitPocket(input.pocket, runtime, input.identity);
  const viewport = game.plan.viewport as { logical?: readonly number[]; rasterDensity?: number } | undefined;
  const [width, height] = runtime.viewport.logical;
  if (viewport?.logical?.[0] !== width || viewport.logical[1] !== height || viewport.rasterDensity !== runtime.viewport.rasterDensity) {
    fail(
      `the game is laid out at ${viewport?.logical?.join("x")} density ${viewport?.rasterDensity}, ` +
        `and the runtime draws ${width}x${height} density ${runtime.viewport.rasterDensity}`,
    );
  }
  const js = findSection(game.variant, POCKET_SECTION.js)!;
  const pak = findSection(game.variant, POCKET_SECTION.pak);
  if (js[js.length - 1] !== 0) fail(`the ${runtime.target} js section is not NUL-terminated`);
  if (!pak) fail(`the .pocket's ${runtime.target} variant has no pak`);
  const template = readTemplate(input.runtime.get(ANDROID_TEMPLATE)!, runtime);
  let icons: Map<string, Uint8Array> | null = null;
  if (input.identity.icon) {
    const image = await decodePng(input.identity.icon);
    icons = new Map();
    for (const [density, side] of ANDROID_ICON_DENSITIES) icons.set(density, await encodePng(squareIcon(image, side)));
  }
  // PocketActivity hands app.js to QuickJS with its length and the host's copy adds the NUL
  // JS_Eval reads to (hosts/android/app/jni/runtime.c), so the section's NUL stays out.
  return { names, runtime, template, js: js.subarray(0, js.length - 1), pak, icons };
}

/** Where zipalign -p 4 puts a stored entry's data: .so files on 4096 bytes, the rest on 4. */
function alignment(name: string): number {
  return name.endsWith(".so") ? 4096 : 4;
}

/** The signer's certificate, checked against the one the caller expects (default: the community key's). */
async function checkSigner(input: RepackInput, options: AndroidRepackOptions): Promise<NonNullable<RepackInput["signer"]>> {
  const signer = input.signer;
  if (!signer?.privateKey || !(signer.certificate instanceof Uint8Array)) {
    fail("no signer: an APK is signed with the Pocket Studio community key ({ privateKey, certificate })");
  }
  const expected = options.certificateSha256 ?? POCKET_STUDIO_COMMUNITY_SIGNER;
  const actual = await sha256Hex(signer.certificate);
  if (actual !== expected) {
    fail(
      expected === POCKET_STUDIO_COMMUNITY_SIGNER
        ? `the signer's certificate is ${actual}, not the Pocket Studio community certificate ${POCKET_STUDIO_COMMUNITY_SIGNER}`
        : `the signer's certificate is ${actual}, not ${expected}`,
    );
  }
  return signer;
}

/** The signed APK of a game. */
export async function repackAndroid(input: RepackInput, options: AndroidRepackOptions = {}): Promise<Uint8Array> {
  const signer = await checkSigner(input, options);
  const { names, runtime, template, js, pak, icons } = await admitAndroidGame(input);

  const templateManifestBytes = await unzipEntry(template.entry("AndroidManifest.xml"));
  const templateManifest = readManifest(templateManifestBytes);
  if (
    templateManifest.minSdkVersion !== runtime.android.minSdkVersion ||
    templateManifest.targetSdkVersion !== runtime.android.targetSdkVersion ||
    templateManifest.debuggable
  ) {
    fail(`${ANDROID_TEMPLATE} is not linked for SDK ${runtime.android.minSdkVersion} to ${runtime.android.targetSdkVersion}, not debuggable`);
  }
  const manifest = patchManifest(templateManifestBytes, names);
  const table = patchResourceTable(await unzipEntry(template.entry("resources.arsc")), names);
  const check = readManifest(manifest);
  if (check.packageName !== names.packageName || check.versionCode !== names.versionCode || check.versionName !== names.versionName) {
    fail("the rewritten manifest does not read back as the identity");
  }
  if (readResourceTable(table).label !== names.label) fail("the rewritten resource table does not read back the label");

  const replaced = new Map<string, { readonly data: Uint8Array; readonly compress: boolean }>([
    // aapt2 deflates the manifest and stores the table, which Android maps from the APK.
    ["AndroidManifest.xml", { data: manifest, compress: true }],
    ["resources.arsc", { data: table, compress: false }],
    ["assets/app.js", { data: js, compress: true }],
    ["assets/app.pak", { data: pak, compress: true }],
  ]);
  if (icons) {
    // aapt2 stores PNG files as they are.
    for (const [density, name] of template.icons) replaced.set(name, { data: icons.get(density)!, compress: false });
  }
  const entries: ZipInput[] = template.entries.map((entry) => {
    const change = replaced.get(entry.name);
    if (change) return { name: entry.name, data: change.data, compress: change.compress, align: alignment(entry.name) };
    return { name: entry.name, entry, ...(entry.method === ZIP_STORED ? { align: alignment(entry.name) } : {}) };
  });
  return signApk(entries, signer);
}

/**
 * The files aapt2 links for the same game as repackAndroid: the rendered
 * sources, the scaled or default icons, the assets, and classes.dex and the
 * libraries from template.apk. tests/repack-android.test.ts links it with
 * aapt2 to compare.
 */
export async function androidLinkJob(input: RepackInput): Promise<AndroidLinkJob> {
  const { names, runtime, template, js, pak, icons } = await admitAndroidGame(input);
  const decoder = new TextDecoder();
  const sources = renderAndroidSources(
    { manifest: decoder.decode(input.runtime.get(ANDROID_TEMPLATE_SOURCES[0])), strings: decoder.decode(input.runtime.get(ANDROID_TEMPLATE_SOURCES[1])) },
    names,
    runtime.android,
  );
  const resources = new Map<string, Uint8Array>([["values/strings.xml", new TextEncoder().encode(sources.strings)]]);
  for (const [density, name] of template.icons) {
    resources.set(`mipmap-${density}/icon.png`, icons?.get(density) ?? (await unzipEntry(template.entry(name))));
  }
  const entries = new Map<string, Uint8Array>();
  entries.set("classes.dex", await unzipEntry(template.entry("classes.dex")));
  for (const abi of [...runtime.android.abis].sort()) {
    entries.set(`lib/${abi}/libpocketjs.so`, await unzipEntry(template.entry(`lib/${abi}/libpocketjs.so`)));
  }
  return {
    manifest: sources.manifest,
    resources,
    assets: new Map([["app.js", js], ["app.pak", pak]]),
    entries,
    sdk: {
      apiLevel: runtime.android.apiLevel,
      buildToolsVersion: runtime.android.buildToolsVersion,
      minSdkVersion: runtime.android.minSdkVersion,
      targetSdkVersion: runtime.android.targetSdkVersion,
    },
  };
}

/**
 * What aapt2 links into template.apk: the sources rendered with
 * ANDROID_TEMPLATE_IDENTITY, the default icon, empty assets, and the
 * runtime's classes.dex and libraries. `files` holds the runtime build's
 * files by path: AndroidManifest.xml, res/values/strings.xml,
 * res/mipmap-<density>/icon.png, classes.dex, lib/<abi>/libpocketjs.so.
 */
export function androidTemplateJob(files: ReadonlyMap<string, Uint8Array>, sdk: AndroidLinkJob["sdk"], abis: readonly string[]): AndroidLinkJob {
  const file = (path: string) => files.get(path) ?? fail(`the runtime build has no ${path}`);
  const decoder = new TextDecoder();
  const sources = renderAndroidSources(
    { manifest: decoder.decode(file(ANDROID_TEMPLATE_SOURCES[0])), strings: decoder.decode(file(ANDROID_TEMPLATE_SOURCES[1])) },
    androidIdentity(ANDROID_TEMPLATE_IDENTITY),
    sdk,
  );
  const resources = new Map<string, Uint8Array>([["values/strings.xml", new TextEncoder().encode(sources.strings)]]);
  for (const [density] of ANDROID_ICON_DENSITIES) resources.set(`mipmap-${density}/icon.png`, file(`res/mipmap-${density}/icon.png`));
  const entries = new Map<string, Uint8Array>([["classes.dex", file("classes.dex")]]);
  for (const abi of [...abis].sort()) entries.set(`lib/${abi}/libpocketjs.so`, file(`lib/${abi}/libpocketjs.so`));
  return { manifest: sources.manifest, resources, assets: new Map([["app.js", new Uint8Array()], ["app.pak", new Uint8Array()]]), entries, sdk };
}
