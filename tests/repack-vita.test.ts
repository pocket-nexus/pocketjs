import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { decodePocketPackage, encodePocketPackage, type PocketPackageVariant } from "../contracts/spec/pocket-package.ts";
import { vitaTitleId } from "../framework/src/manifest/vita-package.ts";
import { canonicalJson } from "../framework/src/manifest/plan.ts";
import { validateAndResolveBuildPlan } from "../framework/src/manifest/resolve.ts";
import { makeVariant } from "../tools/pocket-pack.ts";
import { decodePng, encodePng } from "../tools/repack/shared/png.ts";
import { sha256Hex, type RepackInput } from "../tools/repack/shared/runtime.ts";
import { readSfo } from "../tools/repack/shared/sfo.ts";
import { readZip as readEntries, unzipEntry } from "../tools/repack/shared/zip.ts";
import { repackVita, VITA_ICON, VITA_LIVEAREA, vitaSfo, vitaTitleIdFor } from "../tools/repack/vita.ts";
import { DEFAULT_VITA_PACKAGE_ASSETS, resolveVitaPackageAssets } from "../tools/vita-package.ts";

const ROOT = join(import.meta.dir, "..");

/** Each entry of a zip with its uncompressed data. */
async function readZip(bytes: Uint8Array) {
  return Promise.all(readEntries(bytes).map(async (entry) => ({ name: entry.name, data: await unzipEntry(entry) })));
}
const ID = "dev.pocket-nexus.studio.twenty48";
const EBOOT = new TextEncoder().encode("SCE\0 stand-in for the runtime's eboot.bin");

// vita-mksfoex (VitaSDK) for `-d ATTRIBUTE2=12 -s TITLE_ID=P8963CCB6 "Twenty48 二〇四八"`,
// the command tools/vita.ts runs for a game with that title and id.
const MKSFOEX = new Uint8Array(readFileSync(join(ROOT, "tests/fixtures/repack-vita/vita-mksfoex.sfo")));

function manifest() {
  return {
    $schema: "https://pocketjs.dev/schema/pocket-2.json",
    pocket: 2,
    id: ID,
    name: "twenty48",
    title: "Twenty48",
    version: "0.1.0",
    engine: { capabilities: { requires: ["text.glyphs.baked"], enhances: ["input.buttons"] } },
    app: { entry: "main.tsx", output: "twenty48", framework: "solid", viewport: { fixed: { logical: [480, 272], presentation: "integer-fit" } } },
  };
}

function variant(target: "psp" | "vita", id = ID): PocketPackageVariant {
  const resolution = validateAndResolveBuildPlan({ ...manifest(), id }, { target });
  if (!resolution.ok) throw new Error(JSON.stringify(resolution.diagnostics));
  const plan = resolution.plan;
  return makeVariant({
    target,
    hostAbi: plan.target.hostAbi,
    planJson: canonicalJson(plan),
    identity: { output: plan.app.output, id: plan.app.id, title: plan.app.title },
    js: new TextEncoder().encode(`globalThis.frame = () => {}; // ${target}`),
    pak: new Uint8Array([target === "vita" ? 2 : 1, 2, 3, 4]),
  });
}

function pocketFor(targets: ("psp" | "vita")[] = ["psp", "vita"], id = ID): Uint8Array {
  return encodePocketPackage({ manifest: new TextEncoder().encode(JSON.stringify({ ...manifest(), id })), variants: targets.map((t) => variant(t, id)) });
}

const RUNTIME_ASSETS = [VITA_ICON, ...VITA_LIVEAREA];

/** A runtime directory as tools/runtime/vita.ts writes it, with PocketJS's default LiveArea files. */
async function runtime(overrides: { target?: string; hostAbi?: number } = {}): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>([["eboot.bin", EBOOT]]);
  for (const name of RUNTIME_ASSETS) files.set(name, new Uint8Array(readFileSync(join(DEFAULT_VITA_PACKAGE_ASSETS, name))));
  const listed: Record<string, { bytes: number; sha256: string }> = {};
  for (const [name, bytes] of files) listed[name] = { bytes: bytes.length, sha256: await sha256Hex(bytes) };
  const manifest = { target: overrides.target ?? "vita", hostAbi: overrides.hostAbi ?? 2, pocketjs: "0".repeat(40), profile: "vita", files: listed };
  files.set("runtime.json", new TextEncoder().encode(JSON.stringify(manifest)));
  return files;
}

/** A 96 x 96 icon: a gradient square on a transparent ground. */
async function icon(): Promise<Uint8Array> {
  const rgba = new Uint8Array(96 * 96 * 4);
  for (let y = 8; y < 88; y++) for (let x = 8; x < 88; x++) rgba.set([x * 2, y * 2, 200, 255], (y * 96 + x) * 4);
  return encodePng({ width: 96, height: 96, rgba });
}

async function input(overrides: Partial<RepackInput> = {}): Promise<RepackInput> {
  return {
    runtime: await runtime(),
    pocket: pocketFor(),
    identity: { id: ID, title: "Twenty48 二〇四八", author: "Pocket Nexus", version: "0.1.0", icon: await icon() },
    ...overrides,
  };
}

describe("PS Vita repack", () => {
  test("the title id follows PocketJS's rule", async () => {
    expect(await vitaTitleIdFor(ID)).toBe(vitaTitleId(ID));
    expect(await vitaTitleIdFor(ID)).toBe("P8963CCB6");
  });

  test("param.sfo is byte for byte what vita-mksfoex writes for tools/vita.ts", () => {
    expect(vitaSfo("Twenty48 二〇四八", "P8963CCB6")).toEqual(MKSFOEX);
  });

  test("writes files only, param.sfo and eboot.bin first, with the runtime's LiveArea and the thinned package", async () => {
    const vpk = await readZip(await repackVita(await input()));
    expect(vpk.map((entry) => entry.name)).toEqual([
      "sce_sys/param.sfo",
      "eboot.bin",
      "app.pocket",
      "sce_sys/icon0.png",
      ...VITA_LIVEAREA,
    ]);
    const file = (name: string) => vpk.find((entry) => entry.name === name)!.data;
    expect(file("eboot.bin")).toEqual(EBOOT);
    expect(file("sce_sys/param.sfo")).toEqual(MKSFOEX);
    const sfo = Object.fromEntries(readSfo(file("sce_sys/param.sfo")).map((entry) => [entry.key, entry.value]));
    expect([sfo.TITLE, sfo.STITLE, sfo.TITLE_ID, sfo.ATTRIBUTE2, sfo.CATEGORY]).toEqual(["Twenty48 二〇四八", "Twenty48 二〇四八", "P8963CCB6", 12, "gd"]);
    for (const name of VITA_LIVEAREA) expect(file(name)).toEqual(new Uint8Array(readFileSync(join(DEFAULT_VITA_PACKAGE_ASSETS, name))));
    expect(decodePocketPackage(file("app.pocket")).variants.map((v) => v.target)).toEqual(["vita"]);

    // The bubble: 128 x 128 indexed PNG-8, the gradient centred over the plum ground.
    const png = file("sce_sys/icon0.png");
    expect([...png.subarray(24, 29)]).toEqual([8, 3, 0, 0, 0]);
    const bubble = await decodePng(png);
    expect([bubble.width, bubble.height]).toEqual([128, 128]);
    expect([...bubble.rgba.subarray(0, 4)]).toEqual([0x17, 0x12, 0x26, 255]);
    expect(bubble.rgba[(64 * 128 + 64) * 4 + 2]).toBeGreaterThan(150);

    // tools/vita-package.ts's checks (sizes, indexed PNG-8, template.xml) on the unpacked VPK.
    const directory = mkdtempSync(join(tmpdir(), "repack-vita-"));
    try {
      for (const entry of vpk) {
        mkdirSync(dirname(join(directory, entry.name)), { recursive: true });
        writeFileSync(join(directory, entry.name), entry.data);
      }
      expect(resolveVitaPackageAssets({ applicationAssets: directory }).length).toBe(7);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("the same inputs give the same bytes", async () => {
    expect(await repackVita(await input())).toEqual(await repackVita(await input()));
  });

  test("keeps the runtime's bubble when the identity has no icon", async () => {
    const base = await input();
    const vpk = await readZip(await repackVita({ ...base, identity: { ...base.identity, icon: undefined } }));
    expect(vpk.find((entry) => entry.name === VITA_ICON)!.data).toEqual(new Uint8Array(readFileSync(join(DEFAULT_VITA_PACKAGE_ASSETS, VITA_ICON))));
  });

  test("cuts a long title to STITLE's 51 and TITLE's 127 bytes without splitting a character", () => {
    const sfo = Object.fromEntries(readSfo(vitaSfo("二".repeat(60), "P8963CCB6")).map((entry) => [entry.key, entry.value]));
    expect([sfo.STITLE, sfo.TITLE]).toEqual(["二".repeat(17), "二".repeat(42)]);
  });

  test("refuses a runtime for another target", async () => {
    await expect(repackVita(await input({ runtime: await runtime({ target: "psp" }) }))).rejects.toThrow('this runtime is for "psp", not "vita"');
  });

  test("refuses a host ABI the runtime does not have", async () => {
    await expect(repackVita(await input({ runtime: await runtime({ hostAbi: 1 }) }))).rejects.toThrow(
      "the .pocket's vita variant is for host ABI 2; this runtime is ABI 1",
    );
  });

  test("refuses a broken footer", async () => {
    const broken = pocketFor();
    broken[broken.length - 20]! ^= 0xff;
    await expect(repackVita(await input({ pocket: broken }))).rejects.toThrow("the .pocket is damaged");
  });

  test("refuses a package without a vita variant, and another app's package", async () => {
    await expect(repackVita(await input({ pocket: pocketFor(["psp"]) }))).rejects.toThrow("the .pocket has no vita variant (it has psp)");
    await expect(repackVita(await input({ pocket: pocketFor(["vita"], "dev.pocket-nexus.studio.other") }))).rejects.toThrow(
      'the .pocket is app "dev.pocket-nexus.studio.other"',
    );
  });
});
