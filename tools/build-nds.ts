#!/usr/bin/env bun
/** Compile the shared Solid Hero through MicroTS and link an NDS homebrew ROM. */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { buildAot } from "../microts/compiler/aot-build.ts";
import type { AotNode, AotProgram } from "../microts/compiler/aot-ir.ts";
import { bakeAtlases } from "../framework/compiler/bake-font.ts";
import { bakeSvg } from "../framework/compiler/bake-svg.ts";
import { readFontConfig } from "../framework/compiler/font-config.ts";
import { decodePng, encodeImageEntry, KEY_STYLES, keyFont, keyImage, pack, PAK_DTYPE, type PakBlob } from "../framework/compiler/pak.ts";

const ROOT = resolve(import.meta.dir, "..");
export const NDS_RUST_TOOLCHAIN = "nightly-2026-07-01";
export const NDS_RUST_TARGET = "armv5te-none-eabi";

export interface NdsBuildOptions {
  app: string;
  outDir: string;
  devkitPro: string;
  rustToolchain: string;
  assetsOnly: boolean;
}

export function parseNdsBuildArguments(args: string[], root = ROOT): NdsBuildOptions {
  const options: NdsBuildOptions = {
    app: "hero-nds", outDir: join(root, "dist/nds"),
    devkitPro: process.env.DEVKITPRO ?? "/opt/devkitpro",
    rustToolchain: NDS_RUST_TOOLCHAIN, assetsOnly: false,
  };
  let appSeen = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--assets-only") options.assetsOnly = true;
    else if (/^--(?:outdir|devkitpro|rust-toolchain)(?:=|$)/.test(arg)) {
      const equal = arg.indexOf("=");
      const key = equal < 0 ? arg : arg.slice(0, equal);
      const value = equal < 0 ? args[++i] : arg.slice(equal + 1);
      if (!value || value.startsWith("--")) throw new Error(`${key} requires a value`);
      if (key === "--outdir") options.outDir = resolve(value);
      else if (key === "--devkitpro") options.devkitPro = resolve(value);
      else options.rustToolchain = value;
    } else if (arg.startsWith("-")) throw new Error(`Unknown NDS option: ${arg}`);
    else if (appSeen) throw new Error(`Unexpected NDS argument: ${arg}`);
    else { options.app = arg; appSeen = true; }
  }
  if (options.app !== "hero-nds") throw new Error("The NDS host currently supports only the hero-nds demo");
  return options;
}

/** Walk every conditional, component slot and loop; images keep their IR names. */
export function ndsImageAssets(program: AotProgram): Map<string, string> {
  const assets = new Map<string, string>();
  function visit(nodes: AotNode[], file: string): void {
    for (const node of nodes) {
      if (node.kind === "element" && node.src) {
        const candidates = [resolve(dirname(file), node.src), join(ROOT, "assets/images", node.src), join(ROOT, "assets", node.src)];
        const path = candidates.find(candidate => existsSync(candidate)) ?? candidates[0]!;
        const previous = assets.get(node.src);
        if (previous && previous !== path && !readFileSync(previous).equals(readFileSync(path))) {
          throw new Error(`NDS image name ${node.src} refers to different files`);
        }
        assets.set(node.src, path);
      }
      if ("children" in node) visit(node.children, file);
      if (node.kind === "if") for (const branch of node.branches) visit(branch.children, file);
      if (node.kind === "component") for (const slot of node.slots) visit(slot.children, file);
      if (node.kind === "slot") visit(node.fallback, file);
    }
  }
  for (const component of program.components) visit(component.nodes, component.file);
  return assets;
}

export async function bakeNdsAssets(program: AotProgram, entry: string): Promise<Uint8Array> {
  const fontConfig = readFontConfig(join(dirname(entry), "fonts.json"));
  const codepoints = new Set(fontConfig.codepoints);
  // Include source literals as well as static view text: model-generated text
  // and labels share the same atlas. ASCII is always included by bakeAtlases.
  for (const component of program.components) {
    for (const char of readFileSync(component.file, "utf8")) codepoints.add(char.codePointAt(0)!);
  }
  const atlases = await bakeAtlases({ codepoints, slots: program.styles.usedFontSlots,
    rasterDensity: 1, fallbackTtfs: fontConfig.fallbackTtfs });
  const blobs: PakBlob[] = [
    { key: KEY_STYLES, dtype: PAK_DTYPE.u8, data: Uint8Array.from(program.styles.bytes) },
    ...atlases.map(atlas => ({ key: keyFont(atlas.slot), dtype: PAK_DTYPE.u8, data: atlas.bytes })),
  ];
  for (const [name, path] of ndsImageAssets(program)) {
    if (!existsSync(path)) throw new Error(`NDS image does not exist: ${path}`);
    const image = /\.svg$/i.test(path) ? bakeSvg(readFileSync(path, "utf8"), 1)
      : /\.png$/i.test(path) ? decodePng(new Uint8Array(readFileSync(path)))
      : undefined;
    if (!image) throw new Error(`NDS image must be PNG or SVG: ${path}`);
    blobs.push({ key: keyImage(name), dtype: PAK_DTYPE.u8, data: encodeImageEntry(image) });
  }
  return pack(blobs);
}

function run(command: string[], cwd: string, env: Record<string, string | undefined>): string {
  console.log(`NDS: ${command.join(" ")}`);
  const result = Bun.spawnSync(command, { cwd, env, stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error(`NDS command failed (${result.exitCode}): ${command[0]}`);
  return command.join(" ");
}

export async function buildNds(options: NdsBuildOptions): Promise<{ rom?: string; generated: string; assets: string }> {
  if (options.app !== "hero-nds") throw new Error("The NDS host currently supports only the hero-nds demo");
  const host = join(ROOT, "hosts/nds");
  // Each output has its own generated include, Cargo cache and C objects so
  // parallel builds into different output directories cannot mix applications.
  const buildKey = createHash("sha256").update(JSON.stringify({ app: resolve(options.app), outDir: options.outDir })).digest("hex").slice(0, 16);
  const scratch = join(ROOT, ".pocket-build/nds", buildKey);
  const generated = join(scratch, "generated");
  const assets = join(scratch, "assets.pak");
  const entry = join(ROOT, "apps", options.app, "app.tsx");
  // Generated Rust stays in the build cache; compiling it does not require rustfmt.
  const result = await buildAot(entry, { strict: true, board: "nds", outDir: generated, format: false });
  if (!result.program.model) throw new Error("NDS requires a compiled MicroTS model (app.model = compiled)");
  writeFileSync(join(generated, "root-name.txt"), result.program.root + "\n");
  writeFileSync(assets, await bakeNdsAssets(result.program, result.entry));
  console.log(`NDS: ${result.program.root}, ${result.program.components.length} components, ${readFileSync(assets).length} asset bytes`);
  if (options.assetsOnly) return { generated, assets };

  const devkitArm = process.env.DEVKITARM ?? join(options.devkitPro, "devkitARM");
  const compiler = join(devkitArm, "bin/arm-none-eabi-gcc");
  const ndstool = join(options.devkitPro, "tools/bin/ndstool");
  for (const path of [compiler, ndstool, join(options.devkitPro, "libnds/include/nds.h")]) {
    if (!existsSync(path)) throw new Error(`NDS SDK file missing: ${path}. Install devkitPro nds-dev and set DEVKITPRO, or pass --devkitpro.`);
  }
  mkdirSync(options.outDir, { recursive: true });
  const rom = join(options.outDir, "hero-nds.nds");
  const env = { ...process.env,
    DEVKITPRO: options.devkitPro, DEVKITARM: devkitArm,
    POCKETJS_NDS_GENERATED_DIR: generated, POCKETJS_NDS_ASSETS: assets,
    CARGO_TARGET_DIR: join(scratch, "cargo"),
    CARGO_ENCODED_RUSTFLAGS: "-C\u001ftarget-cpu=arm946e-s", RUSTFLAGS: "",
    POCKETJS_BUILD_DIR: join(scratch, "native"), POCKETJS_OUT_NDS: rom,
    POCKETJS_CORE_LIB: join(scratch, "cargo", NDS_RUST_TARGET, "release/libpocketjs_nds_core.a"),
  };
  run(["cargo", `+${options.rustToolchain}`, "build", "--release", "--locked", "-Z", "build-std=core,alloc", "--target", NDS_RUST_TARGET], join(host, "core"), env);
  run(["make", "-j", String(Math.min(8, navigator.hardwareConcurrency || 2))], host, env);
  if (!existsSync(rom)) throw new Error("NDS packaging completed without producing a ROM");
  for (const extension of ["elf", "map", "sym"]) {
    copyFileSync(join(scratch, "native", `pocketjs-nds.${extension}`), join(options.outDir, `hero-nds.${extension}`));
  }
  const receiptDir = join(ROOT, ".pocket-build/validation/nds-build", new Date().toISOString().replaceAll(":", "-"));
  mkdirSync(receiptDir, { recursive: true });
  const version = (args: string[]) => Bun.spawnSync(args, { cwd: ROOT, stdout: "pipe", stderr: "pipe" }).stdout.toString().trim();
  writeFileSync(join(receiptDir, "build.json"), JSON.stringify({
    schemaVersion: 1, app: result.entry, rom, generated, assets,
    sha256: createHash("sha256").update(readFileSync(rom)).digest("hex"), bytes: readFileSync(rom).length,
    rustTarget: NDS_RUST_TARGET, rustc: version(["rustc", `+${options.rustToolchain}`, "-Vv"]),
    gcc: version([compiler, "--version"]), devkitPro: options.devkitPro,
  }, null, 2) + "\n");
  console.log(`NDS: ROM ${rom}\nNDS: build identity ${join(receiptDir, "build.json")}`);
  return { rom, generated, assets };
}

if (import.meta.main) {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log("Build the MicroTS Hero demo for Nintendo DS.\nbun tools/build-nds.ts [hero-nds] [--devkitpro path] [--outdir path] [--assets-only] [--rust-toolchain name]");
  } else {
    try { await buildNds(parseNdsBuildArguments(process.argv.slice(2))); }
    catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
  }
}
