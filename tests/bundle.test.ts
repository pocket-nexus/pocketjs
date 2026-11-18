// Bundle encoding, decoding and structural validation.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BUNDLE_HEADER_SIZE,
  BUNDLE_LAYOUT,
  BUNDLE_SECTION,
  BUNDLE_SECTION_SIZE,
  bundlePayloadHash,
  decodeBundle,
  decodeHostInputs,
  decodeIdentity,
  encodeBundle,
  encodeHostInputs,
  encodeIdentity,
  findSection,
  fnv1a64,
  type Bundle,
} from "../contracts/spec/bundle.ts";
import { bundleCorpus, syntheticBundle } from "../tools/bundle-corpus.ts";

const ROOT = join(import.meta.dir, "..");

/** Deterministic synthetic app: one host contract, five sections. */
function synthetic(): Bundle {
  return decodeBundle(syntheticBundle());
}

describe("bundle format", () => {
  const bytes = syntheticBundle();

  test("roundtrip: decode(encode(bundle)) preserves the header and every section", () => {
    const decoded = decodeBundle(bytes);
    expect(decoded.hostAbi).toBe(1);
    expect(decoded.profileHash).toBe(`sha256:${"11".repeat(32)}`);
    expect(decoded.sections.map(section => section.kind)).toEqual([1, 2, 3, 4, 5]);
    expect(decodeIdentity(findSection(decoded, BUNDLE_SECTION.identity)!)).toEqual({
      output: "synthetic-main",
      id: "dev.pocket-nexus.synthetic",
      title: "Synthetic",
    });
    // The js section ends in the QuickJS NUL (zero-copy device eval rule).
    const js = findSection(decoded, BUNDLE_SECTION.js)!;
    expect(js[js.length - 1]).toBe(0);
    expect(findSection(decoded, BUNDLE_SECTION.icon)![0]).toBe(0x89);
    expect(encodeBundle(decoded)).toEqual(bytes);
  });

  test("the header sits at fixed offsets, the table at 64 and payloads 16-aligned", () => {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe("PKBD");
    expect(view.getUint32(BUNDLE_LAYOUT.header.version, true)).toBe(1);
    expect(view.getUint32(BUNDLE_LAYOUT.header.sectionCount, true)).toBe(5);
    expect(view.getBigUint64(BUNDLE_LAYOUT.header.payloadHash, true)).toBe(bundlePayloadHash(synthetic()));
    expect([...bytes.subarray(BUNDLE_LAYOUT.header.reserved, BUNDLE_HEADER_SIZE)].every(byte => byte === 0)).toBe(true);
    for (let index = 0; index < 5; index++) {
      const offset = view.getUint32(BUNDLE_HEADER_SIZE + index * BUNDLE_SECTION_SIZE + BUNDLE_LAYOUT.section.offset, true);
      expect(offset % 16).toBe(0);
    }
    expect(view.getBigUint64(bytes.length - 8, true)).toBe(fnv1a64(bytes.subarray(0, bytes.length - 8)));
  });

  test("tampering trips the footer hash; a payload edit trips the payload hash", () => {
    const evil = bytes.slice();
    evil[bytes.length - 20] ^= 0xff;
    expect(() => decodeBundle(evil)).toThrow(/hash mismatch/);
    expect(() => decodeBundle(evil, { skipHashCheck: true })).not.toThrow();
    // A changed payload byte with a repaired footer disagrees with the
    // header's payload hash.
    const js = findSection(decodeBundle(bytes), BUNDLE_SECTION.js)!;
    const payload = bytes.slice();
    payload[js.byteOffset - bytes.byteOffset] ^= 0x01;
    new DataView(payload.buffer, payload.byteOffset).setBigUint64(payload.length - 8, fnv1a64(payload.subarray(0, payload.length - 8)), true);
    expect(() => decodeBundle(payload)).toThrow(/payload hash mismatch/);
  });

  test("unknown section kinds are carried, not fatal (forward compat)", () => {
    const future = synthetic();
    future.sections.push({ kind: 999, bytes: new Uint8Array([42]) });
    const decoded = decodeBundle(encodeBundle(future));
    expect(findSection(decoded, 999)![0]).toBe(42);
    expect(findSection(decoded, BUNDLE_SECTION.js)).not.toBeNull();
  });

  test("guards: duplicate kinds, profile hash and host ABI", () => {
    const duplicate = synthetic();
    duplicate.sections.push({ kind: BUNDLE_SECTION.js, bytes: new Uint8Array([0]) });
    expect(() => encodeBundle(duplicate)).toThrow(/duplicate section/);
    expect(() => encodeBundle({ ...synthetic(), profileHash: "sha256:00" })).toThrow(/profile hash/);
    expect(() => encodeBundle({ ...synthetic(), hostAbi: -1 })).toThrow(/host ABI/);
  });

  test("structurally invalid checksummed bundles are rejected with and without hash checks", () => {
    const malformed = (change: (view: DataView) => void) => {
      const altered = bytes.slice();
      const view = new DataView(altered.buffer);
      change(view);
      view.setBigUint64(altered.length - 8, fnv1a64(altered.subarray(0, -8)), true);
      return altered;
    };
    expect(() => decodeBundle(malformed(view => view.setUint32(4, 2, true)))).toThrow("unsupported version 2");
    const entry = (index: number) => BUNDLE_HEADER_SIZE + index * BUNDLE_SECTION_SIZE;
    for (const change of [
      (view: DataView) => view.setUint32(BUNDLE_LAYOUT.header.reserved, 1, true),
      (view: DataView) => view.setUint32(entry(0) + 4, 1, true),
      (view: DataView) => view.setUint32(entry(1), view.getUint32(entry(0), true), true),
      (view: DataView) => view.setUint32(entry(1) + BUNDLE_LAYOUT.section.offset, 0, true),
      (view: DataView) => view.setUint32(BUNDLE_LAYOUT.header.sectionCount, 4, true),
    ]) {
      const altered = malformed(change);
      expect(() => decodeBundle(altered)).toThrow("layout");
      expect(() => decodeBundle(altered, { skipHashCheck: true })).toThrow("layout");
    }
  });

  test("empty payloads share an offset and encoding does not reorder the input", () => {
    const input = synthetic();
    input.sections = [{ kind: 20, bytes: new Uint8Array() }, ...input.sections];
    const order = input.sections.map(section => section.kind);
    const decoded = decodeBundle(encodeBundle(input));
    expect(input.sections.map(section => section.kind)).toEqual(order);
    expect(findSection(decoded, 20)).toHaveLength(0);
    expect(decodeBundle(encodeBundle({ hostAbi: 1, profileHash: `sha256:${"00".repeat(32)}`, sections: [] })).sections).toEqual([]);
  });

  test("the committed corpus is the generator's output and every reader agrees on it", () => {
    const corpus = bundleCorpus();
    for (const directory of ["tests/fixtures/bundles/corpus", "engine/package/tests/fixtures/corpus"]) {
      const names = readdirSync(join(ROOT, directory)).sort();
      expect(names, directory).toEqual([...corpus.keys()].sort());
      for (const name of names) {
        const committed = new Uint8Array(readFileSync(join(ROOT, directory, name)));
        expect(Buffer.from(committed).equals(Buffer.from(corpus.get(name)!)), `${directory}/${name}`).toBe(true);
        let parsed = true;
        try { decodeBundle(committed); } catch { parsed = false; }
        expect(parsed, name).toBe(name.startsWith("ok-"));
      }
    }
    for (const file of ["tests/fixtures/bundles/synthetic.pkb", "engine/package/tests/fixtures/synthetic.pkb"]) {
      expect(Buffer.from(readFileSync(join(ROOT, file))).equals(Buffer.from(syntheticBundle())), file).toBe(true);
    }
  });

  test("ESP-IDF host inputs have a fixed binary roundtrip", () => {
    const input = {
      hostAbi: 1,
      tickHz: 60,
      logicalWidth: 320,
      logicalHeight: 240,
      physicalWidth: 320,
      physicalHeight: 240,
      rasterDensity: 1,
      presentation: "native" as const,
      profileHash: `sha256:${"12".repeat(32)}`,
      planHash: `sha256:${"ab".repeat(32)}`,
    };
    expect(decodeHostInputs(encodeHostInputs(input))).toEqual(input);
    expect(() => decodeHostInputs(new Uint8Array(103))).toThrow(/host inputs size/);
    expect(encodeIdentity({ output: "a", id: "b", title: "c" })).toEqual(new Uint8Array([1, 0, 97, 1, 0, 98, 1, 0, 99]));
  });
});
