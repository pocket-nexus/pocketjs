import { describe, expect, test } from "bun:test";
import {
  decodePocketPackage,
  encodePocketPackage,
  fnv1a64,
  type PocketPackageVariant,
} from "../contracts/spec/pocket-package.ts";
import { canonicalJson } from "../framework/src/manifest/plan.ts";
import { validateAndResolveBuildPlan } from "../framework/src/manifest/resolve.ts";
import { makeVariant } from "../tools/pocket-pack.ts";
import { PSP_ICON0, pbpParts, pbpWrite, pspFolder, repackPsp } from "../tools/repack/psp.ts";
import { decodePng, encodePng } from "../tools/repack/shared/png.ts";
import { sha256Hex, type RepackInput } from "../tools/repack/shared/runtime.ts";
import { readSfo, writeSfo } from "../tools/repack/shared/sfo.ts";
import { readZip as readEntries, unzipEntry } from "../tools/repack/shared/zip.ts";

/** Each entry of a zip with its unix mode and uncompressed data. */
async function readZip(bytes: Uint8Array) {
  return Promise.all(readEntries(bytes).map(async (entry) => ({ name: entry.name, mode: entry.unixMode, data: await unzipEntry(entry) })));
}

const ID = "dev.pocket-nexus.studio.snack-snake";
const DATA_PSP = new TextEncoder().encode("~PSP stand-in for the runtime's program");

function manifest(features: string[] = []) {
  return {
    $schema: "https://pocketjs.dev/schema/pocket-2.json",
    pocket: 2,
    id: ID,
    name: "snack-snake",
    title: "Snack Snake",
    version: "1.2.0",
    engine: { capabilities: { requires: ["text.glyphs.baked", ...features], enhances: ["input.buttons"] } },
    app: {
      entry: "main.tsx",
      output: "snack-snake",
      framework: "solid",
      viewport: { fixed: { logical: [480, 272], presentation: "integer-fit" } },
    },
  };
}

function variant(target: "psp" | "vita", source = manifest()): PocketPackageVariant {
  const resolution = validateAndResolveBuildPlan(source, { target });
  if (!resolution.ok) throw new Error(JSON.stringify(resolution.diagnostics));
  const plan = resolution.plan;
  return makeVariant({
    target,
    hostAbi: plan.target.hostAbi,
    planJson: canonicalJson(plan),
    identity: { output: plan.app.output, id: plan.app.id, title: plan.app.title },
    js: new TextEncoder().encode(`globalThis.frame = () => {}; // ${target}`),
    pak: new Uint8Array([target === "psp" ? 1 : 2, 2, 3, 4]),
  });
}

function pocketFor(targets: ("psp" | "vita")[] = ["psp", "vita"], source = manifest()): Uint8Array {
  return encodePocketPackage({
    manifest: new TextEncoder().encode(JSON.stringify(source)),
    variants: targets.map((target) => variant(target, source)),
  });
}

/** A runtime directory as tools/runtime/psp.ts writes it: cargo-psp's PARAM.SFO keys, no icon. */
async function runtime(overrides: { target?: string; hostAbi?: number; eboot?: Uint8Array } = {}): Promise<Map<string, Uint8Array>> {
  const sfo = writeSfo([
    { key: "BOOTABLE", value: 1 },
    { key: "CATEGORY", value: "MG" },
    { key: "DISC_ID", value: "UCJS10041" },
    { key: "DISC_VERSION", value: "1.00" },
    { key: "PARENTAL_LEVEL", value: 1 },
    { key: "PSP_SYSTEM_VER", value: "1.00" },
    { key: "REGION", value: 0x8000 },
    { key: "TITLE", value: "PocketJS Runtime" },
  ]);
  const empty = new Uint8Array(0);
  const eboot = pbpWrite([sfo, empty, empty, empty, empty, empty, DATA_PSP, empty]);
  const manifest = {
    target: overrides.target ?? "psp",
    hostAbi: overrides.hostAbi ?? 1,
    pocketjs: "0".repeat(40),
    profile: "psp",
    files: { "EBOOT.PBP": { bytes: eboot.length, sha256: await sha256Hex(eboot) } },
  };
  return new Map([
    ["EBOOT.PBP", overrides.eboot ?? eboot],
    ["runtime.json", new TextEncoder().encode(JSON.stringify(manifest))],
  ]);
}

/** A 64 x 64 icon: an opaque square on a transparent ground. */
async function icon(): Promise<Uint8Array> {
  const rgba = new Uint8Array(64 * 64 * 4);
  for (let y = 16; y < 48; y++) for (let x = 16; x < 48; x++) rgba.set([200, 40, 90, 255], (y * 64 + x) * 4);
  return encodePng({ width: 64, height: 64, rgba });
}

async function input(overrides: Partial<RepackInput> = {}): Promise<RepackInput> {
  return {
    runtime: await runtime(),
    pocket: pocketFor(),
    identity: { id: ID, title: "Snack Snake", author: "Pocket Nexus", version: "1.2.0", icon: await icon() },
    ...overrides,
  };
}

describe("PSP repack", () => {
  test("writes PSP/GAME/Studio<Name>/ with the retitled EBOOT and the thinned package", async () => {
    const zip = await readZip(await repackPsp(await input()));
    expect(zip.map((entry) => entry.name)).toEqual([
      "PSP/",
      "PSP/GAME/",
      "PSP/GAME/StudioSnackSnake/",
      "PSP/GAME/StudioSnackSnake/EBOOT.PBP",
      "PSP/GAME/StudioSnackSnake/app.pocket",
    ]);
    expect(zip.map((entry) => entry.mode)).toEqual([0o040755, 0o040755, 0o040755, 0o100644, 0o100644]);

    const parts = pbpParts(zip[3]!.data);
    expect(parts[6]).toEqual(DATA_PSP); // the program travels unchanged
    const sfo = Object.fromEntries(readSfo(parts[0]!).map((entry) => [entry.key, entry.value]));
    expect(sfo).toEqual({
      BOOTABLE: 1,
      CATEGORY: "MG",
      DISC_ID: "UCJS10041",
      DISC_VERSION: "1.00",
      MEMSIZE: 1,
      PARENTAL_LEVEL: 1,
      PSP_SYSTEM_VER: "1.00",
      REGION: 0x8000,
      TITLE: "Snack Snake",
    });
    expect(readSfo(parts[0]!).map((entry) => entry.key)).toEqual(Object.keys(sfo).sort());
    expect(readSfo(parts[0]!).find((entry) => entry.key === "TITLE")!.room).toBe(128);

    const icon0 = await decodePng(parts[1]!);
    expect([icon0.width, icon0.height]).toEqual([PSP_ICON0.width, PSP_ICON0.height]);
    // The square icon is fitted to 80 x 80 and centred: transparent at the sides, opaque in the middle.
    expect(icon0.rgba[(40 * 144 + 4) * 4 + 3]).toBe(0);
    expect([...icon0.rgba.subarray((40 * 144 + 72) * 4, (40 * 144 + 72) * 4 + 4)]).toEqual([200, 40, 90, 255]);

    const app = decodePocketPackage(zip[4]!.data);
    expect(app.variants.map((entry) => entry.target)).toEqual(["psp"]);
    const original = decodePocketPackage(pocketFor()).variants.find((entry) => entry.target === "psp")!;
    expect(fnv1a64(...app.variants[0]!.sections.map((s) => s.bytes))).toBe(fnv1a64(...original.sections.map((s) => s.bytes)));
  });

  test("the same inputs give the same bytes", async () => {
    const a = await repackPsp(await input());
    const b = await repackPsp(await input());
    expect(a).toEqual(b);
  });

  test("keeps the runtime's empty icon when the identity has none", async () => {
    const zip = await readZip(await repackPsp(await input({ identity: { ...(await input()).identity, icon: undefined } })));
    expect(pbpParts(zip[3]!.data)[1]!.length).toBe(0);
  });

  test("refuses a runtime for another target", async () => {
    await expect(repackPsp(await input({ runtime: await runtime({ target: "vita" }) }))).rejects.toThrow('this runtime is for "vita", not "psp"');
  });

  test("refuses a host ABI the runtime does not have", async () => {
    await expect(repackPsp(await input({ runtime: await runtime({ hostAbi: 2 }) }))).rejects.toThrow(
      "the .pocket's psp variant is for host ABI 1; this runtime is ABI 2",
    );
  });

  test("refuses a broken footer", async () => {
    const broken = pocketFor();
    broken[broken.length - 20]! ^= 0xff;
    await expect(repackPsp(await input({ pocket: broken }))).rejects.toThrow("the .pocket is damaged: pocket package: hash mismatch");
  });

  test("refuses a package without a psp variant", async () => {
    await expect(repackPsp(await input({ pocket: pocketFor(["vita"]) }))).rejects.toThrow("the .pocket has no psp variant (it has vita)");
  });

  test("refuses a runtime whose EBOOT is not the one runtime.json describes", async () => {
    await expect(repackPsp(await input({ runtime: await runtime({ eboot: DATA_PSP }) }))).rejects.toThrow(
      "the runtime's EBOOT.PBP is not the file runtime.json describes",
    );
  });

  test("refuses a plan that asks for io.offload", async () => {
    const offload = manifest(["io.offload"]);
    const pocket = encodePocketPackage({ manifest: new TextEncoder().encode(JSON.stringify(offload)), variants: [variant("psp", offload)] });
    await expect(repackPsp(await input({ pocket }))).rejects.toThrow("the plan asks for io.offload");
  });

  test("names the folder from the title, then the id", async () => {
    expect(await pspFolder({ id: "dev.pocket-nexus.studio.twenty48", title: "Twenty48" })).toBe("StudioTwenty48");
    expect(await pspFolder({ id: ID, title: "snack  snake!" })).toBe("StudioSnackSnake");
    expect(await pspFolder({ id: "dev.pocket-nexus.studio.tetris", title: "テトリス" })).toBe("StudioTetris");
  });

  test("cuts a long title to 127 bytes of UTF-8 without splitting a character", async () => {
    const base = await input();
    const zip = await readZip(await repackPsp({ ...base, identity: { ...base.identity, title: "é".repeat(100) } }));
    const value = readSfo(pbpParts(zip[3]!.data)[0]!).find((entry) => entry.key === "TITLE")!.value;
    expect(value).toBe("é".repeat(63));
  });
});
