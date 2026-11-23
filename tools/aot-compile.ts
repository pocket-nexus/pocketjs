import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import ts from "typescript";
import { analyzeAot, buildAot, type AotBuildResult } from "../microts/compiler/aot-build.ts";
import { getSolidAotDependencyVersions } from "../microts/compiler/aot-solid-frontend.ts";
import { getAotDependencyVersions } from "../microts/compiler/aot-frontend.ts";
import { bakeAtlases } from "../framework/compiler/bake-font.ts";
import { encodeStaticImage, loadRasterImage, readImageManifest } from "../framework/compiler/raster-assets.ts";
import { readFontConfig } from "../framework/compiler/font-config.ts";
import { BuildInputs, depfile } from "../framework/compiler/build-inputs.ts";
import { resolveAppPlan } from "../framework/compiler/app-plan.ts";
import { verifyPlanHash, verifyPlanProfile, type ResolvedBuildPlan } from "../framework/compiler/plan.ts";
import { POCKET_BINDING_GENERATION } from "../contracts/spec/binding-generation.ts";
import { loadHostConfig, profileRegistry } from "./profile-resolver.ts";
import { POCKET_PROFILES } from "../hosts/index.ts";
import { registerApplication } from "../microts/compiler/aot-model-config.ts";
import type { LayerDeclarations } from "../microts/compiler/aot-paint-plan.ts";
import { HOST_WASM, missingHostWasm } from "./wasm.ts";

const ROOT = resolve(import.meta.dir, "..");
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export interface AotCompileOptions {
  plan: ResolvedBuildPlan;
  /** The host config the plan was resolved from: an input of every output.
   *  Without one, the plan's settings are registered for the entry's
   *  directory. */
  configPath?: string;
  projectRoot: string;
  outdir: string;
  dependencyFiles?: readonly string[];
  /** Prebuilt compiler oracle. Generation never builds a native toolchain. */
  wasmPath?: string;
}
export interface AotCompileResult {
  outdir: string;
  includeFile: string;
  dependencyManifest: string;
  files: string[];
  dependencies: readonly string[];
  result: AotBuildResult;
}

function children(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const imports = ts.preProcessFile(source, true, true).importedFiles;
  return imports.flatMap(({ fileName }) => {
    if (!fileName.startsWith(".")) return [];
    const base = resolve(dirname(file), fileName);
    const found = [base, ...[".ts", ".tsx", ".vue", ".d.ts", "/index.ts"].map(ext => base + ext),
      ...(/\.jsx?$/.test(base) ? [base.replace(/\.jsx?$/, ".ts"), base.replace(/\.jsx?$/, ".tsx")] : [])]
      .find(path => existsSync(path) && statSync(path).isFile());
    if (!found) throw new Error(`AOT: cannot resolve ${fileName} imported by ${file}`);
    return [found];
  });
}

/** A native application has one root component; the application entry may be its mount module. */
function componentEntry(entry: string): string {
  const visited = new Set<string>(), roots = new Set<string>();
  const visit = (file: string) => {
    if (visited.has(file)) return;
    visited.add(file);
    if (file.endsWith(".vue")) { roots.add(file); return; }
    const ast = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const defaultExport = ast.statements.some(item => ts.isExportAssignment(item) ||
      ts.isFunctionDeclaration(item) && item.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword));
    if (file.endsWith(".tsx") && defaultExport) { roots.add(file); return; }
    children(file).filter(child => /\.(?:tsx?|vue)$/.test(child)).forEach(visit);
  };
  visit(entry);
  if (roots.size !== 1) throw new Error(`AOT: expected one root component from ${entry}; found ${roots.size}`);
  return [...roots][0]!;
}

function walk(value: unknown, visitor: (value: Record<string, unknown>) => void): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) { value.forEach(item => walk(item, visitor)); return; }
  visitor(value as Record<string, unknown>);
  Object.values(value).forEach(item => walk(item, visitor));
}

/** Rust, font and image generation only. Firmware compilation belongs to the program. */
export async function compileAot(options: AotCompileOptions): Promise<AotCompileResult> {
  const { plan } = options;
  if (!verifyPlanHash(plan) || !verifyPlanProfile(plan)) throw new Error("AOT: invalid plan/profile hash");
  if (plan.target.hostAbi !== POCKET_BINDING_GENERATION) throw new Error(`AOT: unsupported plan binding generation ${plan.target.hostAbi}`);
  if (plan.app.aot !== true) throw new Error("AOT: the application's app.aot must be true");
  const projectRoot = resolve(options.projectRoot), outdir = resolve(options.outdir);
  const inputs = new BuildInputs();
  const settingsFiles = options.configPath ? [resolve(options.configPath)] : [];
  settingsFiles.forEach(path => inputs.add(path));
  options.dependencyFiles?.forEach(path => inputs.optional(path));
  const entry = resolve(projectRoot, plan.app.entry), component = componentEntry(entry);
  // The frontends consult the registered settings (aot-model-config.ts).
  const theme = plan.app.theme, tickHz = plan.profile.tickHz;
  registerApplication({ directory: options.configPath ? dirname(resolve(options.configPath)) : dirname(entry), aot: plan.app.aot,
    model: plan.app.model, recursionLimit: plan.app.recursionLimit, framework: plan.app.framework, entry, theme, tickHz });
  const program = analyzeAot(component, { strict: true, theme, tickHz });
  const visited = new Set<string>();
  const collect = (path: string) => {
    if (visited.has(path)) return;
    visited.add(path); inputs.add(path);
    if (/\.(?:tsx?|vue|js)$/.test(path)) children(path).forEach(collect);
  };
  collect(entry);
  for (const item of [...getSolidAotDependencyVersions(program), ...getAotDependencyVersions(program)]) inputs.add(item.file);
  program.components.forEach(item => collect(item.file));
  program.model?.modules.forEach(item => collect(item.file));
  inputs.optional(resolve(projectRoot, "tsconfig.json"));
  const images = new Set<string>(), codepoints = new Set<number>();
  const collectResources = (node: Record<string, unknown>) => {
    if (node.kind === "element" && typeof node.src === "string") images.add(node.src);
    const strings = node.kind === "literal" && typeof node.value === "string" ? [node.value] :
      node.kind === "element" && node.text ? ((node.text as { parts: unknown[] }).parts.filter(value => typeof value === "string") as string[]) : [];
    for (const string of strings) for (const character of string) codepoints.add(character.codePointAt(0)!);
  };
  walk(program, collectResources);
  walk(program.model, collectResources);
  const fontPath = resolve(dirname(component), "fonts.json");
  inputs.optional(fontPath);
  const fontSources = new Set<string>([...visited, ...settingsFiles, ...(options.dependencyFiles ?? []).map(path => resolve(path))]);
  const fontRead = (path: string) => { inputs.add(path); fontSources.add(resolve(path)); };
  const fontConfig = readFontConfig(fontPath, fontRead);
  fontConfig.codepoints.forEach(point => codepoints.add(point));
  const fonts = await bakeAtlases({ slots: program.styles.usedFontSlots, codepoints, rasterDensity: plan.viewport.rasterDensity,
    fallbackTtfs: fontConfig.fallbackTtfs, onRead: fontRead });
  const wasmPath = resolve(options.wasmPath ?? HOST_WASM);
  if (!existsSync(wasmPath)) throw new Error(`AOT: ${missingHostWasm("the layout oracle", options.wasmPath === undefined ? undefined : { option: "wasmPath", path: wasmPath })}`);
  inputs.add(wasmPath);
  const declarationsPath = resolve(dirname(component), "gba-layers.json");
  const spriteLayers = plan.profile.platform === "gba";
  let declarations: LayerDeclarations = {};
  if (spriteLayers) {
    inputs.optional(declarationsPath);
    if (existsSync(declarationsPath)) declarations = JSON.parse(readFileSync(declarationsPath, "utf8"));
  }
  const result = await buildAot(component, { outDir: outdir, strict: true, format: false, theme, tickHz,
    layoutEnvironment: { viewport: [...plan.viewport.logical], fontAtlases: fonts.map(font => font.bytes),
      wasm: readFileSync(wasmPath), tickRate: tickHz, spriteLayers, declarations } });
  const sources = new Map<string, string[]>();
  const write = (name: string, data: string | Uint8Array, from: string[] = []) => {
    const path = resolve(outdir, name);
    if (isAbsolute(name) || relative(outdir, path).startsWith("..")) throw new Error(`AOT: invalid output ${name}`);
    mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, data); sources.set(name, from);
  };
  for (const font of fonts) write(`font-${font.slot}.bin`, font.bytes, [...fontSources].sort());
  const imageCode: string[] = [], imageInPlaceCode: string[] = [];
  // The guest build's image baking (raster-assets.ts): the @Nx sibling, images.json format and sampling, and the IMG entry's size check.
  const imageManifest = resolve(dirname(component), "images.json");
  const imageMeta = readImageManifest(imageManifest, inputs);
  for (const [index, name] of [...images].sort().entries()) {
    if (!/\.(?:png|svg)$/i.test(name)) throw new Error(`AOT: unsupported image ${JSON.stringify(name)}`);
    const candidates = [resolve(dirname(component), name), resolve(projectRoot, "assets/images", name), resolve(ROOT, "assets/images", name), resolve(ROOT, "assets", name)];
    candidates.forEach(path => inputs.optional(path));
    const source = candidates.find(path => existsSync(path) && statSync(path).isFile());
    if (!source) throw new Error(`AOT: image ${JSON.stringify(name)} not found`);
    const loaded = loadRasterImage(source, plan.viewport.rasterDensity, inputs);
    const file = `images/image-${index}.img`;
    write(file, encodeStaticImage(loaded.image, imageMeta[name]), [...new Set([source, loaded.source]), ...(existsSync(imageManifest) ? [imageManifest] : []),
      ...settingsFiles, ...(options.dependencyFiles ?? []).map(path => resolve(path))]);
    imageCode.push(`{ let id = ui.core_mut().upload_img_entry(include_bytes!(${JSON.stringify(file)})); assert!(id >= 0); ui.register_image(${JSON.stringify(name)}, id); }`);
    imageInPlaceCode.push(`{ let bytes: &'static [u8] = include_bytes!(${JSON.stringify(file)}); let id = ui.core_mut().upload_img_entry_from(alloc::rc::Rc::new(bytes), 0..bytes.len()); assert!(id >= 0); ui.register_image(${JSON.stringify(name)}, id); }`);
  }
  write("include.rs", `#[path = "mod.rs"]\nmod generated;\n/// The compiled package rate, core ticks per virtual second (plan.profile.tickHz).\n#[allow(dead_code)]\npub const TICK_HZ: u32 = ${tickHz};\n#[allow(dead_code)]\nfn load_fonts(${fonts.length ? "ui" : "_"}: &mut microts::Ui) {\n${fonts.map(font => `assert!(ui.core_mut().load_font_atlas(include_bytes!("font-${font.slot}.bin")));`).join("\n")}\n}\n#[allow(dead_code)]\nfn load_images(${imageCode.length ? "ui" : "_"}: &mut microts::Ui) {\n${imageCode.join("\n")}\n}\n` +
    `/// load_fonts without the copy: each atlas reads its coverage cells from the include_bytes! data.\n#[allow(dead_code)]\nfn load_fonts_in_place(${fonts.length ? "ui" : "_"}: &mut microts::Ui) {\n${fonts.map(font => `{ let bytes: &'static [u8] = include_bytes!("font-${font.slot}.bin"); assert!(ui.core_mut().load_font_atlas_shared(alloc::rc::Rc::new(bytes), 0..bytes.len())); }`).join("\n")}\n}\n` +
    `/// load_images without the copy: each texture decodes from the include_bytes! data when a frame first draws it, and set_texture_budget releases it again.\n#[allow(dead_code)]\nfn load_images_in_place(${imageInPlaceCode.length ? "ui" : "_"}: &mut microts::Ui) {\n${imageInPlaceCode.join("\n")}\n}\n`);
  write("layers.json", JSON.stringify({ viewport: plan.viewport.logical, tickRate: tickHz, settleFrames: 40, layers: result.layout.regions.flatMap(region => region.layers) }, null, 2) + "\n");
  await inputs.compiler([resolve(ROOT, "tools/aot-compile.ts")], ROOT);
  const allInputs = inputs.paths();
  const files = [...new Set([...result.files.map(path => relative(outdir, path)), ...sources.keys()])].sort();
  const dependencyManifest = resolve(outdir, "dependencies.json");
  writeFileSync(dependencyManifest, JSON.stringify({ schemaVersion: 1, kind: "aot", planHash: plan.planHash, profileHash: plan.profileHash, hostAbi: POCKET_BINDING_GENERATION, plan,
    entry, component, inputs: allInputs.map(path => ({ path, kind: statSync(path).isDirectory() ? "directory" : "file", ...(statSync(path).isFile() ? { sha256: sha(readFileSync(path)) } : {}) })),
    outputs: files.map(file => ({ file, sha256: sha(readFileSync(resolve(outdir, file))), sources: sources.get(file)?.length ? sources.get(file) : allInputs })),
  }, null, 2) + "\n");
  writeFileSync(resolve(outdir, "dependencies.d"), depfile(dependencyManifest, allInputs));
  return { outdir, includeFile: resolve(outdir, "include.rs"), dependencyManifest, files: [...files, "dependencies.json", "dependencies.d"].map(file => resolve(outdir, file)), dependencies: allInputs, result };
}

/** In-tree firmware scripts use the same application generator as pocket compile. */
export async function compileBuiltinAot(target: "gba" | "ipodnano", outdir: string): Promise<AotCompileResult> {
  const configPath = resolve(ROOT, `apps/${target}-hero/pocket.host.config.ts`);
  const config = await loadHostConfig(configPath);
  const resolved = resolveAppPlan(config.value.app, { target, executionClass: "aot", configDirectory: dirname(configPath), projectRoot: ROOT }, profileRegistry(POCKET_PROFILES[target]));
  if (!resolved.ok) throw new Error(resolved.diagnostics.map(item => `${item.path}: ${item.message}`).join("\n"));
  return compileAot({ plan: resolved.plan, configPath, projectRoot: ROOT, outdir, dependencyFiles: [resolve(ROOT, `hosts/${target}/pocket.host.json`), ...config.dependencies] });
}
