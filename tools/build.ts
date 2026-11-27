import { registerAppSettings, registerSourceApplication, resolveSourceEntry, sourceApplication, sourceOutputName } from "./source-app.ts";
import { resolveSolidAotModel } from "../microts/compiler/aot-solid-browser.ts";
import { modelConfiguration, registerApplication, setApplicationAnimation } from "../microts/compiler/aot-model-config.ts";
import { loadHostConfig } from "./profile-resolver.ts";
import { BuildInputs } from "../framework/compiler/build-inputs.ts";
import { buildWorker } from "./build-worker.ts";
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
//         minify off unless POCKETJS_MINIFY=1) -> dist/<app>.js.
//
// Flags:
//   --plan=<plan.json>           compile the application a ResolvedBuildPlan
//                                names (`pocket compile` writes one); entries
//                                are relative to --project-root
//   --config=<pocket.host.config.ts>  the host config the plan was resolved
//                                from; its model settings must equal the plan's
//   --framework=solid|vue-vapor|octane  select the framework for this build
//   --extra-chars=<string>       force extra codepoints into every atlas
//   --density=<integer>          low-level target sampling density (default 1)
//   --font-regular=<path>        the regular font source of an entry without an
//                                app config; a plan or the entry's config names
//                                its faces with app.fonts, and passing both is
//                                an error
//   --font-bold=<path>           the bold font source, under the same rule
//   --font-mono=<path>           the mono font source (font-mono slots), under
//                                the same rule
//   --outdir=<path>              write <app>.js/.pak here instead of dist/
//                                (external repos build their apps against a
//                                vendored PocketJS and keep outputs local)
//   --layer=<module>             a system layer (@pocketjs/framework/system-layers):
//                                pass 1 walks the module and pass 2 imports it
//                                ahead of the app's entry; repeatable
//   --strict-classes             fail when a `class` attribute holds a literal
//                                that does not compile; without it the build
//                                prints the same finding as a warning

import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { resolve as resolvePath, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PSM } from "../contracts/spec/spec.ts";
import {
  FRAMEWORKS,
  frameworkVariantPath,
  jsxPlugin,
  packagePath,
  parseFramework,
  transformFile,
  type LiteralSite,
  type PocketFramework,
} from "../framework/compiler/jsx-plugin.ts";
import { animationThemeSchema } from "../contracts/spec/animation-theme.ts";
import { validateSchema, type ContractDiagnostic } from "../contracts/spec/json-schema.ts";
import { verifyPlanHash, verifyPlanProfile, type ResolvedBuildPlan } from "../framework/compiler/plan.ts";
import { BUTTON_GLYPHS, PORTABLE_MODALITY } from "../contracts/spec/modality.ts";
import { POCKET_BINDING_GENERATION } from "../contracts/spec/binding-generation.ts";
import { profileResponseBytes } from "../contracts/spec/profile.ts";
import { resolveWorkerChannels } from "../contracts/spec/worker.ts";
import { registerAnimationTheme, setAnimationTickRate } from "../framework/compiler/animation.ts";
import { compileClasses, generateStylesModule, registerClassTarget, registerFontSlots, suspectClassLiteral, unknownUtilities } from "../framework/compiler/tailwind.ts";
import { bakeAtlases } from "../framework/compiler/bake-font.ts";
import { appFontFaces, readFontConfig } from "../framework/compiler/font-config.ts";
import {
  densityVariantPath,
  encodeStaticImage,
  loadRasterImage,
  readImageManifest,
} from "../framework/compiler/raster-assets.ts";
import {
  PAK_DTYPE,
  KEY_STYLES,
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
let monoFontPath: string | undefined;
let appArg = "";
let frameworkFlag: string | undefined;
let planPath: string | undefined;
let configPath: string | undefined;
let densityFlag: number | undefined;
let hzFlag: number | undefined;
let projectRoot = process.cwd();
let inputsFile: string | undefined;
let strictClasses = false;
const layerFlags: string[] = [];
const buildInputs = new BuildInputs();
for (const a of args) {
  if (a.startsWith("--extra-chars=")) extraChars = a.slice("--extra-chars=".length);
  else if (a.startsWith("--font-regular=")) regularFontPath = resolvePath(a.slice("--font-regular=".length));
  else if (a.startsWith("--font-bold=")) boldFontPath = resolvePath(a.slice("--font-bold=".length));
  else if (a.startsWith("--font-mono=")) monoFontPath = resolvePath(a.slice("--font-mono=".length));
  else if (a.startsWith("--framework=")) frameworkFlag = a.slice("--framework=".length);
  else if (a.startsWith("--config=")) configPath = resolvePath(a.slice("--config=".length));
  else if (a === "--config" || a === "--no-config") throw new Error("PocketJS build: --config=<pocket.host.config.ts> names the config a plan was resolved from");
  else if (a.startsWith("--plan=")) planPath = resolvePath(a.slice("--plan=".length));
  else if (a.startsWith("--project-root=")) projectRoot = resolvePath(a.slice("--project-root=".length));
  else if (a.startsWith("--outdir=")) DIST = resolvePath(a.slice("--outdir=".length)) + "/";
  else if (a.startsWith("--density=")) densityFlag = Number(a.slice("--density=".length));
  else if (a.startsWith("--hz=")) hzFlag = Number(a.slice("--hz=".length));
  else if (a.startsWith("--inputs-file=")) inputsFile = resolvePath(a.slice("--inputs-file=".length));
  else if (a === "--strict-classes") strictClasses = true;
  else if (a.startsWith("--layer=")) layerFlags.push(resolvePath(a.slice("--layer=".length)));
  else if (!a.startsWith("-")) appArg = a;
}

let buildPlan: ResolvedBuildPlan | undefined;
if (planPath) {
  buildPlan = await Bun.file(planPath).json() as ResolvedBuildPlan;
  if (!verifyPlanHash(buildPlan) || !verifyPlanProfile(buildPlan)) {
    throw new Error(`PocketJS build: invalid ResolvedBuildPlan checksum in ${planPath}`);
  }
  if (buildPlan.target.hostAbi !== POCKET_BINDING_GENERATION) {
    throw new Error(`PocketJS build: binding generation ${buildPlan.target.hostAbi} is unsupported; rebuild plan for ${POCKET_BINDING_GENERATION}`);
  }
  if (frameworkFlag) {
    throw new Error("PocketJS build: --framework cannot override a ResolvedBuildPlan");
  }
  appArg = resolvePath(projectRoot, buildPlan.app.entry);
  // Model lowering consults the registered application settings before
  // transform caching. With --config the application is registered from its
  // host config, and a frozen plan must match it; without one, the plan's
  // settings are the application's.
  if (configPath) {
    const loaded = await loadHostConfig(configPath);
    if (!loaded.value.app) throw new Error(`PocketJS build: ${configPath} has no app section`);
    loaded.dependencies.forEach(path => buildInputs.add(path));
    registerAppSettings(dirname(configPath), loaded.value.app);
  } else {
    registerApplication({ directory: dirname(appArg), aot: buildPlan.app.aot, model: buildPlan.app.model,
      recursionLimit: buildPlan.app.recursionLimit, framework: buildPlan.app.framework, entry: appArg });
  }
  const model = modelConfiguration(appArg);
  if ((model.aot === true) !== (buildPlan.app.aot === true)
    || model.mode !== (buildPlan.app.model ?? "rust")
    || model.recursionLimit !== (buildPlan.app.recursionLimit ?? 256)
    || model.mode === "compiled" && model.framework !== buildPlan.app.framework) {
    throw new Error("PocketJS build: model settings differ from the ResolvedBuildPlan; resolve a new plan before building");
  }
} else if (configPath) {
  throw new Error("PocketJS build: --config names the host config a --plan was resolved from; a build without a plan reads the config nearest its entry");
}

if (!appArg) {
  console.error("usage: bun tools/build.ts <app.tsx | app name> [--plan=<resolved-plan.json> [--config=<pocket.host.config.ts>]] [--framework=solid|vue-vapor|octane] [--extra-chars=...] [--density=N] [--hz=N]");
  process.exit(1);
}

const requestedEntry = resolveSourceEntry(appArg, ROOT);
buildInputs.optional(join(projectRoot, "tsconfig.json"));
// The public compiler passes a frozen plan. Low-level source builds read the
// host config nearest the entry for its framework, theme and worker, and
// register its model settings.
const source = buildPlan ? undefined : await sourceApplication(requestedEntry);
source?.dependencies.forEach(path => buildInputs.add(path));
if (source) registerAppSettings(source.directory, source.app);
// A plan's worker entry is relative to the project root; a config's to the config.
const appProjectRoot = source?.directory ?? projectRoot;
const appContent = buildPlan ? buildPlan.app : { framework: source?.app.framework, theme: source?.app.theme };
/** The worker domain: the frozen plan's, or the source config's with
 *  "host" channel sizes at the floor every host holds. */
const workerDeclaration = buildPlan
  ? buildPlan.domains?.worker
  : source?.app.worker && resolveWorkerChannels(source.app.worker);
if (appContent.theme !== undefined) {
  const diagnostics: ContractDiagnostic[] = [];
  validateSchema(appContent.theme, animationThemeSchema, "/app/theme", diagnostics);
  if (diagnostics.length) throw new Error(diagnostics.map(item => `${item.path}: ${item.message}`).join("; "));
}
const framework: PocketFramework = frameworkFlag
  ? parseFramework(frameworkFlag, "--framework")
  : parseFramework(appContent.framework, buildPlan ? "ResolvedBuildPlan" : "app.framework");
const frameworkConfig = FRAMEWORKS[framework];
const entry = frameworkVariantPath(requestedEntry, framework);
const appName = buildPlan?.app.output ?? sourceOutputName(requestedEntry, ROOT);
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

// Font faces: a resolved plan or the entry's app config owns them
// (app.fonts); --font-* serve an entry without an app config.
if ((buildPlan || source) && (regularFontPath ?? boldFontPath ?? monoFontPath) !== undefined) {
  throw new Error(buildPlan
    ? "PocketJS build: --font-regular, --font-bold and --font-mono cannot override a ResolvedBuildPlan; name the faces with app.fonts"
    : `PocketJS build: ${source!.configPath} owns the application's faces; name them with app.fonts instead of --font-regular, --font-bold or --font-mono`);
}
const fontFaces = buildPlan || source
  ? appFontFaces(buildPlan ? buildPlan.app.fonts : source!.app.fonts, buildPlan ? projectRoot : source!.directory, path => buildInputs.add(path))
  : { regularTtf: regularFontPath, boldTtf: boldFontPath, monoTtf: monoFontPath };

// Tick rate: the realm's virtual-time step, baked into the bundle because
// every ms-to-frame conversion in the framework resolves against it. An
// software profile owns the rate; low-level builds may still pass --hz.
if (hzFlag !== undefined && (!Number.isInteger(hzFlag) || hzFlag < 1 || hzFlag > 240)) {
  throw new Error("PocketJS build: --hz wants an integer from 1 through 240");
}
if (buildPlan && hzFlag !== undefined && hzFlag !== buildPlan.profile.tickHz) {
  throw new Error("PocketJS build: --hz cannot override the resolved software profile");
}
const tickHz = buildPlan?.profile.tickHz ?? hzFlag ?? 60;
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
  if (!spec.startsWith("./") && !spec.startsWith("../") && !spec.startsWith("/")) return resolveSourcePackage(fromFile, spec);
  const model = framework === "solid" ? resolveSolidAotModel(fromFile, spec, entry) : undefined;
  if (model) return model.endsWith(".d.ts") ? null : model;
  let resolved: string;
  try {
    resolved = Bun.resolveSync(spec, dirname(fromFile));
  } catch {
    return null;
  }
  return (/\.tsx?$/.test(resolved) || resolved.endsWith(".vue")) && !resolved.endsWith(".d.ts") ? frameworkVariantPath(resolved, framework) : null;
}

/** A bare specifier that resolves to TypeScript source outside `node_modules`:
 *  a package linked from its source tree, such as a product's guest modules.
 *  Pass 1 walks it like a relative import, so its class strings and glyphs are
 *  compiled. A package installed under `node_modules` ships built JavaScript
 *  and stays external to pass 1. */
function resolveSourcePackage(fromFile: string, spec: string): string | null {
  let resolved: string;
  try {
    resolved = Bun.resolveSync(spec, dirname(fromFile));
  } catch {
    return null;
  }
  if (!/\.tsx?$/.test(resolved) || resolved.endsWith(".d.ts")) return null;
  // A linked package resolves through `node_modules`; its real path says
  // where the source lives.
  const real = realpathSync(resolved);
  if (real.replace(/\\/g, "/").split("/").includes("node_modules")) return null;
  return frameworkVariantPath(real, framework);
}

const classStrings: string[] = [];
const literalSites: Array<{ file: string; site: LiteralSite }> = [];
const seenClass = new Set<string>();
const codepoints = new Set<number>();
const visited = new Set<string>();

async function walk(file: string): Promise<void> {
  if (visited.has(file)) return;
  visited.add(file);
  // Sources another application owns compile with its model settings.
  const owner = await registerSourceApplication(file);
  owner?.dependencies.forEach(path => buildInputs.add(path));
  // Never scan the compiled-styles module: its literals ARE the compiled
  // class names, and collecting them again would feed the compiler its own
  // output [R]. Other generated modules (an asset registry, for example) are
  // ordinary app data whose literals — asset paths, title glyphs — pass 1
  // must see like any hand-written module's.
  if (file.replace(/\\/g, "/").endsWith("/styles.generated.ts")) return;
  const src = await Bun.file(file).text();
  buildInputs.add(file);
  // Throws with a code frame on lint errors.
  const res = await transformFile(file, src, framework, { features: buildPlan?.features, entry });
  for (const s of res.classStrings) {
    if (!seenClass.has(s)) {
      seenClass.add(s);
      classStrings.push(s);
    }
  }
  for (const cp of res.textCodepoints) codepoints.add(cp);
  // The framework's own modules are not the app author's to fix.
  if (!file.startsWith(ROOT + "/framework/")) for (const site of res.literalSites) literalSites.push({ file, site });
  for (const spec of importSpecifiers(src)) {
    const dep = resolveImport(file, spec);
    if (dep) await walk(dep);
  }
}

// System layers a product passes with --layer (framework/src/system-layers.ts).
// Each is walked here so pass 1 compiles its classes and glyphs, and imported
// ahead of the app's entry in pass 2 so it registers before the app mounts.
const systemLayers: string[] = [];
for (const layer of layerFlags) {
  if (!existsSync(layer)) throw new Error(`PocketJS build: --layer names ${layer}, which is not a file`);
  systemLayers.push(layer);
}
// Pass 1 admits an AOT application's Solid views, which compiles their class
// literals; they bake with the theme and tick rate of this build's style table.
const application = modelConfiguration(entry).directory;
if (application) setApplicationAnimation(application, { theme: appContent.theme, tickHz });
await walk(entry);
for (const layer of systemLayers) await walk(layer);
console.log(`  pass 1: ${visited.size} module(s), ${classStrings.length} candidate literal(s), ${codepoints.size} codepoint(s)`);

// ---------------------------------------------------------------------------
// compile styles + fonts + images
// ---------------------------------------------------------------------------

registerAnimationTheme(appContent.theme);
// Application font slots (app.fonts.slots) bind before the classes that
// select them compile; bakeAtlases reads the same binding.
{
  const fonts = buildPlan ? buildPlan.app.fonts : source?.app.fonts;
  registerFontSlots(fonts?.slots ?? [], Object.keys(fonts?.faces ?? {}));
  // hover: compiles for a target with a real pointer.
  registerClassTarget({ pointer: buildPlan?.features?.["input.pointer"] === true });
}
// Keyframe timelines are frame-baked; they must count frames at the same
// rate the realm ticks (transition-* stays in ms and converts at runtime).
setAnimationTickRate(tickHz);
const styles = compileClasses(classStrings);
if (styles.records.length === 0) {
  console.warn("  tailwind: no class literals compiled — is the app unstyled?");
}
// A literal the compiler left out gives its node no style, and nothing at run
// time says so on a native host. Where the source put it tells two cases
// apart. In a `class` attribute it was meant as a class string, so each
// unsupported token is a finding. Anywhere else (a constant, a function that
// returns the class) it is reported only when it reads as a class string
// with a mistake in it, and it never fails the build.
{
  const shown = (file: string, site: LiteralSite): string => {
    const base = projectRoot.endsWith("/") ? projectRoot : projectRoot + "/";
    return `${file.startsWith(base) ? file.slice(base.length) : file}:${site.line}:${site.column}`;
  };
  const utilities = (unknown: string[]): string =>
    `unknown ${unknown.length === 1 ? "utility" : "utilities"} ${unknown.join(", ")}`;
  const findings: string[] = [];
  const suspects: string[] = [];
  for (const { file, site } of literalSites) {
    if (site.literal in styles.ids) continue;
    if (site.inClass) {
      const unknown = unknownUtilities(site.literal);
      if (unknown.length > 0) findings.push(`${shown(file, site)}: class "${site.literal}" does not compile: ${utilities(unknown)}`);
    } else {
      const unknown = suspectClassLiteral(site.literal);
      if (unknown) suspects.push(`${shown(file, site)}: "${site.literal}" reads as a class string and does not compile: ${utilities(unknown)}`);
    }
  }
  for (const line of suspects) console.warn(`  warning: ${line}`);
  if (strictClasses && findings.length > 0) {
    for (const line of findings) console.error(`error: ${line}`);
    console.error(`PocketJS build: ${findings.length} class literal(s) do not compile. The supported utilities are listed in the styling reference.`);
    process.exit(1);
  }
  for (const line of findings) console.warn(`  warning: ${line}`);
}

const generatedStyles = generateStylesModule(styles);
// Pass 2 receives this build's style table through jsxPlugin. The copy beside
// the bundle is for inspection and for tools that bundle the framework with a
// given table (the site's playground runtimes); nothing is written into the
// framework directory.
const generatedPath = `${DIST}${outName}.styles.ts`;
await Bun.write(generatedPath, generatedStyles);
console.log(
  `  tailwind: ${styles.records.length} style record(s), ${styles.anims.length} baked timeline(s), ` +
    `${Object.keys(styles.ids).length} literal(s) -> ${generatedPath}`,
);

// The font policy covers runtime data independently of source literals.
const fontsManifestPath = join(dirname(entry), "fonts.json");
buildInputs.optional(fontsManifestPath);
const fontConfig = readFontConfig(fontsManifestPath, path => buildInputs.add(path));
const { fallbackTtfs } = fontConfig;
if (fallbackTtfs.length || fontConfig.codepoints.length)
  console.log(`  fonts: ${fallbackTtfs.length} fallback face(s), ${fontConfig.codepoints.length} declared characters`);

// The device's button marks (@pocketjs/framework/modality glyph()): an app
// that names a button in a legend draws the mark the device's shell prints,
// and that string is the modality table's, not a literal pass 1 collected.
const buttonMarks = [...Object.values(BUTTON_GLYPHS[(buildPlan?.modality ?? PORTABLE_MODALITY).glyphs]).join("")]
  .map(ch => ch.codePointAt(0)!);

// A host with text.layout.native draws every run outside a 3D transform with its own text system:
// its build bakes atlases only when the app declares characters (fonts.json) for text under 3D
// transforms, and then only those, ASCII and the button marks; otherwise no atlases at all.
const nativeText = buildPlan?.features?.["text.layout.native"] === true;
const atlases = nativeText && fontConfig.codepoints.length === 0 && !extraChars
  ? []
  : await bakeAtlases({
    codepoints: new Set([...(nativeText ? [] : codepoints), ...fontConfig.codepoints, ...buttonMarks]),
    slots: styles.usedFontSlots,
    extraChars,
    rasterDensity,
    ...fontFaces,
    onRead: path => buildInputs.add(path),
    fallbackTtfs,
  });
if (nativeText && atlases.length === 0) console.log("  fonts: none baked (text.layout.native)");
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
// samples it bilinearly (rotated or scaled art); psm 2
// selects PSM_4444. Absent file or name = PSM_8888, nearest sampling.
const imageMeta = readImageManifest(join(appDir, "images.json"), buildInputs);
const imageNames = classStrings.filter((s) => /^[\w./-]+\.(?:png|svg)$/i.test(s));
for (const name of imageNames) {
  const candidates = [join(appDir, name), join(ROOT, "assets/images/", name), join(ROOT, "assets/", name)];
  candidates.forEach(path => buildInputs.optional(path));
  const found = candidates.find((c) => existsSync(c));
  let img;
  if (found) {
    // Static images and sprite atlases share the same @Nx convention. A
    // sprite's frame grid stays logical because every atlas dimension is
    // scaled by the same integer density.
    const loaded = loadRasterImage(found, rasterDensity, buildInputs);
    img = loaded.image;
    if (/\.svg$/i.test(found)) {
      console.log(
        `  image: ${name} <- ${found} (${img.width}x${img.height}, svg @${rasterDensity}x)`,
      );
    } else if (loaded.base) {
      console.log(
        `  image: ${name} <- ${loaded.source} (${img.width}x${img.height}, @${rasterDensity}x for ${loaded.base.width}x${loaded.base.height})`,
      );
    } else {
      console.log(
        `  image: ${name} <- ${found} (${img.width}x${img.height}` +
          `${rasterDensity > 1 ? `, 1x fallback (no ${densityVariantPath(found, rasterDensity)})` : ""})`,
      );
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
    blobs.push({
      key: keyImage(name),
      dtype: PAK_DTYPE.u8,
      data: encodeStaticImage(img, meta),
    });
    if (meta?.linear) console.log(`  image: ${name} sampled linear (images.json)`);
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

// jsxPlugin owns dependency identity as well as framework aliases. In
// particular, external apps and renderer-solid.ts must share PocketJS's
// browser-mode Solid runtime even when the app has its own node_modules.
let bundleEntry = entry;
if (systemLayers.length > 0) {
  const entries = join(DIST, ".entries");
  mkdirSync(entries, { recursive: true });
  bundleEntry = join(entries, `${outName}.ts`);
  writeFileSync(bundleEntry, [...systemLayers, entry].map((file) => `import ${JSON.stringify(file)};\n`).join(""));
}
const result = await Bun.build({
  entrypoints: [bundleEntry],
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
    __POCKET_HOST_ABI__: String(buildPlan?.target.hostAbi ?? POCKET_BINDING_GENERATION),
    __POCKET_FEATURES__: JSON.stringify(buildPlan?.features ?? {}),
    __POCKET_DOMAIN__: '"ui"',
    __POCKET_WORKER_DECLARATION__: JSON.stringify(workerDeclaration ?? null),
    // The modality and presentation the plan resolved; the runtime module
    // (@pocketjs/framework/modality) falls back to the portable PSP shape
    // when a bundle is built without a plan.
    __POCKET_MODALITY__: JSON.stringify(buildPlan?.modality ?? null),
    __POCKET_PRESENTATION__: JSON.stringify(buildPlan?.presentation.id ?? "default"),
    // The animation class the plan derived (contracts/spec/animation.ts);
    // a bundle built without a plan animates as a composited target.
    __POCKET_ANIMATION__: JSON.stringify(buildPlan?.animation ?? "composited"),
    __POCKET_PIXEL_RATIO__: String(rasterDensity),
    // The largest response body a worker http request may ask for on the
    // target (contracts/spec/profile.ts worker.http).
    __POCKET_HTTP_RESPONSE_BYTES__: String(profileResponseBytes(buildPlan?.profile ?? {})),
    __POCKET_TICK_HZ__: String(tickHz),
    ...(framework === "vue-vapor"
      ? { document: "globalThis.__pocketDocument" }
      : {}),
  },
  minify: process.env.POCKETJS_MINIFY === "1",
  metafile: true,
  sourcemap: "none",
  plugins: [jsxPlugin(framework, {
    entry,
    features: buildPlan?.features,
    generatedStyles,
    alias: buildPlan?.app.alias,
  })],
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  console.error("PocketJS build: pass 2 bundling failed");
  process.exit(1);
}
const bundle = result.outputs.find((o) => o.path.endsWith(".js"));
if (workerDeclaration) {
  const worker = await buildWorker({ declaration: workerDeclaration, projectRoot: appProjectRoot, outdir: DIST, output: outName });
  buildInputs.metafile(worker.metafile);
  console.log(`  worker: ${DIST}${outName}.worker.js`);
}
if (inputsFile) {
  buildInputs.metafile(result.metafile);
  await buildInputs.compiler([join(ROOT, "tools/build.ts"), join(ROOT, "tools/pocket.ts")], ROOT);
  await Bun.write(inputsFile, JSON.stringify(buildInputs.paths(), null, 2) + "\n");
}
const bundleBytes = bundle ? (await bundle.arrayBuffer()).byteLength : 0;
console.log(`  pass 2: ${DIST}${outName}.js (${bundleBytes} bytes)`);
console.log("PocketJS build: done");
