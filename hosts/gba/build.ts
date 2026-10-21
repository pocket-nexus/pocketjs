#!/usr/bin/env bun
/** Experimental bare-metal MicroTS Hero ROM; no JavaScript VM or OS. */
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { RUST_TOOLCHAINS, STABLE_RUST_TOOLCHAIN } from "../../tools/build/toolchains/rust.ts";
import type { RuntimeBuildContext } from "../../framework/src/runtime-config.ts";
import { packLayers } from "./assets.ts";

const root = resolve(import.meta.dir, "../..");
export const GBA_TOOLCHAIN = RUST_TOOLCHAINS.gba;
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

export async function buildGba(args: readonly string[], context?: RuntimeBuildContext) {
  if (args.includes("--help")) {
    console.log(`bun hosts/gba/build.ts --aot-dir=<sources> [--outdir=<directory>]\nRequires rustup toolchain install ${GBA_TOOLCHAIN} --component rust-src`);
    return;
  }
  const options = args;
  if (options.some(arg => !arg.startsWith("--outdir=") && !arg.startsWith("--aot-dir="))) throw new Error("Unknown argument; use --help");
  const out = context?.outdir ?? resolve(options.find(arg => arg.startsWith("--outdir="))?.slice(9) ?? resolve(root, "dist/gba"));
  const gen = resolve(out, "generated");
  mkdirSync(out, { recursive: true });
  const input = context?.aot?.directory ?? options.find(arg => arg.startsWith("--aot-dir="))?.slice(10);
  if (!input) throw new Error("GBA native build requires --aot-dir from pocket compile --aot");
  const dependency = JSON.parse(readFileSync(resolve(input, "dependencies.json"), "utf8"));
  cpSync(resolve(input), gen, { recursive: true });
  const bakeDirectory = resolve(out, "baked");
  mkdirSync(bakeDirectory, { recursive: true });
  const bakeCommand = ["cargo", `+${STABLE_RUST_TOOLCHAIN}`, "run", "--locked", "--release", "--manifest-path", resolve(root, "hosts/gba/bake/Cargo.toml"), "--target-dir", resolve(out, "bake-target"), "--", bakeDirectory];
  const run = async (command: string[], env: Record<string, string>) => {
    if (context) return context.run(command, { cwd: root, env });
    const child = Bun.spawn(command, { cwd: root, stdout: "inherit", stderr: "inherit", env: { ...process.env, ...env } });
    if (await child.exited !== 0 || child.signalCode) throw new Error(`GBA native command failed: ${command.join(" ")}`);
  };
  await run(bakeCommand, { GBA_GENERATED: gen, CARGO_PROFILE_RELEASE_LTO: "true" });
  const assets = packLayers(bakeDirectory, gen);
  for (const layer of assets.layers) console.log(`layer ${layer.name}: ${layer.frames} frames x ${layer.bytesPerFrame} B, crop [${layer.crop.join(", ")}], ${layer.oam} OAM, ${layer.vramBytes} B VRAM`);
  console.log(`OAM ${assets.oamSlots}/128, OBJ VRAM ${assets.vramBytes}/32768 B, frame ROM ${assets.frameBytes} B`);
  const command = ["cargo", `+${GBA_TOOLCHAIN}`, "build", "--locked", "--release", "--target", "thumbv4t-none-eabi", "-Z", "build-std=core,alloc", "--manifest-path", resolve(root, "hosts/gba/Cargo.toml"), "--target-dir", resolve(out, "target")];
  const rustflags = ["-C", `link-arg=-T${resolve(root, "hosts/gba/gba.ld")}`, "-C", "link-arg=--gc-sections"];
  await run(command, { CARGO_PROFILE_RELEASE_LTO: "true", CARGO_PROFILE_RELEASE_PANIC: "abort", GBA_GENERATED: gen, CARGO_ENCODED_RUSTFLAGS: rustflags.join("\x1f") });
  const elf = readFileSync(resolve(out, "target/thumbv4t-none-eabi/release/gba-hero"));
  const rom = gbaRom(elf);
  if (rom.length <= assets.frameBytes) throw new Error("GBA ELF omitted the compiled scene assets; inspect a constant boot failure before accepting this build");
  writeFileSync(resolve(out, "gba-hero.elf"), elf);
  writeFileSync(resolve(out, "gba-hero.gba"), rom);
  const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  writeFileSync(resolve(out, "build.json"), JSON.stringify({
    target: "thumbv4t-none-eabi", toolchain: GBA_TOOLCHAIN, command, rustflags, bakeCommand,
    romBytes: rom.length, romSha256: hash(rom), elfSha256: hash(elf),
    app: dependency.plan.app.id, nominalTickHz: dependency.plan.profile.tickHz, vblanksPerPresentation: 2,
    planHash: dependency.planHash, profileHash: dependency.profileHash,
    renderer: "mode0-bg-obj", assets,
  }, null, 2) + "\n");
  console.log(`GBA Hero: ${rom.length} ROM bytes -> ${resolve(out, "gba-hero.gba")}`);
}
if (import.meta.main) await buildGba(Bun.argv.slice(2));
