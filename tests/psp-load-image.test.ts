import { describe, expect, test } from "bun:test";
import { validatePspLoadImage } from "../tools/psp-load-image.ts";

function image() {
  const bytes = new Uint8Array(0x500), data = new DataView(bytes.buffer);
  const u16 = (offset: number, value: number) => data.setUint16(offset, value, true);
  const u32 = (offset: number, value: number) => data.setUint32(offset, value, true);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 1, 1]);
  u16(16, 0xffa0); u16(18, 8); u32(28, 52); u32(32, 0x300);
  u16(42, 32); u16(44, 1); u16(46, 40); u16(48, 4); u16(50, 3);
  u32(52, 1); u32(56, 0x100); u32(64, 0x140); u32(68, 0x80); u32(72, 0x100);
  const section = (index: number, name: number, address: number, offset: number, size: number, flags: number) => {
    const start = 0x300 + index * 40;
    [name, 1, flags, address, offset, size].forEach((value, index) => u32(start + index * 4, value));
  };
  const names = new TextEncoder().encode("\0.text\0.rodata.sceModuleInfo\0.shstrtab\0");
  bytes.set(names, 0x280);
  section(1, 1, 0, 0x100, 0x20, 6);
  section(2, 7, 0x40, 0x140, 0x40, 2);
  section(3, 29, 0, 0x280, names.length, 0);
  return { bytes, u16, u32 };
}

describe("PSP loader image", () => {
  test("accepts one load segment with aligned section addresses", () => {
    const { bytes, u16, u32 } = image();
    expect(() => validatePspLoadImage(bytes)).not.toThrow();
    u16(16, 2); u32(64, 0); // Native ELF has no PRX module-info p_paddr yet.
    expect(() => validatePspLoadImage(bytes)).not.toThrow();
  });

  test("rejects the 32-byte alignment gap that moved module info into import names", () => {
    const { bytes, u32 } = image();
    u32(0x300 + 2 * 40 + 16, 0x160);
    expect(() => validatePspLoadImage(bytes)).toThrow("file/address alignment gap");
  });

  test("rejects multiple load segments and an invalid module pointer", () => {
    const { bytes, u16, u32 } = image();
    u16(44, 2); u32(84, 1);
    expect(() => validatePspLoadImage(bytes)).toThrow("expected one PT_LOAD");
    u16(44, 1); u32(64, 0x160);
    expect(() => validatePspLoadImage(bytes)).toThrow("module info pointer");
  });

  test("rejects truncated load data before publishing an EBOOT", () => {
    const { bytes, u32 } = image();
    u32(68, 0x480); u32(72, 0x500);
    expect(() => validatePspLoadImage(bytes)).toThrow("PT_LOAD range");
  });
});
