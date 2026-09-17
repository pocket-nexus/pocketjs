// vapor/compiler/rom.ts — drive the console toolchains and patch cart headers.
// ROM/firmware targets plus Playdate packages, one generated C file:
//   GBA: arm-none-eabi-gcc, flat ROM, Nintendo-logo/checksum patch
//   GB:  sdcc (SM83) + sdasgb + makebin + rgbfix, ROM-only cart
//   NES: cc65/ca65/ld65, NROM-256 + CHR-ROM font, generated ld65 config
//   ESP32: ESP-IDF, retained build project + app image for offset 0x10000
//   Playdate: SDK CMake, independent Simulator/device .pdx packages
// Toolchain recipes carry over from Pocket Static's target packagers.

import { $ } from "bun";
import { dirname, join } from "node:path";
import { nesFontBytes, VAPOR_TARGETS, type CompiledApp, type VaporTargetName } from "./compile.ts";
import { buildEsp32Firmware } from "./esp32.ts";
import {
  buildPlaydatePackages,
  type PlaydateBuildMode,
} from "./playdate.ts";

const RUNTIME = join(import.meta.dir, "..", "runtime");
const CC65_LIB = process.env.CC65_LIB ?? "/opt/homebrew/share/cc65/lib/none.lib";

// The GBA BIOS validates these 156 bytes at boot on real hardware; every
// homebrew toolchain (gbafix, devkitARM, tonc) ships the same table.
// prettier-ignore
const NINTENDO_LOGO = [
  0x24,0xFF,0xAE,0x51,0x69,0x9A,0xA2,0x21,0x3D,0x84,0x82,0x0A,0x84,0xE4,0x09,0xAD,
  0x11,0x24,0x8B,0x98,0xC0,0x81,0x7F,0x21,0xA3,0x52,0xBE,0x19,0x93,0x09,0xCE,0x20,
  0x10,0x46,0x4A,0x4A,0xF8,0x27,0x31,0xEC,0x58,0xC7,0xE8,0x33,0x82,0xE3,0xCE,0xBF,
  0x85,0xF4,0xDF,0x94,0xCE,0x4B,0x09,0xC1,0x94,0x56,0x8A,0xC0,0x13,0x72,0xA7,0xFC,
  0x9F,0x84,0x4D,0x73,0xA3,0xCA,0x9A,0x61,0x58,0x97,0xA3,0x27,0xFC,0x03,0x98,0x76,
  0x23,0x1D,0xC7,0x61,0x03,0x04,0xAE,0x56,0xBF,0x38,0x84,0x00,0x40,0xA7,0x0E,0xFD,
  0xFF,0x52,0xFE,0x03,0x6F,0x95,0x30,0xF1,0x97,0xFB,0xC0,0x85,0x60,0xD6,0x80,0x25,
  0xA9,0x63,0xBE,0x03,0x01,0x4E,0x38,0xE2,0xF9,0xA2,0x34,0xFF,0xBB,0x3E,0x03,0x44,
  0x78,0x00,0x90,0xCB,0x88,0x11,0x3A,0x94,0x65,0xC0,0x7C,0x63,0x87,0xF0,0x3C,0xAF,
  0xD6,0x25,0xE4,0x8B,0x38,0x0A,0xAC,0x72,0x21,0xD4,0xF8,0x07,
];

function targetDefines(target: VaporTargetName): string[] {
  const t = VAPOR_TARGETS[target];
  return [
    `-DVP_GRID_W=${t.width}`,
    `-DVP_GRID_H=${t.height}`,
    `-DVP_STR_CAP=${t.strCap}`,
    `-DVP_VIEW_CAP=${t.poolCap}`,
  ];
}

export interface BuiltArtifact {
  path: string;
  kind: "rom" | "firmware" | "pdx";
  bytes: number;
  platform?: "simulator" | "device";
}

export interface BuildRomOptions {
  playdateMode?: PlaydateBuildMode;
}

type SingleArtifactTarget = Exclude<VaporTargetName, "playdate">;

async function buildSingleArtifact(
  app: CompiledApp,
  target: SingleArtifactTarget,
  outPath: string,
): Promise<BuiltArtifact> {
  if (target === "gba") {
    const { romBytes } = await buildGbaRom(app, outPath);
    return { path: outPath, kind: "rom", bytes: romBytes };
  }
  if (target === "gb") {
    const { romBytes } = await buildGbRom(app, outPath);
    return { path: outPath, kind: "rom", bytes: romBytes };
  }
  if (target === "nes") {
    const { romBytes } = await buildNesRom(app, outPath);
    return { path: outPath, kind: "rom", bytes: romBytes };
  }
  if (target === "esp32") {
    const { romBytes } = await buildEsp32Firmware(app, outPath);
    return { path: outPath, kind: "firmware", bytes: romBytes };
  }
  target satisfies never;
  throw new Error(`unsupported Pocket Vapor target: ${String(target)}`);
}

/**
 * Build the distributable artifact set for one Vapor target.
 *
 * `buildRom` is the stable public entry-point name. Its result is deliberately
 * plural: console targets and ESP32 return one artifact, while Playdate
 * `both` returns independent Simulator and device packages because a native
 * .pdx cannot contain both executable flavors.
 */
export async function buildRom(
  app: CompiledApp,
  target: VaporTargetName,
  outPath: string,
  options: BuildRomOptions = {},
): Promise<BuiltArtifact[]> {
  if (target === "playdate") {
    const packages = await buildPlaydatePackages(
      app,
      outPath,
      options.playdateMode ?? "simulator",
    );
    return packages.map(({ path, kind, platform, bytes }) => ({
      path,
      kind,
      platform,
      bytes,
    }));
  }
  return [await buildSingleArtifact(app, target, outPath)];
}

// ---- GBA -------------------------------------------------------------------

export async function buildGbaRom(app: CompiledApp, outRom: string): Promise<{ romBytes: number }> {
  const outDir = dirname(outRom);
  const genDir = join(outDir, "gen-gba");
  await $`mkdir -p ${genDir}`.quiet();
  const genC = join(genDir, "gen_app.c");
  await Bun.write(genC, app.c);

  const gbaDir = join(RUNTIME, "gba");
  const elf = join(genDir, "app.elf");
  const defines = targetDefines("gba");
  const rpgDefine = app.rpgEnabled ? ["-DVP_ENABLE_RPG=1"] : [];
  const rpgSource = app.rpgEnabled ? [join(gbaDir, "vapor_rpg.c")] : [];
  await $`arm-none-eabi-gcc -mcpu=arm7tdmi -mthumb-interwork -marm -ffreestanding -nostdlib -Os -fno-strict-aliasing -Wall -Werror=implicit-function-declaration ${defines} ${rpgDefine} -I${RUNTIME} -I${gbaDir} -T${gbaDir}/gba.ld ${gbaDir}/crt0.s ${RUNTIME}/vapor_core.c ${rpgSource} ${gbaDir}/vapor_gba.c ${genC} -lgcc -o ${elf}`;
  await $`arm-none-eabi-objcopy -O binary ${elf} ${outRom}`;

  const rom = new Uint8Array(await Bun.file(outRom).arrayBuffer());
  rom.set(NINTENDO_LOGO, 0x04);
  const title = app.title.toUpperCase().replace(/[^A-Z0-9 ]/g, "").slice(0, 12);
  for (let i = 0; i < 12; i++) rom[0xa0 + i] = i < title.length ? title.charCodeAt(i) : 0;
  rom.set([0x50, 0x56, 0x50, 0x52], 0xac); // game code "PVPR"
  rom[0xb2] = 0x96;
  let sum = 0;
  for (let i = 0xa0; i <= 0xbc; i++) sum = (sum + rom[i]) & 0xff;
  rom[0xbd] = -(0x19 + sum) & 0xff;
  await Bun.write(outRom, rom);
  return { romBytes: rom.length };
}

// ---- GB --------------------------------------------------------------------

export async function buildGbRom(app: CompiledApp, outRom: string): Promise<{ romBytes: number }> {
  const outDir = dirname(outRom);
  const genDir = join(outDir, "gen-gb");
  await $`mkdir -p ${genDir}`.quiet();
  const genC = join(genDir, "gen_app.c");
  await Bun.write(genC, app.c);

  const gbDir = join(RUNTIME, "gb");
  const defines = targetDefines("gb");
  const cflags = ["-msm83", "--opt-code-size", ...defines, `-I${RUNTIME}`, `-I${gbDir}`];

  for (const [src, rel] of [
    [join(RUNTIME, "vapor_core.c"), "vapor_core.rel"],
    [join(gbDir, "vapor_gb.c"), "vapor_gb.rel"],
    [genC, "gen_app.rel"],
  ] as const) {
    await $`sdcc ${cflags} -c ${src} -o ${join(genDir, rel)}`.quiet();
  }
  await $`sdasgb -plosgff -o ${join(genDir, "crt0.rel")} ${join(gbDir, "crt0.s")}`.quiet();

  // _HOME holds sdcc's library routines (long div/mod): pin it into ROM
  // after the header; _CODE starts at 0x0800 above it.
  const ihx = join(genDir, "app.ihx");
  await $`sdcc -msm83 --no-std-crt0 --code-loc 0x0800 --data-loc 0xc0a0 -Wl-b_HOME=0x0150 ${join(genDir, "crt0.rel")} ${join(genDir, "vapor_core.rel")} ${join(genDir, "vapor_gb.rel")} ${join(genDir, "gen_app.rel")} -o ${ihx}`.quiet();
  await $`makebin -Z -yo 2 ${ihx} ${outRom}`.quiet();
  const title = app.title.toUpperCase().replace(/[^A-Z0-9 ]/g, "").slice(0, 11);
  await $`rgbfix -v -p 0xff -t ${title} ${outRom}`.quiet();
  const rom = new Uint8Array(await Bun.file(outRom).arrayBuffer());
  return { romBytes: rom.length };
}

// ---- NES -------------------------------------------------------------------

const NES_CFG = `SYMBOLS {
  __STACKSTART__: type = weak, value = $0700;
  __STACKSIZE__: type = weak, value = $0100;
}
MEMORY {
  HDR: start = $0000, size = $0010, type = ro, file = %O, fill = yes;
  PRG: start = $8000, size = $8000, type = ro, file = %O, fill = yes, fillval = $ff;
  CHR: start = $0000, size = $2000, type = ro, file = %O, fill = yes;
  ZP: start = $0002, size = $00fa, type = rw;
  DEBUGRAM: start = $0200, size = $0358, type = rw;
  # RAM ends at $0720; the cc65 soft stack runs $0720-$07FF (crt0 inits sp
  # to $07FF). The 32-byte extension over the old $0700 boundary is funded
  # by the overlay allocator: the >=42 B of vp_sb/vp_view frames it moved
  # off the deepest stack path exceed the 32 B taken, so stack margin grows.
  RAM: start = $0558, size = $01c8, type = rw;
}
SEGMENTS {
  HEADER: load = HDR, type = ro;
  CODE: load = PRG, type = ro;
  STARTUP: load = PRG, type = ro, optional = yes;
  ONCE: load = PRG, type = ro, optional = yes;
  RODATA: load = PRG, type = ro;
  DATA: load = PRG, run = RAM, type = rw, define = yes;
  VECTORS: load = PRG, type = ro, start = $fffa;
  CHARS: load = CHR, type = ro;
  ZEROPAGE: load = ZP, type = zp;
  DEBUG: load = DEBUGRAM, type = bss, define = yes;
  BSS: load = RAM, type = bss, define = yes;
}
FEATURES {
  CONDES: type = constructor, label = __CONSTRUCTOR_TABLE__, count = __CONSTRUCTOR_COUNT__, segment = RODATA;
  CONDES: type = destructor, label = __DESTRUCTOR_TABLE__, count = __DESTRUCTOR_COUNT__, segment = RODATA;
}
`;

export async function buildNesRom(app: CompiledApp, outRom: string): Promise<{ romBytes: number }> {
  const outDir = dirname(outRom);
  const genDir = join(outDir, "gen-nes");
  await $`mkdir -p ${genDir}`.quiet();
  const genC = join(genDir, "gen_app.c");
  await Bun.write(genC, app.c);
  await Bun.write(join(genDir, "nes.cfg"), NES_CFG);

  // iNES header: NROM (mapper 0), 32K PRG, 8K CHR
  await Bun.write(
    join(genDir, "gen_header.s"),
    [
      "; gen_header.s — GENERATED. iNES: mapper 0 (NROM-256), CHR-ROM.",
      '.segment "HEADER"',
      ".byte $4e, $45, $53, $1a",
      ".byte 2",
      ".byte 1",
      ".byte 0",
      ".byte 0, 0, 0, 0, 0, 0, 0, 0, 0",
      "",
    ].join("\n"),
  );

  // CHR-ROM: tile 0 blank, then 190 glyph tiles (2 styles x 95)
  {
    const lines = ['; gen_chr.s — GENERATED font CHR.', '.segment "CHARS"', `.res 16, $00`];
    const bytes = nesFontBytes();
    for (let at = 0; at < bytes.length; at += 16) {
      lines.push(`.byte ${bytes.slice(at, at + 16).join(",")}`);
    }
    await Bun.write(join(genDir, "gen_chr.s"), lines.join("\n") + "\n");
  }

  const nesDir = join(RUNTIME, "nes");
  const defines = targetDefines("nes");
  const cc = ["-t", "none", "-O", ...defines, `-I${RUNTIME}`, `-I${nesDir}`];

  const objs: string[] = [];
  for (const [src, name] of [
    [join(RUNTIME, "vapor_core.c"), "vapor_core"],
    [join(nesDir, "vapor_nes.c"), "vapor_nes"],
    [genC, "gen_app"],
  ] as const) {
    const s = join(genDir, `${name}.cc65.s`);
    await $`cc65 ${cc} -o ${s} ${src}`.quiet();
    const o = join(genDir, `${name}.o`);
    await $`ca65 -o ${o} ${s}`.quiet();
    objs.push(o);
  }
  for (const asm of ["gen_header", "gen_chr"]) {
    const o = join(genDir, `${asm}.o`);
    await $`ca65 -o ${o} ${join(genDir, `${asm}.s`)}`.quiet();
    objs.push(o);
  }
  {
    const o = join(genDir, "crt0.o");
    await $`ca65 -o ${o} ${join(nesDir, "crt0.s")}`.quiet();
    objs.push(o);
  }

  await $`ld65 -C ${join(genDir, "nes.cfg")} -o ${outRom} ${objs} ${CC65_LIB}`.quiet();
  const rom = new Uint8Array(await Bun.file(outRom).arrayBuffer());
  return { romBytes: rom.length };
}
