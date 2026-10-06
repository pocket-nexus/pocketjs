import { describe, expect, test } from "bun:test";
import { encodePocketPackage, encodeIdentity, POCKET_SECTION } from "../contracts/spec/pocket-package.ts";
import { canonicalJson } from "../framework/src/manifest/plan.ts";
import { resolveIPodTouch4BuildPlan } from "../tools/ipodtouch4-profile.ts";
import { makeVariant } from "../tools/pocket-pack.ts";
import { bundleBaseName, bundleVersion, IPOD_RUNTIME_EXECUTABLE, repackIPod } from "../tools/repack/ipod.ts";
import { decodePng, encodePng } from "../tools/repack/shared/png.ts";
import { sha256Hex, type RepackInput } from "../tools/repack/shared/runtime.ts";
import { readZip, unzipEntry } from "../tools/repack/shared/zip.ts";

const ID = "dev.pocket-nexus.studio.twenty48";

function manifest(viewport: [number, number] = [320, 480], companions: string[] = []) {
  return {
    $schema: "https://pocketjs.dev/schema/pocket-2.json",
    pocket: 2,
    id: ID,
    name: "twenty48",
    title: "Twenty48",
    version: "0.1.0",
    engine: { capabilities: { requires: ["text.glyphs.baked"], enhances: ["input.touch"] } },
    app: {
      entry: "main.tsx",
      output: "twenty48",
      framework: "solid",
      viewport: { fixed: { logical: viewport, presentation: "native" } },
      ...(companions.length ? { companions } : {}),
    },
  };
}

function pocketFor(source: object = manifest()): Uint8Array {
  const plan = resolveIPodTouch4BuildPlan(source);
  return encodePocketPackage({
    manifest: new TextEncoder().encode(JSON.stringify(source)),
    variants: [
      makeVariant({
        target: plan.target.id,
        hostAbi: plan.target.hostAbi,
        planJson: canonicalJson(plan),
        identity: { output: plan.app.output, id: plan.app.id, title: plan.app.title },
        js: new TextEncoder().encode("globalThis.frame = () => {};"),
        pak: new Uint8Array([1, 2, 3, 4]),
      }),
    ],
  });
}

const square = (size: number, rgba: [number, number, number, number]) =>
  encodePng({ width: size, height: size, rgba: new Uint8Array(size * size * 4).map((_, i) => rgba[i % 4]!) });

async function runtimeFiles(overrides: { target?: string; hostAbi?: number; host?: object } = {}) {
  const files = new Map<string, Uint8Array>([
    [IPOD_RUNTIME_EXECUTABLE, new Uint8Array(4096).map((_, i) => (i * 31) & 255)],
    ["Icon.png", await square(57, [1, 2, 3, 255])],
    ["Icon@2x.png", await square(114, [1, 2, 3, 255])],
    ["Default@2x.png", await square(8, [0, 0, 0, 255])],
    ["Default-568h@2x.png", await square(8, [0, 0, 0, 255])],
    ["PkgInfo", new TextEncoder().encode("APPL????")],
  ]);
  const listed: Record<string, { bytes: number; sha256: string }> = {};
  for (const [name, bytes] of files) listed[name] = { bytes: bytes.length, sha256: await sha256Hex(bytes) };
  files.set("runtime.json", new TextEncoder().encode(JSON.stringify({
    target: overrides.target ?? "ipodtouch4-dev",
    hostAbi: overrides.hostAbi ?? 8,
    pocketjs: "0".repeat(40),
    profile: "ipodtouch4-dev",
    files: listed,
    host: overrides.host ?? { buildId: "0123456789abcdef0123456789abcdef", executable: IPOD_RUNTIME_EXECUTABLE, deploymentTarget: "6.0" },
  })));
  return files;
}

async function input(overrides: Partial<RepackInput> = {}): Promise<RepackInput> {
  return {
    runtime: await runtimeFiles(),
    pocket: pocketFor(),
    identity: { id: ID, title: "Twenty48", author: "Pocket Nexus", version: "0.1.0", icon: await square(256, [255, 210, 63, 255]) },
    ...overrides,
  };
}

async function entries(ipa: Uint8Array) {
  const out = new Map<string, { bytes: Uint8Array; mode: number; method: number }>();
  for (const entry of readZip(ipa)) {
    out.set(entry.name, { bytes: await unzipEntry(entry), mode: entry.unixMode ?? 0, method: entry.method });
  }
  return out;
}

describe("repackIPod", () => {
  test("writes Payload/Studio<Name>.app with the runtime's executable, a new Info.plist, icons and app.pocket", async () => {
    const repackInput = await input();
    const ipa = await repackIPod(repackInput);
    const files = await entries(ipa);
    const app = "Payload/StudioTwenty48.app/";
    const names = [...files.keys()];
    expect(names.slice(0, 2)).toEqual(["Payload/", app]);
    const executable = files.get(`${app}StudioTwenty48`)!;
    expect(executable.bytes).toEqual(repackInput.runtime.get(IPOD_RUNTIME_EXECUTABLE)!);
    expect(executable.mode & 0o777).toBe(0o755);
    expect(files.get(`${app}app.pocket`)!.bytes).toEqual(repackInput.pocket);
    expect(files.get(`${app}PkgInfo`)!.bytes).toEqual(new TextEncoder().encode("APPL????"));

    const plist = new TextDecoder().decode(files.get(`${app}Info.plist`)!.bytes);
    for (const [key, value] of [
      ["CFBundleIdentifier", ID], ["CFBundleExecutable", "StudioTwenty48"], ["CFBundleDisplayName", "Twenty48"],
      ["CFBundleShortVersionString", "0.1.0"], ["CFBundleVersion", "0.1.0"], ["MinimumOSVersion", "6.0"],
    ]) expect(plist).toContain(`<key>${key}</key>\n  <string>${value}</string>`);
    expect(plist).toContain(`<string>${ID}</string>\n      </array>`);

    const icon = names.find((name) => /Icon-[0-9a-f]{8}\.png$/.test(name))!;
    const retina = icon.replace(".png", "@2x.png");
    expect(plist).toContain(`<string>${icon.slice(app.length)}</string>`);
    const small = await decodePng(files.get(icon)!.bytes);
    const large = await decodePng(files.get(retina)!.bytes);
    expect([small.width, large.width]).toEqual([57, 114]);
    expect(Array.from(small.rgba.subarray(0, 4))).toEqual([255, 210, 63, 255]);

    const receipt = JSON.parse(new TextDecoder().decode(files.get(`${app}build-receipt.json`)!.bytes));
    expect(receipt).toMatchObject({ schema: 1, buildId: "0123456789abcdef0123456789abcdef", bundleId: ID, target: "ipodtouch4-dev", hostAbi: 8, deploymentTarget: "6.0" });
    expect(receipt.viewport).toEqual({ logical: [320, 480], physical: [640, 960], rasterDensity: 2 });
    for (const [name, digest] of Object.entries(receipt.files)) {
      expect(await sha256Hex(files.get(app + name)!.bytes)).toBe(digest as string);
    }
    expect(Object.keys(receipt.files)).toHaveLength(names.length - 3);
  });

  test("is deterministic, and keeps the runtime's icons when the identity has none", async () => {
    expect(await repackIPod(await input())).toEqual(await repackIPod(await input()));
    const plain = await input({ identity: { id: ID, title: "Twenty48", author: "Pocket Nexus", version: "0.1.0" } });
    const files = await entries(await repackIPod(plain));
    const icon = [...files.keys()].find((name) => /Icon-[0-9a-f]{8}\.png$/.test(name))!;
    expect(files.get(icon)!.bytes).toEqual(plain.runtime.get("Icon.png")!);
  });

  test("names bundles as pocket-studio does and takes the numeric version for CFBundleVersion", () => {
    expect(bundleBaseName({ title: "Snack Snake", id: "dev.x.snack" })).toBe("StudioSnackSnake");
    expect(bundleBaseName({ title: "二〇四八", id: "dev.x.twenty48" })).toBe("StudioTwenty48");
    expect(bundleVersion("1.2.0-beta.3")).toBe("1.2.0");
    expect(bundleVersion("next")).toBe("0");
  });

  test("refuses another target's runtime, a wrong host ABI, a broken footer and plans it cannot run", async () => {
    await expect(repackIPod(await input({ runtime: await runtimeFiles({ target: "3ds-dev" }) }))).rejects.toThrow(/not "ipodtouch4-dev"/);
    await expect(repackIPod(await input({ runtime: await runtimeFiles({ hostAbi: 9 }) }))).rejects.toThrow(/host ABI 8; this runtime is ABI 9/);
    await expect(repackIPod(await input({ runtime: await runtimeFiles({ host: {} }) }))).rejects.toThrow(/no host build id/);
    const broken = pocketFor();
    broken[64] ^= 1;
    await expect(repackIPod(await input({ pocket: broken }))).rejects.toThrow(/hash mismatch/);
    const other = encodePocketPackage({
      manifest: new TextEncoder().encode("{}"),
      variants: [{ target: "ipodtouch4-dev", hostAbi: 8, sections: [
        { kind: POCKET_SECTION.identity, bytes: encodeIdentity({ output: "x", id: "dev.other.game", title: "X" }) },
        { kind: POCKET_SECTION.plan, bytes: new TextEncoder().encode("{}") },
        { kind: POCKET_SECTION.js, bytes: new Uint8Array([0]) },
      ] }],
    });
    await expect(repackIPod(await input({ pocket: other }))).rejects.toThrow(/identity says/);
    await expect(repackIPod(await input({ pocket: pocketFor(manifest([320, 480], ["shell"])) }))).rejects.toThrow(/companion services/);
  });

  test("lands a landscape plan's surface in the receipt", async () => {
    const files = await entries(await repackIPod(await input({ pocket: pocketFor(manifest([480, 320])) })));
    const receipt = JSON.parse(new TextDecoder().decode(files.get("Payload/StudioTwenty48.app/build-receipt.json")!.bytes));
    expect(receipt.viewport.logical).toEqual([480, 320]);
  });
});

describe("the .ipa zip", () => {
  test("stores directories and PNGs, deflates the rest, and gives the executable 0755", async () => {
    const files = await entries(await repackIPod(await input()));
    const app = "Payload/StudioTwenty48.app/";
    expect(files.get("Payload/")!.mode).toBe(0o040755);
    expect(files.get(`${app}StudioTwenty48`)!.mode).toBe(0o100755);
    expect(files.get(`${app}Info.plist`)!.mode).toBe(0o100644);
    expect(files.get(`${app}Info.plist`)!.method).toBe(8);
    for (const [name, entry] of files) if (name.endsWith(".png")) expect(entry.method).toBe(0);
  });
});
