import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  decodePocketPackage,
  encodeIdentity,
  encodePocketPackage,
  POCKET_SECTION,
  type PocketPackageVariant,
} from "../contracts/spec/pocket-package.ts";
import { canonicalJson } from "../framework/src/manifest/plan.ts";
import { resolve3dsBuildPlan } from "../tools/3ds-profile.ts";
import { makeVariant } from "../tools/pocket-pack.ts";
import {
  parse3dsx,
  repack3ds,
  tiledRgb565,
  write3dsx,
  writeRomfs,
  writeSmdh,
} from "../tools/repack/3ds.ts";
import { decodePng, encodePng } from "../tools/repack/shared/png.ts";
import { sha256Hex, type RepackInput } from "../tools/repack/shared/runtime.ts";

const ROOT = join(import.meta.dir, "..");
const FIXTURES = join(ROOT, "tests/fixtures/repack-3ds");
const fixture = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, name)));
const ID = "dev.pocket-nexus.studio.twenty48";

// The fixtures come from devkitPro's tools in the pinned devkitARM image
// (3dstools 1.3.1), written by:
//   bun tools/repack/reference-3ds.ts --pocket <twenty48.pocket> --id dev.pocket-nexus.studio.twenty48 \
//     --title "Twenty48 二〇四八 🎲" --author "Pocket Nexus" --version 0.1.0 --icon <rgba.png> \
//     --fixtures tests/fixtures/repack-3ds
//   smdhtool.smdh        smdhtool --create <title> "<title> 0.1.0" "Pocket Nexus" icon48.png out icon24.png
//   3dsxtool-one.romfs   3dsxtool --romfs=<dir> with app.pocket = tests/fixtures/packages/synthetic.pocket
//   3dsxtool-two.romfs   the same plus assets/note.txt = "pocketjs"
// The same command byte-compares a whole repacked .3dsx against 3dsxtool's.

function manifest(features: { requires?: string[]; enhances?: string[] } = {}) {
  return {
    $schema: "https://pocketjs.dev/schema/pocket-2.json",
    pocket: 2,
    id: ID,
    name: "twenty48",
    title: "Twenty48",
    version: "0.1.0",
    engine: { capabilities: { requires: ["text.glyphs.baked", "display.auxiliary", ...(features.requires ?? [])], enhances: ["input.buttons", ...(features.enhances ?? [])] } },
    app: {
      entry: "main.tsx",
      output: "twenty48",
      framework: "solid",
      viewport: { fixed: { logical: [400, 240], presentation: "native" } },
      surfaces: { auxiliary: { fixed: { logical: [320, 240], presentation: "native" } } },
    },
  };
}

function pocketFor(source = manifest(), extra: PocketPackageVariant[] = []): Uint8Array {
  const plan = resolve3dsBuildPlan(source);
  const variant = makeVariant({
    target: "3ds-dev",
    hostAbi: plan.target.hostAbi,
    planJson: canonicalJson(plan),
    identity: { output: plan.app.output, id: plan.app.id, title: plan.app.title },
    js: new TextEncoder().encode("globalThis.frame = () => {};"),
    pak: new Uint8Array([1, 2, 3, 4]),
  });
  return encodePocketPackage({
    manifest: new TextEncoder().encode(JSON.stringify(source)),
    variants: [variant, ...extra],
  });
}

/** A runtime program: three tiny segments and no relocations, with the fixture SMDH. */
function runtimeProgram(): Uint8Array {
  const header = new Uint8Array(32);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x58534433, true);
  view.setUint16(4, 32, true);
  view.setUint16(6, 8, true);
  view.setUint32(16, 8, true); // code
  view.setUint32(20, 4, true); // rodata
  view.setUint32(24, 12, true); // data
  view.setUint32(28, 4, true); // bss
  const program = new Uint8Array(24 + 8 + 4 + 8);
  program.set([0xde, 0xad, 0xbe, 0xef, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16], 24);
  return write3dsx({ header, program }, fixture("smdhtool.smdh"), null);
}

async function runtimeFiles(overrides: { target?: string; hostAbi?: number; program?: Uint8Array } = {}) {
  const program = runtimeProgram();
  const manifest = {
    target: overrides.target ?? "3ds-dev",
    hostAbi: overrides.hostAbi ?? 11,
    pocketjs: "0000000000000000000000000000000000000000",
    profile: "3ds-dev",
    files: { "runtime.3dsx": { bytes: program.length, sha256: await sha256Hex(program) } },
  };
  return new Map<string, Uint8Array>([
    ["runtime.json", new TextEncoder().encode(JSON.stringify(manifest))],
    ["runtime.3dsx", overrides.program ?? program],
  ]);
}

async function input(overrides: Partial<RepackInput> = {}): Promise<RepackInput> {
  return {
    runtime: await runtimeFiles(),
    pocket: pocketFor(),
    identity: { id: ID, title: "Twenty48", author: "Pocket Nexus", version: "0.1.0", icon: fixture("icon48.png") },
    ...overrides,
  };
}

function utf16At(bytes: Uint8Array, offset: number, units: number): string {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let text = "";
  for (let index = 0; index < units; index++) {
    const unit = view.getUint16(offset + index * 2, true);
    if (unit === 0) break;
    text += String.fromCharCode(unit);
  }
  return text;
}

describe("3DS SMDH and RomFS writers", () => {
  test("write the SMDH smdhtool writes for the same strings and icons", async () => {
    const large = await decodePng(fixture("icon48.png"));
    const small = await decodePng(fixture("icon24.png"));
    const title = "Twenty48 二〇四八 🎲";
    const ours = writeSmdh({ title, description: `${title} 0.1.0`, author: "Pocket Nexus", icons: { large, small } });
    expect(ours).toEqual(fixture("smdhtool.smdh"));
  });

  test("write the RomFS 3dsxtool writes for one file and for a nested tree", () => {
    const synthetic = new Uint8Array(readFileSync(join(ROOT, "tests/fixtures/packages/synthetic.pocket")));
    expect(writeRomfs([{ path: "app.pocket", bytes: synthetic }])).toEqual(fixture("3dsxtool-one.romfs"));
    expect(
      writeRomfs([
        { path: "app.pocket", bytes: synthetic },
        { path: "assets/note.txt", bytes: new TextEncoder().encode("pocketjs") },
      ]),
    ).toEqual(fixture("3dsxtool-two.romfs"));
    expect(() => writeRomfs([{ path: "../app.pocket", bytes: synthetic }])).toThrow(/bad or repeated path/);
  });

  test("tile icons in 8x8 Morton order as RGB565 over black", () => {
    const rgba = new Uint8Array(8 * 8 * 4);
    rgba.set([255, 0, 0, 255], 0); // (0,0) opaque red
    rgba.set([255, 255, 255, 128], (1 * 8 + 0) * 4); // (0,1) half white
    const tiled = new DataView(tiledRgb565({ width: 8, height: 8, rgba }).buffer);
    expect(tiled.getUint16(0, true)).toBe(0xf800);
    // tile_order[2] = 8: the third pixel is (0,1); 255*128/255 = 128 -> 16/32/16.
    expect(tiled.getUint16(4, true)).toBe((16 << 11) | (32 << 5) | 16);
  });
});

describe("repack3ds", () => {
  test("keeps the runtime's program and writes the game's SMDH and app.pocket", async () => {
    const repackInput = await input();
    const out = await repack3ds(repackInput);
    const parsed = parse3dsx(out);
    const runtime = parse3dsx(repackInput.runtime.get("runtime.3dsx")!);
    expect(parsed.program).toEqual(runtime.program);
    expect(new DataView(out.buffer).getUint16(4, true)).toBe(44);
    expect(Array.from(parsed.header.subarray(8))).toEqual(Array.from(runtime.header.subarray(8)));

    const smdh = parsed.smdh!;
    expect(new TextDecoder().decode(smdh.subarray(0, 4))).toBe("SMDH");
    for (const language of [0, 1, 15]) {
      const base = 8 + language * 0x200;
      expect(utf16At(smdh, base, 0x40)).toBe("Twenty48");
      expect(utf16At(smdh, base + 0x80, 0x80)).toBe("Twenty48 0.1.0");
      expect(utf16At(smdh, base + 0x180, 0x40)).toBe("Pocket Nexus");
    }
    // The icon fixture is 48x48 already, so the large icon is that PNG tiled.
    expect(smdh.subarray(0x2040 + 24 * 24 * 2)).toEqual(tiledRgb565(await decodePng(fixture("icon48.png"))));

    expect(parsed.romfs).toEqual(writeRomfs([{ path: "app.pocket", bytes: repackInput.pocket }]));
    const at = parsed.romfs!.length - ((repackInput.pocket.length + 3) & ~3);
    expect(parsed.romfs!.subarray(at, at + repackInput.pocket.length)).toEqual(repackInput.pocket);
  });

  test("is deterministic", async () => {
    const first = await repack3ds(await input());
    const second = await repack3ds(await input());
    expect(first).toEqual(second);
  });

  test("keeps the runtime's icons when the identity has none and scales any square PNG", async () => {
    const plain = await repack3ds(await input({ identity: { id: ID, title: "Twenty48", author: "Pocket Nexus", version: "0.1.0" } }));
    expect(parse3dsx(plain).smdh!.subarray(0x2040)).toEqual(fixture("smdhtool.smdh").subarray(0x2040));

    const big = new Uint8Array(200 * 200 * 4).fill(255);
    const scaled = await repack3ds(await input({
      identity: { id: ID, title: "Twenty48", author: "Pocket Nexus", version: "0.1.0", icon: await encodePng({ width: 200, height: 200, rgba: big }) },
    }));
    expect(new DataView(parse3dsx(scaled).smdh!.buffer, parse3dsx(scaled).smdh!.byteOffset).getUint16(0x2040, true)).toBe(0xffff);

    const wide = await encodePng({ width: 20, height: 10, rgba: new Uint8Array(20 * 10 * 4) });
    await expect(repack3ds(await input({
      identity: { id: ID, title: "Twenty48", author: "Pocket Nexus", version: "0.1.0", icon: wide },
    }))).rejects.toThrow(/not square/);
  });

  test("thins a package that also carries other targets' variants", async () => {
    const other: PocketPackageVariant = {
      target: "psp",
      hostAbi: 1,
      sections: [{ kind: POCKET_SECTION.identity, bytes: encodeIdentity({ output: "twenty48", id: ID, title: "Twenty48" }) }],
    };
    const universal = pocketFor(manifest(), [other]);
    expect(decodePocketPackage(universal).variants).toHaveLength(2);
    const out = parse3dsx(await repack3ds(await input({ pocket: universal })));
    // Thinning keeps the manifest and the variant's bytes: the 3DS-only package.
    expect(out.romfs).toEqual(writeRomfs([{ path: "app.pocket", bytes: pocketFor() }]));
  });

  test("refuses a runtime for another target, a wrong host ABI and a broken footer", async () => {
    await expect(repack3ds(await input({ runtime: await runtimeFiles({ target: "psp" }) }))).rejects.toThrow(/for "psp", not "3ds-dev"/);
    await expect(repack3ds(await input({ runtime: await runtimeFiles({ hostAbi: 12 }) }))).rejects.toThrow(/host ABI 11; this runtime is ABI 12/);

    const broken = pocketFor();
    broken[40] ^= 0xff;
    await expect(repack3ds(await input({ pocket: broken }))).rejects.toThrow(/damaged: pocket package: hash mismatch/);

    const tampered = await runtimeFiles({ program: new Uint8Array(runtimeProgram()).fill(7, 40, 44) });
    await expect(repack3ds(await input({ runtime: tampered }))).rejects.toThrow(/not the file runtime.json describes/);
  });

  test("refuses a package for another app, target or a plan the runtime cannot run", async () => {
    await expect(repack3ds(await input({ identity: { id: "dev.pocket-nexus.other", title: "T", author: "A", version: "1" } })))
      .rejects.toThrow(/the identity says "dev.pocket-nexus.other"/);
    const pspOnly = encodePocketPackage({
      manifest: new TextEncoder().encode("{}"),
      variants: [{ target: "psp", hostAbi: 1, sections: [{ kind: POCKET_SECTION.js, bytes: new Uint8Array([0]) }] }],
    });
    await expect(repack3ds(await input({ pocket: pspOnly }))).rejects.toThrow(/no 3ds-dev variant \(it has psp\)/);
    const offload = pocketFor(manifest({ requires: ["io.offload"] }));
    await expect(repack3ds(await input({ pocket: offload }))).rejects.toThrow(/needs io.offload/);
    await expect(repack3ds(await input({ identity: { id: "nodots", title: "T", author: "A", version: "1" } })))
      .rejects.toThrow(/reverse-DNS/);
  });
});
