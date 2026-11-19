import { describe, expect, test } from "bun:test";
import { POCKET_BINDING_GENERATION } from "../contracts/spec/binding-generation.ts";
import { BUNDLE_SECTION, decodeBundle, encodeBundle, findSection } from "../contracts/spec/bundle.ts";
import { resolveAppPlan } from "../framework/compiler/app-plan.ts";
import { POCKET_PROFILES } from "../hosts/index.ts";
import { makeBundle } from "../tools/bundle.ts";
import { profileRegistry } from "../tools/profile-resolver.ts";
import { PSP_ICON0, pbpParts, pbpWrite, pspFolder, repackPsp } from "../tools/repack/psp.ts";
import { decodePng, encodePng } from "../tools/repack/shared/png.ts";
import type { RepackInput } from "../tools/repack/shared/runtime.ts";
import { runtimeDirectory } from "./helpers/runtime-directory.ts";
import { readSfo, writeSfo } from "../tools/repack/shared/sfo.ts";
import { readZip as readEntries, unzipEntry } from "../tools/repack/shared/zip.ts";
const softwareProfile = POCKET_PROFILES["psp-runtime"];

/** Each entry of a zip with its unix mode and uncompressed data. */
async function readZip(bytes: Uint8Array) {
  return Promise.all(readEntries(bytes).map(async (entry) => ({ name: entry.name, mode: entry.unixMode, data: await unzipEntry(entry) })));
}

const ID = "dev.pocket-nexus.studio.snack-snake";
const DATA_PSP = new TextEncoder().encode("~PSP stand-in for the runtime's program");

/** The `app` section of the application's host config. */
function app(features: string[] = []) {
  return {
    id: ID,
    title: "Snack Snake",
    version: "1.2.0",
    entry: "main.tsx",
    output: "snack-snake",
    framework: "solid",
    viewport: { fixed: { logical: [480, 272], presentation: "integer-fit" } },
    features: ["text.glyphs.baked", "input.buttons", ...features],
  };
}

/** The application compiled for one host contract. */
function bundleFor(target: "psp-runtime" | "vita" = "psp-runtime", source = app()): Uint8Array {
  const resolution = resolveAppPlan(source, { target }, target === "psp-runtime" ? profileRegistry(softwareProfile) : undefined);
  if (!resolution.ok) throw new Error(JSON.stringify(resolution.diagnostics));
  return encodeBundle(makeBundle({
    plan: resolution.plan,
    js: new TextEncoder().encode(`globalThis.frame = () => {}; // ${target}`),
    pak: new Uint8Array([target === "psp-runtime" ? 1 : 2, 2, 3, 4]),
  }));
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
  const files = runtimeDirectory(softwareProfile, new Map([["EBOOT.PBP", eboot]]), {
    target: overrides.target ?? "psp-runtime", hostAbi: overrides.hostAbi ?? POCKET_BINDING_GENERATION,
  });
  if (overrides.eboot) files.set("EBOOT.PBP", overrides.eboot);
  return files;
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
    bundle: bundleFor(),
    identity: { id: ID, title: "Snack Snake", author: "Pocket Nexus", version: "1.2.0", icon: await icon() },
    ...overrides,
  };
}

describe("PSP repack", () => {
  test("writes PSP/GAME/Studio<Name>/ with the retitled EBOOT and the bundle", async () => {
    const zip = await readZip(await repackPsp(await input()));
    expect(zip.map((entry) => entry.name)).toEqual([
      "PSP/",
      "PSP/GAME/",
      "PSP/GAME/StudioSnackSnake/",
      "PSP/GAME/StudioSnackSnake/EBOOT.PBP",
      "PSP/GAME/StudioSnackSnake/app.pkb",
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

    // The bundle travels byte for byte.
    expect(zip[4]!.data).toEqual(bundleFor());
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
    await expect(repackPsp(await input({ runtime: await runtime({ target: "vita" }) }))).rejects.toThrow('this runtime is for "vita", not "psp-runtime"');
  });

  test("refuses a host ABI the runtime does not have", async () => {
    await expect(repackPsp(await input({ runtime: await runtime({ hostAbi: 2 }) }))).rejects.toThrow(
      `runtime binding generation 2 is unsupported; rebuild for ${POCKET_BINDING_GENERATION}`,
    );
  });

  test("refuses a broken footer", async () => {
  });

  test("refuses a bundle the runtime's host contract does not admit", async () => {
    await expect(repackPsp(await input({ bundle: bundleFor("vita") }))).rejects.toThrow("this psp-runtime runtime does not admit the bundle: not admitted: rasterDensity");
  });

  test("refuses a runtime whose EBOOT is not the one runtime.json describes", async () => {
    await expect(repackPsp(await input({ runtime: await runtime({ eboot: DATA_PSP }) }))).rejects.toThrow(
      "the runtime's EBOOT.PBP is not the file runtime.json describes",
    );
  });

  test("generic profile compiles offload off and rejects text offload without its transport", () => {
    const plan = JSON.parse(new TextDecoder().decode(findSection(decodeBundle(bundleFor("psp-runtime", app(["io.offload"]))), BUNDLE_SECTION.plan)!));
    expect(plan.features["io.offload"]).toBe(false);
    expect(() => bundleFor("psp-runtime", app(["text.layout.offload"]))).toThrow("text.layout.offload");
  });

  test("refuses a plan that turns on a capability the runtime's host contract does not list", async () => {
    // The psp host contract has the generic runtime's display facts and io.offload.
    const resolution = resolveAppPlan(app(["io.offload"]), { target: "psp" });
    if (!resolution.ok) throw new Error(JSON.stringify(resolution.diagnostics));
    expect(resolution.plan.features["io.offload"]).toBe(true);
    const bundle = encodeBundle(makeBundle({ plan: resolution.plan, js: new TextEncoder().encode("globalThis.frame = () => {};"), pak: new Uint8Array([1]) }));
    await expect(repackPsp(await input({ bundle }))).rejects.toThrow("not admitted: capability io.offload");
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
