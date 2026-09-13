import { readIdfHostExtension } from "../framework/src/manifest/idf-host.ts";
import { BuildInputs } from "../framework/compiler/build-inputs.ts";
// tools/build.ts <app> — the TWO-PASS app build (docs/DESIGN.md "Build pipeline").
//
//   bun tools/build.ts apps/hero/app.tsx    (or just `hero`)
//   bun tools/build.ts hero-main             (mounted demo entry)
//
// pass 1  transform & collect: framework-specific JSX + TS over every
//         .tsx/.ts reachable from the app entry (content-hash cached),
//         collecting candidate class strings + text codepoints from the AST.
// compile tailwind.ts -> styles.bin + an ignored styles.generated.ts mirror;
//         bake-font.ts -> font atlas per used slot; demo images (PNG/SVG or a
//         placeholder); pak.ts packs it all -> dist/<app>.pak.
// pass 2  Bun.build (plugin serves the CACHED pass-1 transforms plus this
//         build's in-memory generated styles, iife, target browser,
//         minify false) -> dist/<app>.js.
//
// Flags:
//   --framework=solid|vue-vapor|octane  select the framework for this build
//   --config=<path>              load a Pocket config file (default: pocket.config.ts)
//   --no-config                  ignore pocket.config.ts
//   --extra-chars=<string>       force extra codepoints into every atlas
//   --density=<integer>          low-level target sampling density (default 1)
//   --font-regular=<path>        override the regular font source
//   --font-bold=<path>           override the bold font source
//   --outdir=<path>              write <app>.js/.pak here instead of dist/
//                                (external repos build their apps against a
//                                vendored PocketJS and keep outputs local)

import { existsSync, statSync } from "node:fs";
import { resolve as resolvePath, join, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { IMG_FLAG_LINEAR, PSM } from "../contracts/spec/spec.ts";
import {
  FRAMEWORKS,
  frameworkVariantPath,
  jsxPlugin,
  packagePath,
  parseFramework,
  transformFile,
  type PocketFramework,
} from "../framework/compiler/jsx-plugin.ts";
import type { PocketConfig } from "../framework/src/config.ts";
import { verifyPlanHash, type ResolvedBuildPlan } from "../framework/src/manifest/plan.ts";
import { registerAnimationTheme, setAnimationTickRate } from "../framework/compiler/animation.ts";
import { compileClasses, generateStylesModule } from "../framework/compiler/tailwind.ts";
import { bakeAtlases } from "../framework/compiler/bake-font.ts";
import { bakeSvg } from "../framework/compiler/bake-svg.ts";
import {
  assertDensityVariantDimensions,
  densityVariantPath,
} from "../framework/compiler/raster-assets.ts";
import {
  PAK_DTYPE,
  KEY_STYLES,
  decodePng,
  encodeImageEntry,
  encodeSpriteEntry,
  keyFont,
  keyImage,
  keySprite,
  pack,
  placeholderImage,
  type PakBlob,
} from "../framework/compiler/pak.ts";

const ROOT = resolvePath(fileURLToPath(new URL("..", import.meta.url))); // pocketjs/
let DIST = join(ROOT, "dist/");

interface PackageJson {
  name?: string;
}

const packageJson = await Bun.file(join(ROOT, "package.json")).json() as PackageJson;
const packageName = packageJson.name ?? "@pocketjs/framework";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
let extraChars = "";
let regularFontPath: string | undefined;
let boldFontPath: string | undefined;
let appArg = "";
let frameworkFlag: string | undefined;
let configPath = join(ROOT, "pocket.config.ts");
let configFlagged = false;
let useConfig = true;
let planPath: string | undefined;
let densityFlag: number | undefined;
let hzFlag: number | undefined;
let projectRoot = process.cwd();
let inputsFile: string | undefined;
const buildInputs = new BuildInputs();
for (const a of args) {
  if (a.startsWith("--extra-chars=")) extraChars = a.slice("--extra-chars=".length);
  else if (a.startsWith("--font-regular=")) regularFontPath = resolvePath(a.slice("--font-regular=".length));
  else if (a.startsWith("--font-bold=")) boldFontPath = resolvePath(a.slice("--font-bold=".length));
  else if (a.startsWith("--framework=")) frameworkFlag = a.slice("--framework=".length);
  else if (a.startsWith("--config=")) { configPath = resolvePath(ROOT, a.slice("--config=".length)); configFlagged = true; }
  else if (a === "--no-config") useConfig = false;
  else if (a.startsWith("--plan=")) planPath = resolvePath(a.slice("--plan=".length));
  else if (a.startsWith("--project-root=")) projectRoot = resolvePath(a.slice("--project-root=".length));
  else if (a.startsWith("--outdir=")) DIST = resolvePath(a.slice("--outdir=".length)) + "/";
  else if (a.startsWith("--density=")) densityFlag = Number(a.slice("--density=".length));
  else if (a.startsWith("--hz=")) hzFlag = Number(a.slice("--hz=".length));
  else if (a.startsWith("--inputs-file=")) inputsFile = resolvePath(a.slice("--inputs-file=".length));
  else if (!a.startsWith("-")) appArg = a;
}

let buildPlan: ResolvedBuildPlan | undefined;
if (planPath) {
  buildPlan = await Bun.file(planPath).json() as ResolvedBuildPlan;
  if (!verifyPlanHash(buildPlan)) {
    throw new Error(`PocketJS build: invalid ResolvedBuildPlan checksum in ${planPath}`);
  }
  if (frameworkFlag) {
    throw new Error("PocketJS build: --framework cannot override a ResolvedBuildPlan");
  }
  appArg = resolvePath(projectRoot, buildPlan.app.entry);
  if (!configFlagged) configPath = resolvePath(projectRoot, "pocket.config.ts");
}

if (!appArg) {
  console.error("usage: bun tools/build.ts <app.tsx | app name> [--plan=<resolved-plan.json>] [--framework=solid|vue-vapor|octane] [--extra-chars=...] [--density=N] [--hz=N]");
  process.exit(1);
}

async function loadConfig(): Promise<PocketConfig> {
  if (!useConfig || !existsSync(configPath)) return {};
  const url = pathToFileURL(configPath);
  url.searchParams.set("mtime", String(statSync(configPath).mtimeMs));
  const mod = await import(url.href) as { default?: PocketConfig; config?: PocketConfig };
  return mod.default ?? mod.config ?? {};
}

function resolveEntry(arg: string): string {
  const normalized = arg.replace(/\\/g, "/").replace(/\.tsx?$/, "");
  const bare = normalized.includes("/") ? normalized.slice(normalized.lastIndexOf("/") + 1) : normalized;
  const isBareName = !arg.includes("/") && !arg.startsWith(".");
  const demoRel = normalized.replace(/^.*?apps\//, "");
  const demoName =
    demoRel.endsWith("/main")
      ? demoRel.slice(0, -"/main".length)
      : demoRel.endsWith("/app")
        ? demoRel.slice(0, -"/app".length)
        : bare.endsWith("-main")
          ? bare.slice(0, -"-main".length)
          : bare;
  const wantsMain = demoRel.endsWith("/main") || bare.endsWith("-main");
  const tries = [
    resolvePath(arg),
    resolvePath(ROOT, arg),
    wantsMain ? resolvePath(ROOT, "apps", demoName, "main.tsx") : "",
    wantsMain ? resolvePath(ROOT, "apps", demoName, "main.ts") : "",
    !wantsMain ? resolvePath(ROOT, "apps", demoName, "app.tsx") : "",
    isBareName && !wantsMain ? resolvePath(ROOT, "apps", demoName, "main.tsx") : "",
    isBareName && !wantsMain ? resolvePath(ROOT, "apps", demoName, "main.ts") : "",
    resolvePath(ROOT, "apps", arg),
    resolvePath(ROOT, "apps", arg + ".tsx"),
    resolvePath(ROOT, "apps", arg + ".ts"),
  ].filter(Boolean);
  for (const t of tries) {
    if (/\.tsx?$/.test(t) && existsSync(t) && statSync(t).isFile()) return t;
  }
  console.error(`PocketJS build: cannot resolve app "${arg}" (tried:\n  ${tries.join("\n  ")})`);
  process.exit(1);
}

const requestedEntry = resolveEntry(appArg);
buildInputs.optional(configPath);
buildInputs.optional(join(dirname(requestedEntry), "pocket.config.ts"));
buildInputs.optional(join(projectRoot, "tsconfig.json"));
// An app directory can carry its own pocket.config.ts (theme/keyframes local
// to the app); it wins over the repo root config unless --config was given.
if (!configFlagged && useConfig) {
  const appConfig = join(dirname(requestedEntry), "pocket.config.ts");
  if (existsSync(appConfig)) configPath = appConfig;
}
const config = await loadConfig();
if (buildPlan && config.framework !== undefined) {
  throw new Error(
    "PocketJS build: framework belongs to pocket.json in manifest builds; remove it from pocket.config.ts",
  );
}
const framework: PocketFramework = frameworkFlag
  ? parseFramework(frameworkFlag, "--framework")
  : buildPlan
    ? parseFramework(buildPlan.app.framework, "ResolvedBuildPlan")
  : parseFramework(config.framework, "pocket.config.ts");
const frameworkConfig = FRAMEWORKS[framework];
const entry = frameworkVariantPath(requestedEntry, framework);
function outputName(file: string): string {
  const normalizedFile = file.replace(/\\/g, "/");
  const normalizedRoot = ROOT.replace(/\\/g, "/");
  const prefix = normalizedRoot.endsWith("/") ? normalizedRoot : normalizedRoot + "/";
  const rel = normalizedFile.startsWith(prefix) ? normalizedFile.slice(prefix.length) : normalizedFile;
  const demo = rel.match(/^apps\/([^/]+)\/(app|main)\.tsx?$/);
  if (demo) return demo[2] === "main" ? `${demo[1]}-main` : demo[1];
  return normalizedFile.split("/").pop()!.replace(/\.tsx?$/, "");
}

const appName = buildPlan?.app.output ?? outputName(requestedEntry);
// A resolved plan names the exact artifact. Low-level demo builds retain the
// framework suffix so multiple framework variants can coexist in dist/.
const outName = buildPlan ? appName : `${appName}${frameworkConfig.outputSuffix}`;
// Raster density: a resolved plan owns it; --density=N serves hosts whose
// viewport is not a fixed platform contract (the desktop widget shell runs
// arbitrary window sizes on 2x displays, which no target profile names).
if (buildPlan && densityFlag !== undefined) {
  throw new Error("PocketJS build: --density cannot override a ResolvedBuildPlan");
}
if (densityFlag !== undefined && (!Number.isInteger(densityFlag) || densityFlag < 1 || densityFlag > 255)) {
  throw new Error("PocketJS build: --density wants an integer from 1 through 255");
}
const rasterDensity = buildPlan?.viewport.rasterDensity ?? densityFlag ?? 1;

// Tick rate: the realm's virtual-time step, baked into the bundle because
// every ms-to-frame conversion in the framework resolves against it. An
// ESP-IDF host profile owns the rate; low-level builds may still pass --hz.
if (hzFlag !== undefined && (!Number.isInteger(hzFlag) || hzFlag < 1 || hzFlag > 240)) {
  throw new Error("PocketJS build: --hz wants an integer from 1 through 240");
}
const idfHost = readIdfHostExtension(buildPlan?.hostExtension);
if (idfHost && hzFlag !== undefined && hzFlag !== idfHost.tickHz) {
  throw new Error("PocketJS build: --hz cannot override an ESP-IDF host profile");
}
const tickHz = idfHost?.tickHz ?? hzFlag ?? 60;
console.log(
  `PocketJS build: ${appName} (${entry}, framework=${framework}` +
    `${tickHz === 60 ? "" : `, ${tickHz}Hz`}` +
    `${buildPlan ? `, target=${buildPlan.target.id}, raster=${rasterDensity}x, plan=${buildPlan.planHash.slice(0, 20)}…` : ""})`,
);

// ---------------------------------------------------------------------------
// pass 1 — transform & collect over the entry's import graph
// ---------------------------------------------------------------------------

/** Extract import/re-export specifiers (our own code style — no dynamic import). */
function importSpecifiers(src: string): string[] {
  const out: string[] = [];
  const re = /(?:^|\n)\s*(?:import|export)\b[^;'"]*?from\s*(["'])([^"']+)\1|(?:^|\n)\s*import\s*(["'])([^"']+)\3/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) out.push(m[2] ?? m[4]);
  return out;
}

/** Resolve a relative import the SAME way pass 2's Bun.build does (extension
 *  remapping like `./card.js` -> card.tsx included), so the two passes agree
 *  on the module graph by construction. */
function resolveImport(fromFile: string, spec: string): string | null {
  if (spec === packageName || spec.startsWith(packageName + "/")) {
    const exported = packagePath(spec, framework);
    return exported && /\.tsx?$/.test(exported) ? exported : null;
  }
  if (!spec.startsWith("./") && !spec.startsWith("../") && !spec.startsWith("/")) return null; // external bare
  let resolved: string;
  try {
    resolved = Bun.resolveSync(spec, dirname(fromFile));
  } catch {
    return null;
  }
  return (/\.tsx?$/.test(resolved) || resolved.endsWith(".vue")) && !resolved.endsWith(".d.ts") ? frameworkVariantPath(resolved, framework) : null;
}

const classStrings: string[] = [];
const seenClass = new Set<string>();
const codepoints = new Set<number>();
const visited = new Set<string>();

async function walk(file: string): Promise<void> {
  if (visited.has(file)) return;
  visited.add(file);
  // Never scan the compiled-styles module: its literals ARE the compiled
  // class names, and collecting them again would feed the compiler its own
  // output [R]. Other generated modules (e.g. the launcher's registry) are
  // ordinary app data whose literals — cover asset paths, title glyphs —
  // pass 1 must see like any hand-written module's.
  if (file.replace(/\\/g, "/").endsWith("/styles.generated.ts")) return;
  const src = await Bun.file(file).text();
  buildInputs.add(file);
  // Throws with a code frame on lint errors.
  const res = await transformFile(file, src, framework, { features: buildPlan?.features });
  for (const s of res.classStrings) {
    if (!seenClass.has(s)) {
      seenClass.add(s);
      classStrings.push(s);
    }
  }
  for (const cp of res.textCodepoints) codepoints.add(cp);
  for (const spec of importSpecifiers(src)) {
    const dep = resolveImport(file, spec);
    if (dep) await walk(dep);
  }
}

await walk(entry);
console.log(`  pass 1: ${visited.size} module(s), ${classStrings.length} candidate literal(s), ${codepoints.size} codepoint(s)`);

// ---------------------------------------------------------------------------
// compile styles + fonts + images
// ---------------------------------------------------------------------------

registerAnimationTheme(config.theme);
// Keyframe timelines are frame-baked; they must count frames at the same
// rate the realm ticks (transition-* stays in ms and converts at runtime).
setAnimationTickRate(tickHz);
const styles = compileClasses(classStrings);
if (styles.records.length === 0) {
  console.warn("  tailwind: no class literals compiled — is the app unstyled?");
}
const generatedPath = join(ROOT, "framework/src/styles.generated.ts");
const generatedStyles = generateStylesModule(styles);
// Keep the ignored mirror for docs/site tooling and human inspection. Pass 2
// receives this build's source directly through jsxPlugin, so concurrent
// targets can never import another build's transient STYLE_IDS table.
await Bun.write(generatedPath, generatedStyles);
console.log(
  `  tailwind: ${styles.records.length} style record(s), ${styles.anims.length} baked timeline(s), ` +
    `${Object.keys(styles.ids).length} literal(s) -> framework/src/styles.generated.ts`,
);

// Optional per-app font sidecar: <appDir>/fonts.json names fallback faces
// tried, in order, for codepoints the slot's own face does not map — an icon
// font (Nerd Font symbols, say) whose glyphs must share the atlas with text.
// Paths are relative to the app directory, so the face travels with the app.
interface FontsManifest {
  fallback?: string[];
}
const fontsManifestPath = join(dirname(entry), "fonts.json");
let fallbackTtfs: string[] = [];
if (existsSync(fontsManifestPath)) {
  buildInputs.add(fontsManifestPath);
  const fontsManifest = JSON.parse(await Bun.file(fontsManifestPath).text()) as FontsManifest;
  fallbackTtfs = (fontsManifest.fallback ?? []).map((p) => resolvePath(dirname(entry), p));
  for (const p of fallbackTtfs) {
    if (!existsSync(p)) throw new Error(`PocketJS build: fonts.json fallback face not found: ${p}`);
  }
  if (fallbackTtfs.length) console.log(`  fonts: ${fallbackTtfs.length} fallback face(s) from fonts.json`);
}

const atlases = await bakeAtlases({
  codepoints,
  slots: styles.usedFontSlots,
  extraChars,
  rasterDensity,
  regularTtf: regularFontPath,
  boldTtf: boldFontPath,
  onRead: path => buildInputs.add(path),
  fallbackTtfs,
});
for (const a of atlases) {
  console.log(
    `  font: slot ${a.slot} (${a.px}px${a.bold ? " bold" : ""}) ${a.glyphCount} glyphs, ` +
      `cell ${a.cellW}x${a.cellH}, coverage ${a.coverageW}x${a.coverageH} @${a.rasterDensity}x, ${a.bytes.length} bytes`,
  );
}

// demo images: any collected literal ending .png/.svg is a candidate asset name
const blobs: PakBlob[] = [
  { key: KEY_STYLES, dtype: PAK_DTYPE.u8, data: styles.bin },
  ...atlases.map((a) => ({ key: keyFont(a.slot), dtype: PAK_DTYPE.u8, data: a.bytes })),
];
const appDir = dirname(entry);
// Optional per-app sprite manifest: images listed here are baked as animated
// sprite-atlas entries (ui:sprite.<name>) instead of static images.
interface SpriteMeta {
  cols: number;
  rows: number;
  frames: number;
  step: number;
  /** spec PSM (default 8888); set 2 (PSM_4444) to halve atlas texmem on PSP. */
  psm?: number;
}
const spriteManifestPath = join(appDir, "sprites.json");
buildInputs.optional(spriteManifestPath);
const spriteMeta: Record<string, SpriteMeta> = existsSync(spriteManifestPath)
  ? (JSON.parse(await Bun.file(spriteManifestPath).text()) as Record<string, SpriteMeta>)
  : {};
// Optional per-app static-image meta: <appDir>/images.json maps an asset
// name to { linear?, psm? }. `linear` bakes IMG_FLAG_LINEAR so the core
// samples it bilinearly (rotated/scaled art — the launcher's covers); psm 2
// selects PSM_4444. Absent file or name = today's defaults, byte-identical.
interface ImageMeta {
  linear?: boolean;
  psm?: number;
}
const imageManifestPath = join(appDir, "images.json");
buildInputs.optional(imageManifestPath);
const imageMeta: Record<string, ImageMeta> = existsSync(imageManifestPath)
  ? (JSON.parse(await Bun.file(imageManifestPath).text()) as Record<string, ImageMeta>)
  : {};
const imageNames = classStrings.filter((s) => /^[\w./-]+\.(?:png|svg)$/i.test(s));
for (const name of imageNames) {
  const candidates = [join(appDir, name), join(ROOT, "assets/images/", name), join(ROOT, "assets/", name)];
  candidates.forEach(path => buildInputs.optional(path));
  const found = candidates.find((c) => existsSync(c));
  let img;
  if (found) {
    if (/\.svg$/i.test(found)) {
      img = bakeSvg(await Bun.file(found).text(), rasterDensity);
      console.log(
        `  image: ${name} <- ${found} (${img.width}x${img.height}, svg @${rasterDensity}x)`,
      );
    } else {
      const base = decodePng(new Uint8Array(await Bun.file(found).arrayBuffer()));
      // Static images and sprite atlases share the same @Nx convention. A
      // sprite's frame grid stays logical because every atlas dimension is
      // scaled by the same integer density.
      const variant = densityVariantPath(found, rasterDensity);
      buildInputs.optional(variant);
      if (variant !== found && existsSync(variant)) {
        const highDensity = decodePng(new Uint8Array(await Bun.file(variant).arrayBuffer()));
        assertDensityVariantDimensions(base, highDensity, rasterDensity, found, variant);
        img = highDensity;
        console.log(
          `  image: ${name} <- ${variant} (${img.width}x${img.height}, @${rasterDensity}x for ${base.width}x${base.height})`,
        );
      } else {
        img = base;
        console.log(
          `  image: ${name} <- ${found} (${img.width}x${img.height}` +
            `${rasterDensity > 1 ? `, 1x fallback (no ${variant})` : ""})`,
        );
      }
    }
  } else {
    img = placeholderImage();
    console.log(`  image: ${name} not found (tried ${candidates.join(", ")}) — baking a 32x32 placeholder`);
  }
  const sp = spriteMeta[name];
  if (sp) {
    blobs.push({
      key: keySprite(name),
      dtype: PAK_DTYPE.u8,
      data: encodeSpriteEntry(
        {
          atlasW: img.width,
          atlasH: img.height,
          frameCount: sp.frames,
          cols: sp.cols,
          frameStep: sp.step,
          rgba: img.rgba,
        },
        sp.psm ?? PSM.PSM_8888,
      ),
    });
    console.log(`  sprite: ${name} (${sp.frames} frames, ${sp.cols} cols, step ${sp.step}, psm ${sp.psm ?? PSM.PSM_8888})`);
  } else {
    const meta = imageMeta[name];
    const flags = meta?.linear ? IMG_FLAG_LINEAR : 0;
    blobs.push({
      key: keyImage(name),
      dtype: PAK_DTYPE.u8,
      data: encodeImageEntry(img, meta?.psm ?? PSM.PSM_8888, flags),
    });
    if (flags) console.log(`  image: ${name} sampled linear (images.json)`);
  }
}

// Optional per-app raw-blob manifest: <appDir>/pak.json lists PREBAKED binary
// entries (e.g. apps/zoomlab's committed TILESET pyramids from gen-assets.ts)
// appended verbatim as u8 blobs. This keeps expensive offline bakes out of the
// build: the build just splices bytes it can't (and needn't) regenerate.
const pakManifestPath = join(appDir, "pak.json");
buildInputs.optional(pakManifestPath);
if (existsSync(pakManifestPath)) {
  const rawEntries = JSON.parse(await Bun.file(pakManifestPath).text()) as Array<{ key: string; file: string }>;
  let rawBytes = 0;
  for (const e of rawEntries) {
    const basePath = join(appDir, e.file);
    if (!existsSync(basePath)) {
      console.error(`  pak.json: ${e.key} -> ${basePath} missing (re-run the app's gen-assets baker?)`);
      process.exit(1);
    }
    const densityPath = densityVariantPath(basePath, rasterDensity);
    buildInputs.add(basePath);
    buildInputs.optional(densityPath);
    const path = densityPath !== basePath && existsSync(densityPath) ? densityPath : basePath;
    const data = new Uint8Array(await Bun.file(path).arrayBuffer());
    blobs.push({ key: e.key, dtype: PAK_DTYPE.u8, data });
    rawBytes += data.length;
    if (path !== basePath) {
      console.log(`  raw: ${e.key} <- ${path} (@${rasterDensity}x)`);
    }
  }
  console.log(`  raw: ${rawEntries.length} prebaked blob(s) from pak.json, ${rawBytes} bytes`);
}

const pak = pack(blobs);
await Bun.write(DIST + outName + ".pak", pak);
console.log(`  pak: ${blobs.length} entries, ${pak.length} bytes -> ${DIST}${outName}.pak`);

// ---------------------------------------------------------------------------
// pass 2 — bundle (served from the pass-1 cache)
// ---------------------------------------------------------------------------

// framework/src/renderer.ts is owned by the js-runtime phase; if it does not exist yet,
// drop in the no-op placeholder so the bundle links (see docs/DESIGN.md).
if (!existsSync(frameworkConfig.rendererPath)) {
  await Bun.write(frameworkConfig.rendererPath, placeholderRenderer());
  console.warn("  pass 2: renderer missing — wrote the no-op placeholder (js-runtime phase owns the real one)");
}

// jsxPlugin owns dependency identity as well as framework aliases. In
// particular, external apps and renderer-solid.ts must share PocketJS's
// browser-mode Solid runtime even when the app has its own node_modules.
const result = await Bun.build({
  entrypoints: [entry],
  root: process.cwd(),
  outdir: DIST,
  naming: `${outName}.js`,
  format: "iife",
  target: "browser",
  // solid-js MUST resolve via its "browser" export condition — the "node"
  // condition serves dist/server.js (SSR build) where reactive updates
  // silently no-op. See tests/renderer.test.ts for the fail-fast guard.
  // Bun's bundler otherwise also enables the "development" condition, which
  // pulls Solid's dev builds and duplicates the root + universal runtimes.
  conditions: ["browser"],
  define: {
    "process.env.NODE_ENV": '"production"',
    __POCKET_TARGET__: JSON.stringify(buildPlan?.target.id ?? ""),
    __POCKET_HOST_ABI__: String(buildPlan?.target.hostAbi ?? 0),
    __POCKET_FEATURES__: JSON.stringify(buildPlan?.features ?? {}),
    // The modality and presentation the plan resolved; the runtime module
    // (@pocketjs/framework/modality) falls back to the portable PSP shape
    // when a bundle is built without a plan.
    __POCKET_MODALITY__: JSON.stringify(buildPlan?.modality ?? null),
    __POCKET_PRESENTATION__: JSON.stringify(buildPlan?.presentation.id ?? "default"),
    __POCKET_PIXEL_RATIO__: String(rasterDensity),
    __POCKET_TICK_HZ__: String(tickHz),
    ...(framework === "vue-vapor"
      ? { document: "globalThis.__pocketDocument" }
      : {}),
  },
  minify: false,
  metafile: true,
  sourcemap: "none",
  plugins: [jsxPlugin(framework, {
    entry,
    features: buildPlan?.features,
    generatedStyles,
  })],
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  console.error("PocketJS build: pass 2 bundling failed");
  process.exit(1);
}
const bundle = result.outputs.find((o) => o.path.endsWith(".js"));
if (inputsFile) {
  buildInputs.metafile(result.metafile);
  await buildInputs.compiler([join(ROOT, "tools/build.ts"), join(ROOT, "tools/pocket.ts"),
    ...(useConfig && existsSync(configPath) ? [configPath] : [])], ROOT);
  await Bun.write(inputsFile, JSON.stringify(buildInputs.paths(), null, 2) + "\n");
}
console.log(`  pass 2: ${DIST}${outName}.js (${bundle ? (await bundle.arrayBuffer()).byteLength : 0} bytes)`);
console.log("PocketJS build: done");

// ---------------------------------------------------------------------------

// Keep in sync with docs/DESIGN.md's universal-renderer surface. This is ONLY a
// link-time stub for builds that run before the js-runtime phase lands.
function placeholderRenderer(): string {
  return `\
// placeholder, impl:js-runtime owns this — written by tools/build.ts so
// pass-2 bundling links before framework/src/renderer.ts is implemented. Every export
// is the no-op shape of Solid's universal-renderer output (createRenderer).
/* eslint-disable @typescript-eslint/no-unused-vars */

type Node = { type?: string; text?: string; children: Node[]; props: Record<string, unknown> };

const node = (type?: string, text?: string): Node => ({ type, text, children: [], props: {} });

export function render(code: () => unknown, _root?: unknown): () => void {
  code();
  return () => {};
}
export function effect<T>(fn: (prev?: T) => T, init?: T): void {
  fn(init);
}
export function memo<T>(fn: () => T): () => T {
  return fn;
}
export function createComponent(Comp: (props: unknown) => unknown, props: unknown): unknown {
  return Comp(props);
}
export function createElement(type: string): Node {
  return node(type);
}
export function createTextNode(value: string): Node {
  return node(undefined, value);
}
export function replaceText(n: Node, value: string): void {
  n.text = value;
}
export function insertNode(parent: Node, n: Node, _anchor?: Node): void {
  parent.children.push(n);
}
export function insert(_parent: Node, _accessor: unknown, _marker?: Node | null): void {}
export function spread(_n: Node, _props: unknown, _skipChildren?: boolean): void {}
export function setProp(n: Node, name: string, value: unknown, _prev?: unknown): unknown {
  n.props[name] = value;
  return value;
}
export function mergeProps(...sources: unknown[]): unknown {
  return Object.assign({}, ...sources);
}
export function use(fn: (el: Node) => void, el: Node): void {
  fn(el);
}
`;
}
