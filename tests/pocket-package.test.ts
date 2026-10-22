// Container encoding, decoding and structural validation.

import { describe, expect, test } from "bun:test";
import {
POCKET_LAYOUT, POCKET_PACKAGE_HEADER_SIZE, POCKET_PACKAGE_VARIANT_SIZE,
POCKET_SECTION,
decodeHostInputs,
decodeIdentity,
decodePocketPackage,
encodeHostInputs,
encodeIdentity,
encodePocketPackage,
findSection,
findVariant,
fnv1a64,
thinPocketPackage,
type PocketPackage,
} from "../contracts/spec/pocket-package.ts";


/** Deterministic synthetic app: a psp variant, a vita variant (different
 *  flavor bytes, like real density-split builds), a desktop widget variant
 *  — the "desktop to vita to psp" spread the format must model. */
function syntheticPackage(): PocketPackage {
  const manifest = new TextEncoder().encode(
    JSON.stringify({ pocket: 2, id: "dev.pocket-nexus.synthetic", title: "Synthetic" }),
  );
  const identity = encodeIdentity({
    output: "synthetic-main",
    id: "dev.pocket-nexus.synthetic",
    title: "Synthetic",
  });
  const js = new TextEncoder().encode('globalThis.frame = () => {};\0');
  const variant = (target: string, hostAbi: number, flavor: number) => ({
    target,
    hostAbi,
    profileHash: `sha256:${"11".repeat(32)}`,
    sections: [
      { kind: POCKET_SECTION.identity, bytes: identity },
      { kind: POCKET_SECTION.plan, bytes: new TextEncoder().encode(`{"target":{"id":"${target}"}}`) },
      { kind: POCKET_SECTION.js, bytes: js },
      { kind: POCKET_SECTION.pak, bytes: new Uint8Array([flavor, 1, 2, 3, 4, 5, 6, 7]) },
      { kind: POCKET_SECTION.cover, bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, flavor]) },
    ],
  });
  return {
    manifest,
    variants: [variant("psp", 1, 10), variant("vita", 1, 20), variant("macos-widget", 3, 30)],
  };
}

describe("pocket package format", () => {
  const pkg = syntheticPackage();
  const bytes = encodePocketPackage(pkg);

  test("roundtrip: decode(encode(pkg)) preserves everything", () => {
    const decoded = decodePocketPackage(bytes);
    expect(new TextDecoder().decode(decoded.manifest)).toContain("synthetic");
    expect(decoded.variants.map((v) => v.target)).toEqual(["macos-widget", "psp", "vita"]);
    const psp = findVariant(decoded, "psp")!;
    expect(psp.hostAbi).toBe(1);
    expect(decodeIdentity(findSection(psp, POCKET_SECTION.identity)!)).toEqual({
      output: "synthetic-main",
      id: "dev.pocket-nexus.synthetic",
      title: "Synthetic",
    });
    // The js section ends in the QuickJS NUL (zero-copy device eval rule).
    const js = findSection(psp, POCKET_SECTION.js)!;
    expect(js[js.length - 1]).toBe(0);
    // Flavored sections stay per-variant.
    expect(findSection(psp, POCKET_SECTION.pak)![0]).toBe(10);
    expect(findSection(findVariant(decoded, "vita")!, POCKET_SECTION.pak)![0]).toBe(20);
    expect(findSection(findVariant(decoded, "macos-widget")!, POCKET_SECTION.pak)![0]).toBe(30);
  });

  test("thinning selects only the requested variant", () => {
    const thinned = encodePocketPackage(thinPocketPackage(decodePocketPackage(bytes), ["psp"]));
    const decoded = decodePocketPackage(thinned);
    expect(decoded.variants.map((v) => v.target)).toEqual(["psp"]);
    expect(thinned.length).toBeLessThan(bytes.length);
  });

  test("unknown section kinds are carried, not fatal (forward compat)", () => {
    const future = syntheticPackage();
    future.variants[0].sections.push({ kind: 999, bytes: new Uint8Array([42]) });
    const decoded = decodePocketPackage(encodePocketPackage(future));
    const v = decoded.variants.find((x) => x.sections.some((s) => s.kind === 999))!;
    expect(findSection(v, 999)![0]).toBe(42);
    expect(findSection(v, POCKET_SECTION.js)).not.toBeNull();
  });

  test("guards: duplicate targets, duplicate kinds, oversized target id", () => {
    expect(() =>
      encodePocketPackage({ manifest: pkg.manifest, variants: [pkg.variants[0], pkg.variants[0]] }),
    ).toThrow(/duplicate variant/);
    const dup = syntheticPackage();
    dup.variants[0].sections.push({ kind: POCKET_SECTION.js, bytes: new Uint8Array([0]) });
    expect(() => encodePocketPackage(dup)).toThrow(/duplicate section/);
    const long = syntheticPackage();
    long.variants[0].target = "";
    expect(() => encodePocketPackage(long)).toThrow(/invalid target id/);
    long.variants[0].target = "a".repeat(65536);
    expect(() => encodePocketPackage(long)).toThrow(/target id too long/);
  });

  test("string table preserves long ids, Unicode, BOM and UTF-8 ordering", () => {
    const extended = syntheticPackage();
    const ids = ["profile-with-a-long-name", "\ue000", "😀", "\ufeffboard", "树外产品"];
    extended.variants = ids.map(target => ({ ...extended.variants[0], target }));
    const decoded = decodePocketPackage(encodePocketPackage(extended));
    expect(decoded.variants.map(variant => variant.target)).toEqual([...ids].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))));
    const invalid = { ...extended, variants: [{ ...extended.variants[0], target: "\ud800" }] };
    expect(() => encodePocketPackage(invalid)).toThrow("invalid target");
  });

  test("old packages and structurally invalid checksummed directories are rejected", () => {
    const table = Math.ceil((POCKET_PACKAGE_HEADER_SIZE + new DataView(bytes.buffer).getUint32(8, true)) / 16) * 16;
    const malformed = (change: (view: DataView) => void) => {
      const altered = bytes.slice();
      const view = new DataView(altered.buffer);
      change(view);
      view.setBigUint64(altered.length - 8, fnv1a64(altered.subarray(0, -8)), true);
      return altered;
    };
    expect(() => decodePocketPackage(malformed(view => view.setUint32(4, 1, true)))).toThrow("unsupported version 1");
    for (const change of [
      (view: DataView) => view.setUint32(24, 1, true),
      (view: DataView) => view.setUint32(table + POCKET_LAYOUT.variant.targetSize, 65536, true),
      (view: DataView) => view.setUint32(table + POCKET_PACKAGE_VARIANT_SIZE, view.getUint32(table, true), true),
      (view: DataView) => view.setUint32(table + POCKET_LAYOUT.variant.sectionsOffset, table, true),
      (view: DataView) => view.setUint32(view.getUint32(table + POCKET_LAYOUT.variant.sectionsOffset, true) + 8, table, true),
    ]) {
      const altered = malformed(change);
      expect(() => decodePocketPackage(altered)).toThrow("layout");
      expect(() => decodePocketPackage(altered, { skipHashCheck: true })).toThrow("layout");
    }
  });

  test("empty payloads and thinning do not mutate input", () => {
    const input = syntheticPackage();
    input.variants[0].sections = [{ kind: 20, bytes: new Uint8Array() }, ...input.variants[0].sections];
    const order = input.variants[0].sections.map(section => section.kind);
    const decoded = decodePocketPackage(encodePocketPackage(input));
    expect(input.variants[0].sections.map(section => section.kind)).toEqual(order);
    const thinned = decodePocketPackage(encodePocketPackage(thinPocketPackage(decoded, ["psp"])));
    expect(findSection(thinned.variants[0], 20)).toHaveLength(0);
    expect(decodePocketPackage(encodePocketPackage({ manifest: new Uint8Array(), variants: [] })).variants).toEqual([]);
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
  });
});
