import { POCKET_BINDING_GENERATION } from "../contracts/spec/binding-generation.ts";
import { describe, expect, test } from "bun:test";
import { crc32 } from "../tools/repack/shared/crc32.ts";
import { decodePng, deflateZlib, encodePng } from "../tools/repack/shared/png.ts";
import { flattenRgba, scaleRgba } from "../tools/repack/shared/scale.ts";
import { admitPocket, readRuntime, sha256Hex, type RuntimeManifest } from "../tools/repack/shared/runtime.ts";
import { decodePocketPackage, encodePocketPackage, POCKET_SECTION } from "../contracts/spec/pocket-package.ts";
import { validateAndResolveBuildPlan } from "../framework/src/manifest/resolve.ts";
import { makeVariant } from "../tools/pocket-pack.ts";
import { hashPocketProfile } from "../framework/src/profile.ts";
import { writeRuntimeManifest } from "../tools/runtime/manifest.ts";

function chunk(name: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = name.charCodeAt(i);
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

/** A PNG from already-filtered scanline bytes (each row led by its filter byte). */
async function png(
  header: { width: number; height: number; depth: number; type: number; interlace?: number },
  scanlines: number[],
  extra: Array<[string, number[]]> = [],
): Promise<Uint8Array> {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, header.width);
  view.setUint32(4, header.height);
  ihdr[8] = header.depth;
  ihdr[9] = header.type;
  ihdr[12] = header.interlace ?? 0;
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    ...extra.map(([name, body]) => chunk(name, new Uint8Array(body))),
    chunk("IDAT", await deflateZlib(new Uint8Array(scanlines))),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

describe("repack shared helpers", () => {
  test("CRC-32 matches the standard check value", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  test("PNG round-trips RGBA and RGB with every row filter decoded", async () => {
    const rgba = new Uint8Array(5 * 3 * 4).map((_, index) => (index * 37) & 255);
    const decoded = await decodePng(await encodePng({ width: 5, height: 3, rgba }));
    expect(decoded).toEqual({ width: 5, height: 3, rgba });
    const opaque = await decodePng(await encodePng({ width: 5, height: 3, rgba }, { opaque: true }));
    expect(opaque.rgba.filter((_, index) => index % 4 === 3).every((alpha) => alpha === 255)).toBe(true);

    // Sub, Up, Average and Paeth rows over one RGB pixel pair.
    const filtered = await png({ width: 2, height: 4, depth: 8, type: 2 }, [
      1, 10, 20, 30, 5, 5, 5,
      2, 1, 1, 1, 1, 1, 1,
      3, 2, 2, 2, 2, 2, 2,
      4, 0, 0, 0, 0, 0, 0,
    ]);
    const image = await decodePng(filtered);
    expect(Array.from(image.rgba.subarray(0, 8))).toEqual([10, 20, 30, 255, 15, 25, 35, 255]);
    expect(Array.from(image.rgba.subarray(8, 16))).toEqual([11, 21, 31, 255, 16, 26, 36, 255]);
    // Average: left 0 + up 11 -> 5 (+2 = 7) for the first pixel.
    expect(image.rgba[16]).toBe(7);
    // Paeth with zero deltas repeats the row above.
    expect(Array.from(image.rgba.subarray(24, 32))).toEqual(Array.from(image.rgba.subarray(16, 24)));
  });

  test("PNG reads palettes with tRNS, low bit depths, 16-bit samples and Adam7", async () => {
    const palette = await png({ width: 4, height: 1, depth: 2, type: 3 }, [0, 0b00011011], [
      ["PLTE", [255, 0, 0, 0, 255, 0, 0, 0, 255, 9, 9, 9]],
      ["tRNS", [255, 128]],
    ]);
    expect(Array.from((await decodePng(palette)).rgba)).toEqual([
      255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 255, 9, 9, 9, 255,
    ]);
    const gray = await png({ width: 3, height: 1, depth: 1, type: 0 }, [0, 0b10100000]);
    expect(Array.from((await decodePng(gray)).rgba.filter((_, index) => index % 4 === 0))).toEqual([255, 0, 255]);
    const deep = await png({ width: 1, height: 1, depth: 16, type: 6 }, [0, 0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xff, 0xff]);
    expect(Array.from((await decodePng(deep)).rgba)).toEqual([0x12, 0x56, 0x9a, 0xff]);

    // A 3x3 gray image in Adam7 order, pixel value 10 * (y * 3 + x): passes 2
    // and 3 start past the image and are empty.
    const interlaced = await png({ width: 3, height: 3, depth: 8, type: 0, interlace: 1 }, [
      0, 0, // pass 1: (0,0)
      // pass 2: x0 4 -> empty; pass 3: y0 4 -> empty
      0, 20, // pass 4: (2,0)
      0, 60, 80, // pass 5: (0,2), (2,2)
      0, 10, 0, 70, // pass 6: (1,0), (1,2)
      0, 30, 40, 50, // pass 7: row y=1
    ]);
    const pixels = (await decodePng(interlaced)).rgba.filter((_, index) => index % 4 === 0);
    expect(Array.from(pixels)).toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80]);
  });

  test("PNG refuses what is not a readable image", async () => {
    await expect(decodePng(new Uint8Array([1, 2, 3]))).rejects.toThrow(/signature/);
    const good = await encodePng({ width: 1, height: 1, rgba: new Uint8Array(4) });
    const corrupt = good.slice();
    corrupt[20] ^= 1;
    await expect(decodePng(corrupt)).rejects.toThrow(/CRC mismatch/);
    await expect(decodePng(await png({ width: 1, height: 1, depth: 3, type: 0 }, [0, 0]))).rejects.toThrow(/not a PNG format/);
  });

  test("area scaling averages in premultiplied alpha and flattening composites", () => {
    const rgba = new Uint8Array([
      255, 0, 0, 255, 0, 0, 255, 0,
      255, 0, 0, 255, 0, 0, 255, 0,
    ]);
    const half = scaleRgba({ width: 2, height: 2, rgba }, 1, 1);
    // The transparent blue pixels lend no colour: the result is red at half alpha.
    expect(Array.from(half.rgba)).toEqual([255, 0, 0, 128]);
    const double = scaleRgba({ width: 1, height: 1, rgba: new Uint8Array([1, 2, 3, 255]) }, 3, 3);
    expect(double.rgba.every((value, index) => value === [1, 2, 3, 255][index % 4])).toBe(true);
    expect(Array.from(flattenRgba(half, [0, 0, 255]).rgba)).toEqual([128, 0, 127, 255]);
  });

  test("a runtime directory must match its runtime.json", async () => {
    const program = new Uint8Array([1, 2, 3]);
    const manifest = (files: object) => new TextEncoder().encode(JSON.stringify({ target: "3ds-dev", hostAbi: POCKET_BINDING_GENERATION, pocketjs: "x", profile: "3ds-dev", profileHash: `sha256:${"12".repeat(32)}`, files }));
    const good = new Map([["runtime.json", manifest({ "a.bin": { bytes: 3, sha256: await sha256Hex(program) } })], ["a.bin", program]]);
    expect((await readRuntime(good, "3ds-dev")).hostAbi).toBe(POCKET_BINDING_GENERATION);
    await expect(readRuntime(new Map(), "3ds-dev")).rejects.toThrow(/no runtime.json/);
    await expect(readRuntime(good, "psp")).rejects.toThrow(/for "3ds-dev", not "psp"/);
    const missing = new Map([["runtime.json", manifest({ "a.bin": { bytes: 3, sha256: "00" } })]]);
    await expect(readRuntime(missing, "3ds-dev")).rejects.toThrow(/missing a.bin/);
    for (const profileHash of [undefined, "", "sha256:bad"]) {
      const raw = JSON.parse(new TextDecoder().decode(good.get("runtime.json")!));
      const invalid = new Map(good);
      invalid.set("runtime.json", new TextEncoder().encode(JSON.stringify({ ...raw, profileHash })));
      await expect(readRuntime(invalid, "3ds-dev")).rejects.toThrow(/profileHash/);
    }
  });

  test("package, plan and runtime must name the same complete software profile", async () => {
    const manifest = await Bun.file(new URL("./fixtures/manifests/portable-psp.json", import.meta.url)).json();
    const resolution = validateAndResolveBuildPlan(manifest, { target: "psp" });
    if (!resolution.ok) throw new Error(JSON.stringify(resolution.diagnostics));
    const plan = resolution.plan;
    const variant = makeVariant({ target: "psp", hostAbi: plan.target.hostAbi, planJson: JSON.stringify(plan),
      identity: { id: plan.app.id, title: plan.app.title, output: plan.app.output }, js: new TextEncoder().encode("test"), pak: new Uint8Array() });
    const encode = () => encodePocketPackage({ manifest: new TextEncoder().encode(JSON.stringify(manifest)), variants: [variant] });
    const runtime: RuntimeManifest = { target: "psp", hostAbi: plan.target.hostAbi, profile: "psp",
      profileHash: plan.profileHash, pocketjs: "test", files: {} };
    const identity = { id: plan.app.id, title: plan.app.title, author: "Test", version: plan.app.version };
    expect((await admitPocket(encode(), runtime, identity)).variant.profileHash).toBe(plan.profileHash);
    for (let generation = 1; generation < POCKET_BINDING_GENERATION; generation++) {
      const oldVariant = { ...variant, hostAbi: generation };
      const legacy = encodePocketPackage({ manifest: new TextEncoder().encode(JSON.stringify(manifest)), variants: [oldVariant] });
      // No implicit conversion: matching profile and legacy runtime do not
      // make an old binding eligible for the current producer/repack tools.
      await expect(admitPocket(legacy, runtime, identity)).rejects.toThrow(`host ABI ${generation}; this runtime is ABI ${POCKET_BINDING_GENERATION}`);
      await expect(admitPocket(legacy, { ...runtime, hostAbi: generation }, identity)).rejects.toThrow("runtime binding generation");
      const files = new Map([["runtime.json", new TextEncoder().encode(JSON.stringify({ ...runtime, hostAbi: generation }))]]);
      await expect(readRuntime(files, "psp")).rejects.toThrow("runtime binding generation");
      await expect(writeRuntimeManifest("/unused", { target: "psp", hostAbi: generation, profile: "psp", profileHash: plan.profileHash, files: [] })).rejects.toThrow("binding generation");
      expect(() => makeVariant({ target: "psp", hostAbi: generation, planJson: JSON.stringify(plan),
        identity: { id: plan.app.id, title: plan.app.title, output: plan.app.output }, js: new Uint8Array(), pak: new Uint8Array() })).toThrow("binding generation");
    }
    const changed = { ...plan.profile, capabilities: [...plan.profile.capabilities, "ui.physics"] };
    await expect(admitPocket(encode(), { ...runtime, profileHash: hashPocketProfile(changed) }, identity)).rejects.toThrow(/profileHash/);
    variant.profileHash = hashPocketProfile(changed);
    await expect(admitPocket(encode(), runtime, identity)).rejects.toThrow(/profileHash/);
    variant.profileHash = plan.profileHash;
    variant.sections.find(section => section.kind === POCKET_SECTION.plan)!.bytes = new TextEncoder().encode(JSON.stringify({
      ...plan, profile: changed,
    }));
    await expect(admitPocket(encode(), runtime, identity)).rejects.toThrow(/plan has an invalid profile identity/);
    const decoded = decodePocketPackage(encode());
    expect(decoded.variants[0]!.profileHash).toBe(runtime.profileHash);
  });
});
