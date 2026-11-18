import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { AppConfig } from "../contracts/spec/app-config.ts";
import { POCKET_TARGETS, type TargetProfile } from "../contracts/spec/platforms.ts";
import { resolveAppPlan } from "../framework/compiler/app-plan.ts";
import { POCKET_PROFILES } from "../hosts/index.ts";
import { loadHostConfig } from "../tools/profile-resolver.ts";
import { resolveIPodTouchBuildPlan } from "../tools/ipodtouch-profile.ts";
import { resolveSymbianE7BuildPlan } from "../tools/symbian-profile.ts";
import { CATALOG, COMMAND_WORDS, catalogEntry, catalogEntryForContract } from "../tools/targets/index.ts";
import { HOST_IDS, currentHost } from "../tools/targets/types.ts";

const root = new URL("..", import.meta.url).pathname;
/** The `app` section of a committed application's host config. */
const appOf = async (path: string): Promise<AppConfig> => (await loadHostConfig(join(root, path))).value.app!;

/** The smallest application a target hosts: its first logical viewport at its
 *  first presentation, or its dynamic range when it hosts no fixed viewport. */
function minimalApp(profile: TargetProfile<string>): unknown {
  const display = profile.display;
  const viewport = display.dynamicViewport && !display.dynamicViewport.acceptsFixed
    ? { dynamic: { default: display.logicalViewports[0], min: display.dynamicViewport.min, max: display.dynamicViewport.max } }
    : { logical: display.logicalViewports[0], presentation: display.presentations[0] };
  return {
    id: "dev.example.catalog",
    title: "Catalog",
    version: "0.1.0",
    features: ["text.glyphs.baked"],
    entry: "main.tsx", output: "catalog", framework: "solid", viewport,
  };
}

function resolveThroughCatalog(id: string, app: unknown) {
  const descriptor = catalogEntry(id)!;
  return resolveAppPlan(app, { target: descriptor.contract.target }, descriptor.contract.registry());
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

  test("every target resolves its minimal application", () => {
    for (const descriptor of CATALOG) {
      const profile = descriptor.contract.registry().targets[descriptor.contract.target]!;
      const resolution = resolveThroughCatalog(descriptor.id, minimalApp(profile));
      expect(resolution.ok, `${descriptor.id}: ${JSON.stringify(resolution.ok ? "" : resolution.diagnostics)}`).toBe(true);
      if (resolution.ok) expect(resolution.plan.target.id).toBe(descriptor.contract.target);
    }
  });

  test("catalog resolution equals each device profile's own resolver", async () => {
    const cases: [string, string, (app: unknown) => ReturnType<typeof resolveSymbianE7BuildPlan>][] = [
      ["nokia-e7", "apps/clear/pocket.host.config.ts", resolveSymbianE7BuildPlan],
      ["ipodtouch6", "apps/ipodtouch-demo/pocket.host.config.ts", resolveIPodTouchBuildPlan],
    ];
    for (const [id, configPath, resolver] of cases) {
      const app = await appOf(configPath);
      const resolution = resolveThroughCatalog(id, app);
      expect(resolution.ok, id).toBe(true);
      if (resolution.ok) expect(resolution.plan.viewport, id).toEqual(resolver(app).viewport);
    }
  });

  test("the 3ds entry resolves the dual-screen demo against the file-loaded program's contract", async () => {
    const resolution = resolveThroughCatalog("3ds", await appOf("apps/3ds-demo/pocket.host.config.ts"));
    expect(resolution.ok, JSON.stringify(resolution.ok ? "" : resolution.diagnostics)).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.plan.target.id).toBe("3ds-runtime");
    expect(resolution.plan.viewport.logical).toEqual([400, 240]);
    expect(resolution.plan.surfaces?.auxiliary.logical).toEqual([320, 240]);
  });

  test("a contract id maps back to its catalog entry", () => {
    expect(catalogEntryForContract("3ds-runtime")?.id).toBe("3ds");
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

  test("catalog --json lists software profile ids and platforms", () => {
    const result = pocket(["catalog", "--json"]);
    expect(result.code).toBe(0);
    const rows = JSON.parse(result.out);
    expect(rows.map((row: { id: string }) => row.id)).toEqual(Object.keys(POCKET_PROFILES));
    expect(rows.find((row: { id: string }) => row.id === "symbian-e7-dev")).toEqual({
      id: "symbian-e7-dev",
      title: "Nokia E7 (Symbian)",
      platform: "symbian",
    });
  });

  test("application compilation selects the actual profile id, not a toolchain alias", () => {
    const checked = pocket(["check", "--target", "3ds-runtime", "--config", "apps/3ds-demo/pocket.host.config.ts", "--project-root", "."]);
    expect(checked.code, checked.err).toBe(0);
    expect(checked.out).toContain("✓ 3ds-runtime hosts the application");

    const contract = pocket(["check", "--target", "3ds", "--config", "apps/3ds-demo/pocket.host.config.ts", "--project-root", "."]);
    expect(contract.code).toBe(1);
    expect(contract.err).toContain("does not list host 3ds; choose 3ds-runtime");
  });
});
