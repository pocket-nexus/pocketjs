import { describe, expect, test } from "bun:test";
import { verifyFreeTypeArchive, verifyPspFreeTypeAbi } from "../tools/psp-freetype.ts";

// llvm-readelf -h output: the bundled PSP SDK's optional FreeType archive uses
// EABI32, while Rust and QuickJS require MIPS2/O32 and no abicalls.
const header = `ELF Header:
  Class:                             ELF32
  Data:                              2's complement, little endian
  Machine:                           MIPS R3000
  Flags:                             0x10001001, noreorder, o32, mips2
`;

describe("PSP FreeType build inputs", () => {
  test("accepts O32 objects and rejects incompatible SDK EABI, PIC and ISA", () => {
    expect(() => verifyPspFreeTypeAbi(header.repeat(2), 2)).not.toThrow();
    for (const flags of ["0x20003001", "0x10001003", "0x10001005", "0x20001001"]) {
      expect(() => verifyPspFreeTypeAbi(header.replace("0x10001001", flags), 1)).toThrow("ABI mismatch");
    }
    expect(() => verifyPspFreeTypeAbi(header.replace("little endian", "big endian"), 1)).toThrow("ABI mismatch");
    expect(() => verifyPspFreeTypeAbi(header.replace("ELF32", "ELF64"), 1)).toThrow("ABI mismatch");
    expect(() => verifyPspFreeTypeAbi(header, 2)).toThrow("ABI mismatch");
    expect(() => verifyPspFreeTypeAbi("", 1)).toThrow("ABI mismatch");
  });

  test("rejects unverified source bytes before extraction", () => {
    expect(() => verifyFreeTypeArchive(new TextEncoder().encode("unexpected source")))
      .toThrow("source checksum mismatch");
  });
});
