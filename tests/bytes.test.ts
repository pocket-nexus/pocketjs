// tests/bytes.test.ts — framework/src/bytes.ts UTF-8 decoding: the same
// strings TextDecoder reads (a BOM kept, as ignoreBOM keeps it), malformed
// input refused, and sequences that straddle a decode chunk kept whole.

import { describe, expect, test } from "bun:test";
import { stringToUtf8, utf8ToString } from "../framework/src/bytes.ts";

const CHUNK = 8192;

describe("utf8ToString", () => {
  test("decodes what TextDecoder decodes", () => {
    for (const text of ["", "plain ascii", "# 今天 🚀", "テスト ユーザー、日本語。", "émoji 👩‍👩‍👧 \u0000 %41 %", "﻿bom"]) {
      expect(utf8ToString(stringToUtf8(text))).toBe(text);
      expect(utf8ToString(new TextEncoder().encode(text))).toBe(new TextDecoder("utf-8", { ignoreBOM: true }).decode(new TextEncoder().encode(text)));
    }
  });

  test("keeps sequences whole across chunk edges", () => {
    for (const pad of [CHUNK - 3, CHUNK - 2, CHUNK - 1, CHUNK, 2 * CHUNK - 1]) {
      for (const tail of ["é", "今", "🚀", "今🚀é"]) {
        const text = "a".repeat(pad) + tail + "b".repeat(5) + tail;
        expect(utf8ToString(stringToUtf8(text))).toBe(text);
      }
    }
    const long = Array.from({ length: 6000 }, (_, i) => String.fromCodePoint(0x3041 + (i % 80), 0x1f600 + (i % 50), 0x41 + (i % 26))).join("");
    expect(utf8ToString(stringToUtf8(long))).toBe(long);
  });

  test("refuses malformed UTF-8", () => {
    const bad = [
      [0x80], // lone continuation
      [0x61, 0xe4, 0xbb], // truncated
      [0xc0, 0x80], // overlong NUL
      [0xe0, 0x80, 0xaf], // overlong
      [0xed, 0xa0, 0x80], // surrogate
      [0xf4, 0x90, 0x80, 0x80], // past U+10FFFF
      [0xff],
    ];
    for (const bytes of bad) expect(() => utf8ToString(new Uint8Array(bytes))).toThrow("invalid UTF-8");
    const straddling = new Uint8Array(CHUNK + 4).fill(0x61);
    straddling.set([0x80, 0x80, 0x80, 0x80], CHUNK - 2);
    expect(() => utf8ToString(straddling)).toThrow("invalid UTF-8");
  });
});
