// PSP FreeType must use the runtime's O32/noabicalls ABI. The SDK's optional
// libfreetype.a is EABI32 and cannot be linked into a PocketJS EBOOT.
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  pocketStackCacheRoot,
  publishStagedDirectory,
  resolveLlvmBin,
  resolvePspSdk,
  withArtifactLock,
} from "./psp-toolchain.ts";

export const PSP_FREETYPE = {
  version: "2.13.3",
  url: "https://github.com/freetype/freetype/archive/VER-2-13-3.zip",
  sha512: "ce413487c24e689631d705f53b64725256f89fffe9aade7cf07bbd785a9cd49eb6b8d2297a55554f3fee0a50b17e8af78f505cdab565768afab833794f968c2f",
  directory: "freetype-VER-2-13-3",
} as const;

export function pspCFlags(sdk: string): string[] {
  return [
    "-target", "mipsel-sony-psp", "-mcpu=mips2", "-mabi=o32", "-msingle-float",
    "-mlittle-endian", "-mno-abicalls", "-fno-pic", "-G0", "-mno-check-zero-division",
    "-fno-stack-protector", "-O2", `-I${sdk}/psp/include`, `-I${sdk}/psp/sdk/include`,
  ];
}

// Static TrueType outlines and the gray renderer are the entire PSP surface.
// Disable font IO: the background worker supplies bounded memory faces.
export const PSP_FREETYPE_OPTIONS = `#include <freetype/config/ftoption.h>
#define FT_CONFIG_OPTION_DISABLE_STREAM_SUPPORT
#undef FT_CONFIG_OPTION_ENVIRONMENT_PROPERTIES
#undef FT_CONFIG_OPTION_USE_LZW
#undef FT_CONFIG_OPTION_USE_ZLIB
#undef FT_CONFIG_OPTION_USE_BZIP2
#undef FT_CONFIG_OPTION_USE_PNG
#undef FT_CONFIG_OPTION_USE_BROTLI
#undef FT_CONFIG_OPTION_USE_HARFBUZZ
#undef FT_CONFIG_OPTION_POSTSCRIPT_NAMES
#undef FT_CONFIG_OPTION_ADOBE_GLYPH_LIST
#undef FT_CONFIG_OPTION_MAC_FONTS
#undef FT_CONFIG_OPTION_GUESSING_EMBEDDED_RFORK
#undef FT_CONFIG_OPTION_INCREMENTAL
#undef FT_CONFIG_OPTION_SVG
#undef TT_CONFIG_OPTION_EMBEDDED_BITMAPS
#undef TT_CONFIG_OPTION_COLOR_LAYERS
#undef TT_CONFIG_OPTION_POSTSCRIPT_NAMES
#undef TT_CONFIG_OPTION_BYTECODE_INTERPRETER
#undef TT_CONFIG_OPTION_SUBPIXEL_HINTING
#undef TT_CONFIG_OPTION_GX_VAR_SUPPORT
#undef TT_CONFIG_OPTION_BDF
`;

const modules = `FT_USE_MODULE( FT_Driver_ClassRec, tt_driver_class )
FT_USE_MODULE( FT_Module_Class, sfnt_module_class )
FT_USE_MODULE( FT_Renderer_Class, ft_smooth_renderer_class )
`;

const sources = [
  "src/base/ftbase.c", "src/base/ftinit.c", "src/base/ftdebug.c",
  "src/base/ftsystem.c", "src/truetype/truetype.c", "src/sfnt/sfnt.c", "src/smooth/smooth.c",
];

export function verifyFreeTypeArchive(bytes: Uint8Array): void {
  const actual = createHash("sha512").update(bytes).digest("hex");
  if (actual !== PSP_FREETYPE.sha512) {
    throw new Error(`PSP FreeType source checksum mismatch: expected ${PSP_FREETYPE.sha512}, got ${actual}`);
  }
}

export function verifyPspFreeTypeAbi(abi: string, objectCount: number): void {
  const headers = abi.split("ELF Header:").slice(1);
  if (headers.length !== objectCount || headers.some((header) => {
    const flag = /Flags:\s+0x([0-9a-f]+)/i.exec(header);
    const value = flag ? Number.parseInt(flag[1], 16) : 0;
    return !/Class:\s+ELF32\s/.test(header) ||
      !/Data:\s+2's complement, little endian/.test(header) ||
      !/Machine:\s+MIPS/.test(header) ||
      (value & 0xf000f006) !== 0x10001000;
  })) throw new Error(`FreeType object ABI mismatch:\n${abi}`);
}

async function run(argv: string[]): Promise<string> {
  const child = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (status !== 0) throw new Error(`${argv[0]} failed (${status}):\n${stdout}${stderr}`);
  return stdout;
}

export interface PspFreeTypeBuild {
  includeDir: string;
  libraryDir: string;
  identity: string;
}

export async function ensurePspFreeType(
  toolchain: { sdk: { path: string }; llvmBin: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<PspFreeTypeBuild> {
  const compiler = await run([join(toolchain.llvmBin, "clang"), "--version"]);
  const flags = pspCFlags(toolchain.sdk.path);
  const identity = createHash("sha256").update(JSON.stringify({
    source: PSP_FREETYPE, compiler, flags, sources, modules, options: PSP_FREETYPE_OPTIONS,
    // Changes to cache validation or build steps must invalidate the old result.
    recipe: createHash("sha256").update(readFileSync(new URL(import.meta.url))).digest("hex"),
  })).digest("hex");
  const cache = pocketStackCacheRoot(env);
  const destination = join(cache, "psp/freetype", identity);
  const result = { includeDir: join(destination, "include"), libraryDir: join(destination, "lib"), identity };
  const valid = () => {
    try {
      const receipt = JSON.parse(readFileSync(join(destination, "receipt.json"), "utf8"));
      return receipt.identity === identity &&
        receipt.archiveSha256 === createHash("sha256").update(readFileSync(join(result.libraryDir, "libfreetype.a"))).digest("hex") &&
        existsSync(join(result.includeDir, "ft2build.h"));
    } catch { return false; }
  };
  if (valid()) return result;

  return withArtifactLock(`${destination}.lock`, async () => {
    if (valid()) return result;
    const archive = join(cache, "downloads", `freetype-${PSP_FREETYPE.sha512}.zip`);
    await withArtifactLock(`${archive}.lock`, async () => {
      if (existsSync(archive)) {
        verifyFreeTypeArchive(readFileSync(archive));
        return;
      }
      mkdirSync(join(cache, "downloads"), { recursive: true });
      const temporary = `${archive}.download-${process.pid}`;
      try {
        await run(["curl", "-fL", "--retry", "3", "--connect-timeout", "30", "--max-time", "300",
          "-o", temporary, PSP_FREETYPE.url]);
        verifyFreeTypeArchive(readFileSync(temporary));
        renameSync(temporary, archive);
      } finally {
        rmSync(temporary, { force: true });
      }
    });
    const staging = `${destination}.staging-${process.pid}-${Date.now()}`;
    mkdirSync(join(staging, "lib"), { recursive: true });
    try {
      console.log(`PocketJS psp: building FreeType ${PSP_FREETYPE.version} (O32/noabicalls)`);
      await run(["unzip", "-q", archive, "-d", staging]);
      const source = join(staging, PSP_FREETYPE.directory);
      cpSync(join(source, "include"), join(staging, "include"), { recursive: true });
      writeFileSync(join(staging, "include/pocket_ftoption.h"), PSP_FREETYPE_OPTIONS);
      writeFileSync(join(staging, "include/pocket_ftmodule.h"), modules);
      const objects: string[] = [];
      // Limit host compiler concurrency and archive in stable source order.
      for (const file of sources) {
        const object = join(staging, file.replaceAll("/", "-") + ".o");
        await run([
          join(toolchain.llvmBin, "clang"), ...flags, "-ffunction-sections", "-fdata-sections",
          "-DFT2_BUILD_LIBRARY", '-DFT_CONFIG_OPTIONS_H="pocket_ftoption.h"',
          '-DFT_CONFIG_MODULES_H="pocket_ftmodule.h"', `-I${staging}/include`,
          "-c", join(source, file), "-o", object,
        ]);
        objects.push(object);
      }
      const library = join(staging, "lib/libfreetype.a");
      await run([join(toolchain.llvmBin, "llvm-ar"), "rcsD", library, ...objects]);
      // Every object must agree with the runtime: little-endian MIPS2 O32,
      // with neither the PIC nor CPIC/abicalls ELF flag set.
      const abi = await run([join(toolchain.llvmBin, "llvm-readelf"), "-h", library]);
      verifyPspFreeTypeAbi(abi, sources.length);
      const archiveSha256 = createHash("sha256").update(readFileSync(library)).digest("hex");
      writeFileSync(join(staging, "receipt.json"), JSON.stringify({
        identity, source: PSP_FREETYPE, compiler, flags, archiveSha256, abi,
      }, null, 2) + "\n");
      cpSync(join(source, "docs/FTL.TXT"), join(staging, "FreeType-LICENSE.txt"));
      rmSync(source, { recursive: true });
      for (const object of objects) rmSync(object);
      publishStagedDirectory(staging, destination);
      return result;
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  });
}

if (import.meta.main) {
  const llvmBin = resolveLlvmBin();
  if (!llvmBin) throw new Error("PSP FreeType requires LLVM: run `bun run bootstrap`");
  const result = await ensurePspFreeType({ llvmBin, sdk: resolvePspSdk() });
  console.log(JSON.stringify(result));
}
