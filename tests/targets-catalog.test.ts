import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { POCKET_TARGETS, type TargetProfile } from "../contracts/spec/platforms.ts";
import { validateAndResolveBuildPlan } from "../framework/src/manifest/resolve.ts";
import { CATALOG, COMMAND_WORDS, catalogEntry, catalogEntryForContract } from "../tools/targets/index.ts";
import { POCKET_PROFILES } from "../profiles/index.ts";
import { HOST_IDS, currentHost } from "../tools/targets/types.ts";
import { resolve3dsBuildPlan } from "../tools/3ds-profile.ts";

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
  test("toolchain ids are unique kebab-case names; PSP and Vita also have deployment commands", () => {
    const ids = CATALOG.map((descriptor) => descriptor.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      if (COMMAND_WORDS.includes(id)) expect(["psp", "vita"]).toContain(id);
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
    expect(catalogEntryForContract("symbian-e7-dev")).toBeUndefined();
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

  test("catalog --json lists software profile ids and platforms", () => {
    const result = pocket(["catalog", "--json"]);
    expect(result.code).toBe(0);
    const rows = JSON.parse(result.out);
    expect(rows.map((row: { id: string }) => row.id)).toEqual(Object.keys(POCKET_PROFILES));
    expect(rows.some((row: { id: string }) => row.id === "symbian-e7-dev")).toBe(false);
  });

  test("application compilation selects the actual profile id, not a toolchain alias", () => {
    const checked = pocket(["check", "--target", "3ds-dev", "--manifest", "apps/3ds-demo/pocket.json", "--project-root", "."]);
    expect(checked.code, checked.err).toBe(0);
    expect(checked.out).toContain("✓ 3ds-dev satisfies pocket.json capabilities");

    const contract = pocket(["check", "--target", "3ds", "--manifest", "apps/3ds-demo/pocket.json", "--project-root", "."]);
    expect(contract.code).toBe(1);
    expect(contract.err).toContain("unknown profile or module 3ds");
  });
});
