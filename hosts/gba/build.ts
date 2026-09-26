#!/usr/bin/env bun
/** Experimental bare-metal MicroTS Hero ROM; no JavaScript VM or OS. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { buildAot } from "../../microts/compiler/aot-build.ts";
import { bakeAtlases } from "../../framework/compiler/bake-font.ts";
import { bakeSvg } from "../../framework/compiler/bake-svg.ts";
import { decodePng } from "../../framework/compiler/pak.ts";
import { packHeroAssets } from "./assets.ts";

const root = resolve(import.meta.dir, "../..");
export const GBA_TOOLCHAIN = "nightly-2026-07-01";
// Cartridge boot logo bytes defined by the GBA ROM header format.
const logo = "24ffae51699aa2213d84820a84e409ad11248b98c0817f21a352be199309ce2010464a4af82731ec58c7e83382e3cebf85f4df94ce4b09c194568ac01372a7fc9f844d73a3ca9a615897a327fc039876231dc7610304ae56bf38840040a70efdff52fe036f9530f197fbc08560d68025a963be03014e38e2f9a234ffbb3e0344780090cb88113a9465c07c6387f03caf d625e48b380aac7221d4f807".replaceAll(" ", "");

/** Extract ELF32 load segments by physical address, including RAM initializers. */
export function gbaRom(elf: Uint8Array): Uint8Array {
  if (elf.length < 52) throw new Error("Truncated ELF32 header");
  const view = new DataView(elf.buffer, elf.byteOffset, elf.byteLength);
  if (view.getUint32(0, false) !== 0x7f454c46 || elf[4] !== 1 || elf[5] !== 1 || view.getUint16(18, true) !== 40) throw new Error("Expected ARM little-endian ELF32");
  const offset = view.getUint32(28, true), size = view.getUint16(42, true), count = view.getUint16(44, true);
  if (!count || size < 32 || offset + size * count > elf.length) throw new Error("Invalid ELF32 program headers");
  const segments: { offset: number; address: number; size: number }[] = [];
  let end = 192;
  for (let i = 0; i < count; i++) {
    const p = offset + i * size;
    if (view.getUint32(p, true) !== 1) continue;
    const address = view.getUint32(p + 12, true), length = view.getUint32(p + 16, true), source = view.getUint32(p + 4, true);
    if (!length) continue;
    if (address < 0x08000000 || address + length > 0x0a000000 || source + length > elf.length) throw new Error("ELF load segment is outside GBA ROM");
    segments.push({ offset: source, address: address - 0x08000000, size: length });
    end = Math.max(end, address - 0x08000000 + length);
  }
  if (!segments.some(segment => segment.address === 0 && segment.size >= 192)) throw new Error("Missing GBA startup/header segment");
  const rom = new Uint8Array((end + 3) & ~3).fill(0xff);
  for (const segment of segments) rom.set(elf.subarray(segment.offset, segment.offset + segment.size), segment.address);
  rom.set(Buffer.from(logo, "hex"), 4);
  rom.fill(0, 0xa0, 0xc0);
  rom.set(new TextEncoder().encode("MICROTS HERO"), 0xa0);
  rom.set(new TextEncoder().encode("PKHE01"), 0xac);
  rom[0xb2] = 0x96;
  let checksum = 0x19;
  for (let i = 0xa0; i <= 0xbc; i++) checksum += rom[i]!;
  rom[0xbd] = -checksum & 0xff;
  return rom;
}

async function main() {
  if (process.argv.includes("--help")) {
    console.log("bun hosts/gba/build.ts [--outdir=<directory>]\nRequires rustup toolchain install nightly-2026-07-01 --component rust-src");
    return;
  }
  const options = process.argv.slice(2);
  if (options.some(arg => !arg.startsWith("--outdir="))) throw new Error("Unknown argument; use --help");
  const out = resolve(options.find(arg => arg.startsWith("--outdir="))?.slice(9) ?? resolve(root, "dist/gba"));
  const gen = resolve(out, "generated");
  mkdirSync(out, { recursive: true });
  const result = await buildAot(resolve(root, "apps/gba-hero/app.tsx"), { outDir: gen, strict: true, format: false });
  const fonts = await bakeAtlases({ codepoints: [], slots: result.program.styles.usedFontSlots });
  for (const font of fonts) writeFileSync(resolve(gen, `font-${font.slot}.bin`), font.bytes);
  const images: string[] = [];
  for (const name of ["logo.png", ...Array.from({ length: 8 }, (_, index) => `spinner-0${index}.svg`)]) {
    const bytes = readFileSync(resolve(root, "assets/images", name));
    const image = name.endsWith(".svg") ? bakeSvg(bytes.toString()) : decodePng(bytes);
    const path = resolve(gen, `${name}.rgba`);
    writeFileSync(path, image.rgba);
    images.push(`{ let id = ui.core_mut().upload_texture(include_bytes!(${JSON.stringify(path)}), ${image.width}, ${image.height}, microts::pocketjs_core::spec::psm::PSM_8888); assert!(id >= 0); ui.register_image(${JSON.stringify(name)}, id); }`);
  }
  writeFileSync(resolve(gen, "include.rs"), `#[path = ${JSON.stringify(resolve(gen, "mod.rs"))}]\nmod generated;\n#[allow(dead_code)]\nfn load_fonts(ui: &mut microts::Ui) {\n${fonts.map(font => `assert!(ui.core_mut().load_font_atlas(include_bytes!(${JSON.stringify(resolve(gen, `font-${font.slot}.bin`))})));`).join("\n")}\n}\n#[allow(dead_code)]\nfn load_images(ui: &mut microts::Ui) {\n${images.join("\n")}\n}\n`);
  const bakeDirectory = resolve(out, "baked");
  mkdirSync(bakeDirectory, { recursive: true });
  const bakeCommand = ["cargo", "+stable", "run", "--locked", "--release", "--manifest-path", resolve(root, "hosts/gba/bake/Cargo.toml"), "--target-dir", resolve(out, "bake-target"), "--", bakeDirectory];
  const baker = Bun.spawn(bakeCommand, { cwd: root, stdout: "inherit", stderr: "inherit", env: { ...process.env, GBA_GENERATED: gen } });
  if (await baker.exited !== 0) throw new Error("GBA native scene bake failed");
  const assets = packHeroAssets(bakeDirectory, gen);
  const command = ["cargo", `+${GBA_TOOLCHAIN}`, "build", "--locked", "--release", "--target", "thumbv4t-none-eabi", "-Z", "build-std=core,alloc", "--manifest-path", resolve(root, "hosts/gba/Cargo.toml"), "--target-dir", resolve(out, "target")];
  const rustflags = ["-C", `link-arg=-T${resolve(root, "hosts/gba/gba.ld")}`, "-C", "link-arg=--gc-sections"];
  const child = Bun.spawn(command, { cwd: root, stdout: "inherit", stderr: "inherit", env: { ...process.env, GBA_GENERATED: gen, CARGO_ENCODED_RUSTFLAGS: rustflags.join("\x1f") } });
  if (await child.exited !== 0) throw new Error("GBA Rust build failed");
  const elf = readFileSync(resolve(out, "target/thumbv4t-none-eabi/release/gba-hero"));
  const rom = gbaRom(elf);
  writeFileSync(resolve(out, "gba-hero.elf"), elf);
  writeFileSync(resolve(out, "gba-hero.gba"), rom);
  const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  writeFileSync(resolve(out, "build.json"), JSON.stringify({
    target: "thumbv4t-none-eabi", toolchain: GBA_TOOLCHAIN, command, rustflags, bakeCommand,
    romBytes: rom.length, romSha256: hash(rom), elfSha256: hash(elf),
    app: "apps/gba-hero", nominalTickHz: 30, vblanksPerPresentation: 2,
    fontSlots: result.program.styles.usedFontSlots,
    renderer: "mode0-bg-obj", assets,
  }, null, 2) + "\n");
  console.log(`GBA Hero: ${rom.length} ROM bytes -> ${resolve(out, "gba-hero.gba")}`);
}
if (import.meta.main) await main();
