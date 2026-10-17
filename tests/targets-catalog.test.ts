import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { POCKET_TARGETS, type TargetProfile } from "../contracts/spec/platforms.ts";
import { validateAndResolveBuildPlan } from "../framework/src/manifest/resolve.ts";
import { CATALOG, COMMAND_WORDS, catalogEntry, catalogEntryForContract } from "../tools/targets/index.ts";
import { HOST_IDS, currentHost } from "../tools/targets/types.ts";
import { resolve3dsBuildPlan } from "../tools/3ds-profile.ts";
import { resolveMotoGPlayBuildPlan } from "../tools/moto-g-play-profile.ts";
import { resolveRedmi1sBuildPlan } from "../tools/redmi-1s-profile.ts";
import { BLACKBERRY_QNX_DEV_TARGET_ID, resolveBlackBerryClassicBuildPlan } from "../tools/blackberry-classic-profile.ts";
import { resolveMeizuM8BuildPlan } from "../tools/meizu-m8-profile.ts";
import { resolveSymbianE7BuildPlan } from "../tools/symbian-profile.ts";
import { resolveIPhone2GBuildPlan } from "../tools/iphone2g-profile.ts";
import { resolveIPhone4SBuildPlan } from "../tools/iphone4s-profile.ts";
import { resolveIPodTouchBuildPlan } from "../tools/ipodtouch-profile.ts";

const root = new URL("..", import.meta.url).pathname;
const readJson = (path: string) => JSON.parse(readFileSync(join(root, path), "utf8"));

/** The smallest manifest a target admits: its first logical viewport at its
 *  first presentation, or its dynamic range when it hosts no fixed viewport. */
function minimalManifest(profile: TargetProfile<string>): unknown {
  const display = profile.display;
  const viewport = display.dynamicViewport && !display.dynamicViewport.acceptsFixed
    ? { dynamic: { default: display.logicalViewports[0], min: display.dynamicViewport.min, max: display.dynamicViewport.max } }
    : { logical: display.logicalViewports[0], presentation: display.presentations[0] };
  return {
    $schema: "https://pocketjs.dev/schema/pocket-2.json",
    pocket: 2,
    id: "dev.example.catalog",
    name: "catalog",
    title: "Catalog",
    version: "0.1.0",
    engine: { capabilities: { requires: ["text.glyphs.baked"] } },
    app: { entry: "main.tsx", output: "catalog", framework: "solid", viewport },
  };
}

function resolveThroughCatalog(id: string, manifest: unknown) {
  const descriptor = catalogEntry(id)!;
  return validateAndResolveBuildPlan(manifest, { target: descriptor.contract.target }, descriptor.contract.registry());
}

describe("target catalog", () => {
  test("ids are unique kebab-case names that are not command words", () => {
    const ids = CATALOG.map((descriptor) => descriptor.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(COMMAND_WORDS).not.toContain(id);
    }
  });

  test("every registered target is in the catalog under its registry id", () => {
    for (const id of Object.keys(POCKET_TARGETS)) {
      expect(catalogEntry(id)?.contract).toMatchObject({ kind: "registry", target: id });
    }
  });

  test("every contract target exists in its registry and every host list is a known host", () => {
    for (const descriptor of CATALOG) {
      expect(Object.keys(descriptor.contract.registry().targets), descriptor.id).toContain(descriptor.contract.target);
      expect(descriptor.hosts.length, descriptor.id).toBeGreaterThan(0);
      for (const host of descriptor.hosts) expect(HOST_IDS).toContain(host);
    }
  });

  test("every target resolves its minimal manifest", () => {
    for (const descriptor of CATALOG) {
      const profile = descriptor.contract.registry().targets[descriptor.contract.target]!;
      const resolution = resolveThroughCatalog(descriptor.id, minimalManifest(profile));
      expect(resolution.ok, `${descriptor.id}: ${JSON.stringify(resolution.ok ? "" : resolution.diagnostics)}`).toBe(true);
      if (resolution.ok) expect(resolution.plan.target.id).toBe(descriptor.contract.target);
    }
  });

  test("catalog resolution equals each device profile's own resolver", () => {
    const cases: [string, string, (manifest: unknown) => { planHash: string }][] = [
      ["3ds", "apps/3ds-demo/pocket.json", resolve3dsBuildPlan],
      ["moto-g-play", "apps/clear/pocket.android.json", resolveMotoGPlayBuildPlan],
      ["redmi-1s", "apps/clear/pocket.redmi-1s.json", resolveRedmi1sBuildPlan],
      ["blackberry-classic", "apps/blackberry-classic-demo/pocket.json", (m) => resolveBlackBerryClassicBuildPlan(m, BLACKBERRY_QNX_DEV_TARGET_ID)],
      ["meizu-m8", "apps/meizu-m8-demo/pocket.json", resolveMeizuM8BuildPlan],
      ["nokia-e7", "apps/clear/pocket.symbian.json", resolveSymbianE7BuildPlan],
      ["iphone2g", "apps/iphone2g-demo/pocket.json", resolveIPhone2GBuildPlan],
      ["iphone4s", "apps/iphone4s-demo/pocket.json", resolveIPhone4SBuildPlan],
      ["ipodtouch6", "apps/ipodtouch-demo/pocket.json", resolveIPodTouchBuildPlan],
    ];
    for (const [id, manifestPath, resolver] of cases) {
      const manifest = readJson(manifestPath);
      const resolution = resolveThroughCatalog(id, manifest);
      expect(resolution.ok, id).toBe(true);
      if (resolution.ok) expect(resolution.plan.planHash, id).toBe(resolver(manifest).planHash);
    }
  });

  test("a contract id maps back to its catalog entry", () => {
    expect(catalogEntryForContract("3ds-dev")?.id).toBe("3ds");
    expect(catalogEntryForContract("symbian-e7-dev")?.id).toBe("nokia-e7");
    expect(catalogEntryForContract("psp")?.id).toBe("psp");
  });

  test("the host id names the operating system and CPU", () => {
    expect(currentHost("darwin", "arm64")).toBe("darwin-arm64");
    expect(currentHost("linux", "x64")).toBe("linux-x64");
    expect(currentHost("win32", "x64")).toBeNull();
    expect(currentHost("linux", "ia32")).toBeNull();
  });
});

describe("tools/pocket.ts and the catalog", () => {
  const pocket = (args: string[]) => {
    const result = Bun.spawnSync({ cmd: [process.execPath, join(root, "tools/pocket.ts"), ...args], cwd: root, stdout: "pipe", stderr: "pipe" });
    return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
  };

  test("catalog --json lists every target with its contract", () => {
    const result = pocket(["catalog", "--json"]);
    expect(result.code).toBe(0);
    const rows = JSON.parse(result.out);
    expect(rows.map((row: { id: string }) => row.id)).toEqual(CATALOG.map((descriptor) => descriptor.id));
    expect(rows.find((row: { id: string }) => row.id === "nokia-e7")).toEqual({
      id: "nokia-e7",
      title: "Nokia E7 (Symbian)",
      contract: { kind: "profile", target: "symbian-e7-dev" },
      hosts: ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"],
    });
  });

  test("a device target checks through its catalog id; its contract id points at the catalog id", () => {
    const checked = pocket(["check", "--target", "3ds", "--manifest", "apps/3ds-demo/pocket.json", "--project-root", "."]);
    expect(checked.code, checked.err).toBe(0);
    expect(checked.out).toContain("✓ 3ds-dev satisfies pocket.json capabilities");

    const contract = pocket(["check", "--target", "3ds-dev", "--manifest", "apps/3ds-demo/pocket.json", "--project-root", "."]);
    expect(contract.code).toBe(1);
    expect(contract.err).toContain("unknown target 3ds-dev; the catalog names this target 3ds");
  });
});
