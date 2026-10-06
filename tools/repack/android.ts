// Repack: one Android APK from the generic Android runtime
// (tools/runtime/android.ts), a game's `.pocket` and its identity.
//
// The TypeScript half (this file, no file system and no native tools) checks
// the inputs and lays out every file the APK holds:
//
//   AndroidManifest.xml   the runtime's template with the package name
//                         (the id with `-` as `_`), versionCode
//                         (major * 1 000 000 + minor * 1 000 + patch),
//                         versionName, the SDK levels, not debuggable
//   res/values/strings.xml  the label (the identity's title)
//   res/mipmap-*/icon.png   the identity's icon scaled to 48 … 192 pixels,
//                         or the runtime's default icon
//   assets/app.js, assets/app.pak  the `.pocket` variant's bundle (without
//                         the section's NUL) and pack, the two files
//                         PocketActivity reads
//   classes.dex, lib/<abi>/libpocketjs.so  from the runtime, byte for byte
//
// The native half is one function, `AndroidNativeSteps`, that takes those
// files and returns the signed APK: aapt2 compile + link, the zip merge,
// zipalign and apksigner (v1 + v2; Android 4.3 reads v1 only). The default
// runs the local Android SDK and signs with the Pocket Studio community key
// (tools/repack/android-native.ts); a container can run the same function.

import { readZip } from "./shared/zip.ts";
import { decodePng, encodePng, scaleSquare } from "./shared/png.ts";
import { gameVariant, readRuntime, type RepackInput, type RuntimeManifest } from "./shared/input.ts";

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

/** Everything the native steps need: the APK's files laid out, and the SDK levels to link against. */
export interface AndroidNativeJob {
  /** AndroidManifest.xml, as text. */
  readonly manifest: string;
  /** Resource files by path under `res/`. */
  readonly resources: ReadonlyMap<string, Uint8Array>;
  /** Asset files by path under `assets/`. */
  readonly assets: ReadonlyMap<string, Uint8Array>;
  /** Entries added to the linked APK as they are: `classes.dex`, `lib/<abi>/libpocketjs.so`. */
  readonly entries: ReadonlyMap<string, Uint8Array>;
  readonly sdk: {
    /** The platform whose android.jar the manifest links against. */
    readonly apiLevel: number;
    readonly buildToolsVersion: string;
    readonly minSdkVersion: number;
    readonly targetSdkVersion: number;
  };
}

/** aapt2 compile + link, zip merge, zipalign, apksigner: the job's files in, a signed APK out. */
export type AndroidNativeSteps = (job: AndroidNativeJob) => Promise<Uint8Array>;

export interface AndroidPackageIdentity {
  readonly packageName: string;
  readonly versionCode: number;
  readonly versionName: string;
  readonly label: string;
}

/** The Android names of an identity: package = id with `-` as `_`; versionCode from major.minor.patch. */
export function androidIdentity(identity: RepackInput["identity"]): AndroidPackageIdentity {
  const packageName = identity.id.replaceAll("-", "_");
  if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(packageName)) {
    throw new Error(`repack android: ${identity.id} does not make an Android package name (${packageName})`);
  }
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(identity.version);
  if (!match) throw new Error(`repack android: version ${identity.version} is not major.minor.patch`);
  const [major, minor, patch] = match.slice(1, 4).map(Number);
  if (major >= 2000 || minor >= 1000 || patch >= 1000) {
    throw new Error(`repack android: version ${identity.version} is past the versionCode range`);
  }
  const label = identity.title.trim();
  if (!label) throw new Error("repack android: the title is empty");
  return { packageName, versionCode: major * 1_000_000 + minor * 1_000 + patch, versionName: identity.version, label };
}

function xmlEscape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * A string resource's text: XML-escaped, with the characters aapt2 reads as
 * syntax (backslash, both quotes, a leading `@` or `?`) escaped by a backslash.
 */
export function androidString(text: string): string {
  const escaped = text.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/"/g, '\\"').replace(/^([@?])/, "\\$1");
  return xmlEscape(escaped).replace(/\n/g, "\\n");
}

function render(template: string, values: Readonly<Record<string, string | number>>): string {
  return template.replace(/@POCKET_([A-Z_]+)@/g, (token, name: string) => {
    if (!(name in values)) throw new Error(`repack android: the runtime's template has no value for ${token}`);
    return String(values[name]);
  });
}

/** The runtime's runtime.json, checked as an Android runtime. */
export async function readAndroidRuntime(runtime: Map<string, Uint8Array>): Promise<AndroidRuntimeManifest> {
  const manifest = (await readRuntime(runtime)) as AndroidRuntimeManifest;
  const android = manifest.android;
  if (!android || !Array.isArray(android.abis) || !android.abis.length || !Number.isInteger(android.minSdkVersion)) {
    throw new Error("repack android: runtime.json has no android section; build it with tools/runtime/android.ts");
  }
  for (const path of ["AndroidManifest.xml", "res/values/strings.xml", "classes.dex", ...android.abis.map((abi) => `lib/${abi}/libpocketjs.so`)]) {
    if (!manifest.files[path]) throw new Error(`repack android: the runtime lacks ${path}`);
  }
  return manifest;
}

/** The launcher icon files, by path under `res/`: the identity's icon scaled, or the runtime's default. */
async function launcherIcons(runtime: Map<string, Uint8Array>, icon: Uint8Array | undefined): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  if (!icon) {
    for (const [density] of ANDROID_ICON_DENSITIES) {
      const path = `mipmap-${density}/icon.png`;
      const bytes = runtime.get(`res/${path}`);
      if (!bytes) throw new Error(`repack android: no icon given and the runtime has no res/${path}`);
      files.set(path, bytes);
    }
    return files;
  }
  const image = await decodePng(icon);
  if (image.width !== image.height) {
    throw new Error(`repack android: the icon is ${image.width} by ${image.height}; a launcher icon is square`);
  }
  for (const [density, side] of ANDROID_ICON_DENSITIES) {
    files.set(`mipmap-${density}/icon.png`, await encodePng({ width: side, height: side, rgba: scaleSquare(image.rgba, image.width, side) }));
  }
  return files;
}

/** Checks the inputs and lays out the APK's files: the TypeScript half of the repack. */
export async function prepareAndroidJob(input: RepackInput): Promise<AndroidNativeJob> {
  const runtime = await readAndroidRuntime(input.runtime);
  const game = gameVariant(input.pocket, runtime);
  const [width, height] = runtime.viewport.logical;
  if (game.plan.viewport.logical[0] !== width || game.plan.viewport.logical[1] !== height ||
    game.plan.viewport.rasterDensity !== runtime.viewport.rasterDensity) {
    throw new Error(
      `repack android: the game is laid out at ${game.plan.viewport.logical.join("x")} density ${game.plan.viewport.rasterDensity}, ` +
        `and the runtime draws ${width}x${height} density ${runtime.viewport.rasterDensity}`,
    );
  }
  const names = androidIdentity(input.identity);
  const { android } = runtime;
  const decoder = new TextDecoder();
  const manifest = render(decoder.decode(input.runtime.get("AndroidManifest.xml")!), {
    PACKAGE: names.packageName,
    VERSION_CODE: names.versionCode,
    VERSION_NAME: xmlEscape(names.versionName),
    MIN_SDK: android.minSdkVersion,
    TARGET_SDK: android.targetSdkVersion,
    DEBUGGABLE: "false",
  });
  const resources = new Map<string, Uint8Array>();
  resources.set("values/strings.xml", new TextEncoder().encode(render(decoder.decode(input.runtime.get("res/values/strings.xml")!), {
    TITLE: androidString(names.label),
  })));
  for (const [path, bytes] of await launcherIcons(input.runtime, input.identity.icon)) resources.set(path, bytes);
  const entries = new Map<string, Uint8Array>();
  entries.set("classes.dex", input.runtime.get("classes.dex")!);
  for (const abi of [...android.abis].sort()) entries.set(`lib/${abi}/libpocketjs.so`, input.runtime.get(`lib/${abi}/libpocketjs.so`)!);
  return {
    manifest,
    resources,
    assets: new Map([["app.js", game.js], ["app.pak", game.pak]]),
    entries,
    sdk: {
      apiLevel: android.apiLevel,
      buildToolsVersion: android.buildToolsVersion,
      minSdkVersion: android.minSdkVersion,
      targetSdkVersion: android.targetSdkVersion,
    },
  };
}

/** The entries every repacked APK holds, besides `res/` files. */
export function expectedApkEntries(job: AndroidNativeJob): string[] {
  return [
    "AndroidManifest.xml",
    "resources.arsc",
    ...[...job.assets.keys()].map((path) => `assets/${path}`),
    ...job.entries.keys(),
    "META-INF/MANIFEST.MF",
  ];
}

/**
 * The APK of a game: `input` checked and laid out here, then linked, aligned
 * and signed by `options.native` (default: the local Android SDK and the
 * Pocket Studio community key).
 */
export async function repackAndroid(input: RepackInput, options: { native?: AndroidNativeSteps } = {}): Promise<Uint8Array> {
  const job = await prepareAndroidJob(input);
  const native = options.native ?? (await import("./android-native.ts")).androidNativeSteps();
  const apk = await native(job);
  const names = new Set(readZip(apk).map((entry) => entry.name));
  const missing = expectedApkEntries(job).filter((name) => !names.has(name));
  if (missing.length) throw new Error(`repack android: the native steps left out ${missing.join(", ")}`);
  return apk;
}
