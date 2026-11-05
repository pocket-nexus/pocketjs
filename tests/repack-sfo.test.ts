import { describe, expect, test } from "bun:test";
import { readSfo, writeSfo } from "../tools/repack/shared/sfo.ts";

describe("sfo", () => {
  test("writes sorted keys with their rooms and reads them back", () => {
    const sfo = writeSfo([
      { key: "TITLE", value: "Hello", room: 128 },
      { key: "BOOTABLE", value: 1 },
      { key: "CATEGORY", value: "MG" },
    ]);
    expect(readSfo(sfo)).toEqual([
      { key: "BOOTABLE", format: 0x0404, value: 1, used: 4, room: 4 },
      { key: "CATEGORY", format: 0x0204, value: "MG", used: 3, room: 4 },
      { key: "TITLE", format: 0x0204, value: "Hello", used: 6, room: 128 },
    ]);
    expect(() => writeSfo([{ key: "TITLE", value: "x".repeat(10), room: 8 }])).toThrow("room is 8");
    expect(() => writeSfo([{ key: "A", value: 1 }, { key: "A", value: 2 }])).toThrow("duplicate key");
  });
});
