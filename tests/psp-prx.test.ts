import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyPspPrx } from "../tools/psp-prx.ts";
import { resolvePspBuildToolchain } from "../tools/psp-toolchain.ts";

// ELF32 layout reduced from a real failing PSP build: the RX segment began
// at file offset 0xe0, but 64-byte-aligned rodata shifted the R segment by
// another 32 bytes. prxgen retained that gap when flattening the segments.
function prx(rodataGap = 0): Uint8Array {
  const bytes = new Uint8Array(0x400);
  const view = new DataView(bytes.buffer);
  const u16 = (at: number, value: number) => view.setUint16(at, value, true);
  const u32 = (at: number, value: number) => view.setUint32(at, value, true);
  u32(0, 0x464c457f); bytes[4] = 1; bytes[5] = 1;
  u16(16, 0xffa0); u16(18, 8); u32(28, 52); u32(32, 0x300);
  u16(42, 32); u16(44, 1); u16(46, 40); u16(48, 4);
  u32(52, 1); u32(56, 0xe0); u32(68, 0x120); u32(72, 0x180);
  for (const [i, type, addr, offset, size] of [
    [1, 1, 0, 0xe0, 0x80],
    [2, 1, 0x80, 0x160 + rodataGap, 0x80],
    [3, 8, 0x120, 0x200, 0x60],
  ]) {
    const at = 0x300 + i! * 40;
    u32(at + 4, type!); u32(at + 8, 2); u32(at + 12, addr!);
    u32(at + 16, offset!); u32(at + 20, size!);
  }
  return bytes;
}

describe("PSP PRX load layout", () => {
  test("accepts a flat image including BSS", () => expect(() => verifyPspPrx(prx())).not.toThrow());
  test("rejects the alignment gap that crashes sceLoaderCore", () => {
    expect(() => verifyPspPrx(prx(32))).toThrow("file offset does not match its load address");
  });
  test("rejects a truncated image", () => expect(() => verifyPspPrx(prx().slice(0, 80))).toThrow("truncated"));
  test("rejects a section outside the kernel allocation", () => {
    const bytes = prx(); new DataView(bytes.buffer).setUint32(0x300 + 3 * 40 + 20, 0x100, true);
    expect(() => verifyPspPrx(bytes)).toThrow("exceeds loaded memory");
  });
});

// Opt in on a machine provisioned by `bun run bootstrap`: this exercises
// clang, the pinned Rust linker, and prxgen rather than a source-text check.
test.skipIf(process.env.POCKETJS_TEST_PSP_LINK !== "1")("links aligned MIPS data into a loadable PRX", () => {
  const toolchain = resolvePspBuildToolchain();
  const dir = mkdtempSync(join(tmpdir(), "pocketjs-prx-"));
  const run = (cmd: string[]) => {
    const result = Bun.spawnSync(cmd, { env: toolchain.environment });
    if (result.exitCode) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  try {
    const rust = [toolchain.rustup, "run", toolchain.manifest.rust.toolchain, "rustc"];
    const sysroot = run([...rust, "--print", "sysroot"]);
    const host = run([...rust, "-vV"]).match(/^host: (.+)$/m)![1]!;
    const linker = join(sysroot, "lib/rustlib", host, "bin/rust-lld");
    const target = JSON.parse(readFileSync(new URL("../hosts/psp/targets/mipsel-sony-psp.json", import.meta.url), "utf8"));
    const object = join(dir, "aligned.o"), elf = join(dir, "aligned.elf"), prxFile = join(dir, "aligned.prx");
    writeFileSync(join(dir, "link.ld"), target["link-script"]);
    run([join(toolchain.llvmBin, "clang"), "-target", "mipsel-sony-psp", "-march=mips2", "-mno-abicalls", "-fno-pic", "-c",
      new URL("fixtures/psp-prx/aligned.s", import.meta.url).pathname, "-o", object]);
    run([linker, "-flavor", "gnu", "--nmagic", "--emit-relocs", "--eh-frame-hdr", "-T", join(dir, "link.ld"), object, "-o", elf]);
    run([Bun.which("prxgen", { PATH: toolchain.environment.PATH })!, elf, prxFile]);
    verifyPspPrx(readFileSync(prxFile));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
