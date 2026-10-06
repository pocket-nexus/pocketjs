import { readFileSync, writeFileSync } from "node:fs";
import { readZip, writeZip, unzipEntry } from "../shared/zip.ts";
import { gameVariant, readRuntime } from "../shared/input.ts";
import { readRuntimeDirectory } from "../../repack.ts";
import { patchManifest, patchResources } from "./patch.ts";
import { signApk } from "./sign.ts";
const G = process.env.GAMES ?? "games"; // directory with twenty48-remix.apk, snack-snake-remix.apk/.pocket
const file = (apk: string, name: string) => unzipEntry(readZip(new Uint8Array(readFileSync(apk))).find((e) => e.name === name)!);
const template = `${G}/twenty48-remix.apk`, other = `${G}/snack-snake-remix.apk`;

// 1. Does patching reproduce aapt2's output for another identity?
const from = { packageName: "dev.pocket_nexus.studio.twenty48_remix", versionName: "0.1.0", label: "Twenty48 Remix" };
const snake = { packageName: "dev.pocket_nexus.studio.snack_snake_remix", versionCode: 1000, versionName: "0.1.0", label: "Snack Snake Remix" };
const manifest = patchManifest(await file(template, "AndroidManifest.xml"), from, snake);
const arsc = patchResources(await file(template, "resources.arsc"), from, snake);
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
console.log("manifest == aapt2's:", same(manifest, await file(other, "AndroidManifest.xml")));
console.log("resources.arsc == aapt2's:", same(arsc, await file(other, "resources.arsc")));

// 2. A whole APK in TypeScript: template entries, patched identity, another game's assets, the default icon, WebCrypto signatures.
const runtimeFiles = readRuntimeDirectory("dist/runtime/android");
const game = gameVariant(new Uint8Array(readFileSync(`${G}/snack-snake-remix.pocket`)), await readRuntime(runtimeFiles));
const ts = { packageName: "dev.pocket_nexus.studio.ts_signed", versionCode: 2003004, versionName: "2.3.4", label: "TS Signed" };
const t0 = performance.now();
const replaced = new Map<string, Uint8Array>([
  ["AndroidManifest.xml", patchManifest(await file(template, "AndroidManifest.xml"), from, ts)],
  ["resources.arsc", patchResources(await file(template, "resources.arsc"), from, ts)],
  ["assets/app.js", game.js],
  ["assets/app.pak", game.pak],
  ...["mdpi", "hdpi", "xhdpi", "xxhdpi", "xxxhdpi"].map((d) => [`res/mipmap-${d}-v4/icon.png`, runtimeFiles.get(`res/mipmap-${d}/icon.png`)!] as [string, Uint8Array]),
]);
const entries = readZip(new Uint8Array(readFileSync(template))).filter((e) => !e.name.startsWith("META-INF/"));
const unsigned = await writeZip(entries.map((e) => {
  const data = replaced.get(e.name);
  if (!data) return { name: e.name, entry: e, align: 4 };
  const stored = e.method === 0;
  return { name: e.name, data, compress: !stored, ...(stored ? { align: 4 } : {}) };
}));
const signed = await signApk(unsigned, new Uint8Array(readFileSync("test-key.pk8")), new Uint8Array(readFileSync("test-cert.der")));
console.log(`pure TypeScript repack + sign: ${(performance.now() - t0).toFixed(0)} ms, ${signed.length} bytes`);
writeFileSync("ts-signed.apk", signed);
