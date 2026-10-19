#!/usr/bin/env bun
/** Experimental MicroTS Hero Rockbox plugin for the iPod nano 2G; no JavaScript VM. */
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { analyzeAot, buildAot } from "../../microts/compiler/aot-build.ts";
import { bakeAtlases } from "../../framework/compiler/bake-font.ts";
import { bakeSvg } from "../../framework/compiler/bake-svg.ts";
import { decodePng } from "../../framework/compiler/pak.ts";

const root = resolve(import.meta.dir, "../..");
export const IPODNANO_TOOLCHAIN = "nightly-2026-07-01";
export const IPODNANO_TARGET = "armv4t-none-eabi";
const VIEWPORT: [number, number] = [176, 132];
const IMAGES = ["logo.png", ...Array.from({ length: 8 }, (_, index) => `spinner-0${index}.svg`)];

const USAGE = `bun hosts/ipodnano/build.ts [--outdir=<directory>] [--rockbox=<rockbox-source>] [--compiler-prefix=<prefix>] [--install=<ipod-volume>]

Without --rockbox the build stops after the host preview and the Rust staticlib.
Requires rustup toolchain install ${IPODNANO_TOOLCHAIN} --component rust-src`;

async function run(command: string[], options: { cwd?: string; env?: Record<string, string | undefined> } = {}) {
  const child = Bun.spawn(command, { cwd: options.cwd ?? root, stdout: "inherit", stderr: "inherit", env: { ...process.env, ...options.env } });
  if (await child.exited !== 0) throw new Error(`${command.join(" ")} failed`);
}

function option(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find(arg => arg.startsWith(prefix))?.slice(prefix.length);
}

function compilerPrefix(): string {
  const chosen = option("compiler-prefix");
  if (chosen) return chosen;
  // Rockbox recommends arm-elf-eabi-gcc 9.5.0; arm-none-eabi-gcc builds plugins too.
  return Bun.which("arm-elf-eabi-gcc") ? "arm-elf-eabi-" : "arm-none-eabi-";
}

/** Solve the layout-baked page and write the generated Rust, fonts and images. */
async function generate(gen: string) {
  const entry = resolve(root, "apps/ipodnano-hero/app.tsx");
  const fonts = await bakeAtlases({ codepoints: [], slots: analyzeAot(entry, { strict: true }).styles.usedFontSlots });
  await run([process.execPath, resolve(root, "tools/wasm.ts")]);
  const wasm = readFileSync(resolve(root, "hosts/web/pocketjs.wasm"));
  const result = await buildAot(entry, { outDir: gen, strict: true, format: false, layoutEnvironment: {
    viewport: VIEWPORT, fontAtlases: fonts.map(font => font.bytes), wasm, tickRate: 30,
  } });
  for (const region of result.layout.regions) console.log(`layout-baked ${region.name}: ${region.nodes} nodes, ${region.formulas} formula leaves, ${region.islands} live islands`);
  for (const font of fonts) writeFileSync(resolve(gen, `font-${font.slot}.bin`), font.bytes);
  const images: string[] = [];
  for (const name of IMAGES) {
    const bytes = readFileSync(resolve(root, "assets/images", name));
    const image = name.endsWith(".svg") ? bakeSvg(bytes.toString()) : decodePng(bytes);
    const path = resolve(gen, `${name}.rgba`);
    writeFileSync(path, image.rgba);
    images.push(`{ let id = ui.core_mut().upload_texture(include_bytes!(${JSON.stringify(path)}), ${image.width}, ${image.height}, microts::pocketjs_core::spec::psm::PSM_8888); assert!(id >= 0); ui.register_image(${JSON.stringify(name)}, id); }`);
  }
  writeFileSync(resolve(gen, "include.rs"), `#[path = ${JSON.stringify(resolve(gen, "mod.rs"))}]\nmod generated;\nfn load_fonts(ui: &mut microts::Ui) {\n${fonts.map(font => `assert!(ui.core_mut().load_font_atlas(include_bytes!(${JSON.stringify(resolve(gen, `font-${font.slot}.bin`))})));`).join("\n")}\n}\nfn load_images(ui: &mut microts::Ui) {\n${images.join("\n")}\n}\n`);
  return { result, fonts };
}

async function main() {
  if (process.argv.includes("--help")) {
    console.log(USAGE);
    return;
  }
  const known = ["--outdir=", "--rockbox=", "--compiler-prefix=", "--install="];
  if (process.argv.slice(2).some(arg => !known.some(prefix => arg.startsWith(prefix)))) throw new Error(`Unknown argument\n${USAGE}`);
  const out = resolve(option("outdir") ?? resolve(root, "dist/ipodnano"));
  const gen = resolve(out, "generated");
  mkdirSync(gen, { recursive: true });
  const { result } = await generate(gen);
  const env = { IPODNANO_GENERATED: gen };

  // The preview runs the same crate on the host with the layout oracle and
  // writes the frames a scripted session produces.
  const previewDir = resolve(out, "preview");
  mkdirSync(previewDir, { recursive: true });
  const previewCommand = ["cargo", "+stable", "run", "--locked", "--release", "--manifest-path", resolve(root, "hosts/ipodnano/preview/Cargo.toml"), "--target-dir", resolve(out, "preview-target"), "--", previewDir];
  await run(previewCommand, { env });

  const libCommand = ["cargo", `+${IPODNANO_TOOLCHAIN}`, "build", "--locked", "--release", "--lib", "--target", IPODNANO_TARGET, "-Z", "build-std=core,alloc", "-Z", "build-std-features=compiler-builtins-mem", "--manifest-path", resolve(root, "hosts/ipodnano/Cargo.toml"), "--target-dir", resolve(out, "target")];
  await run(libCommand, { env });
  const lib = resolve(out, `target/${IPODNANO_TARGET}/release/libpocketjs_ipodnano.a`);

  const rockboxSource = option("rockbox");
  if (!rockboxSource) {
    console.log(`Rust staticlib: ${lib}\nPass --rockbox=<rockbox-source> to link pockethero.rock.`);
    return;
  }
  const source = resolve(rockboxSource);
  if (!existsSync(resolve(source, "tools/configure"))) throw new Error(`${source} is not a Rockbox source tree`);
  // The plugin directory is copied into the source tree, where configure's
  // --plugins selection looks for it.
  cpSync(resolve(root, "hosts/ipodnano/rockbox/pockethero"), resolve(source, "apps/plugins/pockethero"), { recursive: true });
  const rockboxBuild = resolve(out, "rockbox-build");
  mkdirSync(rockboxBuild, { recursive: true });
  const prefix = compilerPrefix();
  const configure = [resolve(source, "tools/configure"), "--target=ipodnano2g", "--type=N", "--plugins=pockethero", `--compiler-prefix=${prefix}`];
  if (!existsSync(resolve(rockboxBuild, "Makefile"))) {
    const child = Bun.spawn(configure, { cwd: rockboxBuild, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
    if (await child.exited !== 0) throw new Error("Rockbox configure failed");
  }
  await run(["make", "rocks"], { cwd: rockboxBuild, env: { POCKETHERO_LIB: lib } });
  const pluginDir = resolve(rockboxBuild, "apps/plugins/pockethero");
  // pockethero.rock is the launcher; pockethero.ovl holds the app and loads
  // at the top of the audio buffer.
  const files = { rock: "pockethero.rock", overlay: "pockethero.ovl" } as const;
  const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  const outputs = Object.fromEntries(Object.entries(files).map(([kind, name]) => {
    const bytes = readFileSync(resolve(pluginDir, name));
    writeFileSync(resolve(out, name), bytes);
    return [kind, { file: name, bytes: bytes.length, sha256: sha(bytes) }];
  }));
  const sections = Bun.spawnSync([`${prefix}size`, "-A", resolve(pluginDir, "pockethero.elf")], { stdout: "pipe" }).stdout.toString();
  const rockboxVersion = Bun.spawnSync(["git", "-C", source, "rev-parse", "--short=10", "HEAD"], { stdout: "pipe" }).stdout.toString().trim();
  writeFileSync(resolve(out, "build.json"), JSON.stringify({
    target: IPODNANO_TARGET, toolchain: IPODNANO_TOOLCHAIN, rockbox: rockboxVersion, compilerPrefix: prefix,
    previewCommand, libCommand, configure, app: "apps/ipodnano-hero", nominalTickHz: 30,
    viewport: VIEWPORT, fontSlots: result.program.styles.usedFontSlots, layout: result.layout.regions, outputs,
  }, null, 2) + "\n");
  for (const line of sections.split("\n").filter(line => /^\.(text|rodata|data|bss)\b/.test(line))) console.log(`pockethero.ovl ${line.trim().split(/\s+/).slice(0, 2).join(" ")} bytes`);
  for (const output of Object.values(outputs)) console.log(`${output.file}: ${output.bytes} bytes (Rockbox ${rockboxVersion})`);
  const install = option("install");
  if (install) {
    const info = resolve(install, ".rockbox/rockbox-info.txt");
    if (!existsSync(info)) throw new Error(`${install} has no .rockbox/rockbox-info.txt`);
    // Rockbox rejects plugins built for another plugin API version.
    if (!readFileSync(info, "utf8").includes(`Version: ${rockboxVersion}`)) throw new Error(`${install} runs a different Rockbox build than ${rockboxVersion}; plugins must match the firmware`);
    for (const name of Object.values(files)) copyFileSync(resolve(out, name), resolve(install, ".rockbox/rocks/apps", name));
    console.log(`installed ${Object.values(files).join(", ")} in ${resolve(install, ".rockbox/rocks/apps")}`);
  }
}
if (import.meta.main) await main();
