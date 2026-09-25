import { describe, expect, test } from "bun:test";
import {
  desktopNativeExtension,
  validateAndResolveBuildPlan,
  validateAndResolveSystemPlan,
} from "@pocketjs/framework/manifest";
import systemInput from "./fixtures/systems/managed-desktop.json";

const SYSTEM_UI = "dev.pocket-stack.test-system-ui";
const HERO = "dev.pocket-stack.hero";

async function packageInputs(system: any = systemInput) {
  const installed = new Set(system.installation.installedPackages as string[]);
  return Promise.all(
    system.applications.catalog
      .filter((entry: any) => installed.has(entry.package))
      .map(async (entry: any) => ({
        source: entry.manifest,
        manifest: await Bun.file(entry.manifest).json(),
      })),
  );
}

describe("Pocket System resolution", () => {
  test("resolves the same installed package model for the browser System host", async () => {
    const resolution = validateAndResolveSystemPlan(systemInput, {
      target: "web-app",
      packages: await packageInputs(),
    });
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.plan.target).toEqual({ id: "web-app", hostAbi: 4 });
    expect(resolution.plan.systemUI.plan.features["ui.compositor-surfaces"]).toBe(true);
    expect(
      resolution.plan.applications.every(
        (entry) => entry.plan.features["ui.compositor-surfaces"] !== true,
      ),
    ).toBe(true);
  });

  test("preserves each installed package's complete resolved plan", async () => {
    const packages = await packageInputs();
    const resolution = validateAndResolveSystemPlan(systemInput, {
      target: "macos-app",
      packages,
    });
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.plan.roles.systemUI).toBe(SYSTEM_UI);
    expect(resolution.plan.systemUI.package).toBe(SYSTEM_UI);
    expect(resolution.plan.installation).toEqual(systemInput.installation);
    expect(resolution.plan.applications).toHaveLength(2);

    const resolvedPackages = [
      resolution.plan.systemUI,
      ...resolution.plan.applications,
    ];
    for (const entry of systemInput.applications.catalog) {
      const input = packages.find((item) => item.source === entry.manifest)!;
      const packageResolution = validateAndResolveBuildPlan(input.manifest, {
        target: "macos-app",
        role: entry.package === SYSTEM_UI ? "systemUI" : "application",
      });
      expect(packageResolution.ok).toBe(true);
      if (!packageResolution.ok) continue;
      expect(
        resolvedPackages.find((item) => item.package === entry.package)?.plan,
      ).toEqual(packageResolution.plan);
    }
  });

  test("rejects duplicate artifact outputs before building", async () => {
    const packages = await packageInputs();
    const hero = packages.find((entry) => entry.source === "apps/hero/pocket.json")!;
    hero.manifest.app.output = "settings-main";
    const result = validateAndResolveSystemPlan(systemInput, {
      target: "macos-app",
      packages,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.map((item) => item.code)).toContain(
        "system.duplicateOutput",
      );
    }
  });

  test("keeps catalog availability separate from installation state", async () => {
    const system = structuredClone(systemInput);
    system.installation.installedPackages =
      system.installation.installedPackages.filter((id) => id !== HERO);
    const packages = (await packageInputs()).filter(
      (entry) => entry.source !== "apps/hero/pocket.json",
    );
    const result = validateAndResolveSystemPlan(system, {
      target: "macos-app",
      packages,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(system.applications.catalog).toContainEqual(
      expect.objectContaining({ package: HERO }),
    );
    expect(result.plan.installation.installedPackages).not.toContain(HERO);
    expect(result.plan.applications.map((entry) => entry.package)).not.toContain(
      HERO,
    );
  });

  test("rejects missing required and unknown installed packages", async () => {
    const missingSystemUI = structuredClone(systemInput);
    missingSystemUI.installation.installedPackages =
      missingSystemUI.installation.installedPackages.filter(
        (id) => id !== SYSTEM_UI,
      );
    const missing = validateAndResolveSystemPlan(missingSystemUI, {
      target: "macos-app",
      packages: (await packageInputs()).filter(
        (entry) => entry.source !== "tests/fixtures/manifests/system-ui.json",
      ),
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.diagnostics.map((item) => item.code)).toContain(
        "system.requiredPackageNotInstalled",
      );
    }

    const unknownSystem = structuredClone(systemInput);
    unknownSystem.installation.installedPackages.push("dev.pocket-stack.unknown");
    const unknown = validateAndResolveSystemPlan(unknownSystem, {
      target: "macos-app",
      packages: await packageInputs(),
    });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.diagnostics.map((item) => item.code)).toContain(
        "system.installedPackageUnknown",
      );
    }
  });

  test("grants compositor surfaces only to the System UI role", async () => {
    const required = await packageInputs();
    const requiredHero = required.find(
      (entry) => entry.source === "apps/hero/pocket.json",
    )!;
    requiredHero.manifest.engine.capabilities.requires.push(
      "ui.compositor-surfaces",
    );
    const rejected = validateAndResolveSystemPlan(systemInput, {
      target: "macos-app",
      packages: required,
    });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.diagnostics.map((item) => item.code)).toContain(
        "capability.unavailable",
      );
    }

    const enhanced = await packageInputs();
    const enhancedHero = enhanced.find(
      (entry) => entry.source === "apps/hero/pocket.json",
    )!;
    enhancedHero.manifest.engine.capabilities.enhances.push(
      "ui.compositor-surfaces",
    );
    const accepted = validateAndResolveSystemPlan(systemInput, {
      target: "macos-app",
      packages: enhanced,
    });
    expect(accepted.ok).toBe(true);
    if (accepted.ok) {
      expect(
        accepted.plan.applications.find((entry) => entry.package === HERO)
          ?.plan.features["ui.compositor-surfaces"],
      ).toBe(false);
    }
  });

  test("requires a hard compositor-surface dependency from System UI", async () => {
    const packages = await packageInputs();
    const systemUI = packages.find(
      (entry) => entry.source === "tests/fixtures/manifests/system-ui.json",
    )!;
    const capabilities = systemUI.manifest.engine.capabilities;
    capabilities.requires = capabilities.requires.filter(
      (capability: string) => capability !== "ui.compositor-surfaces",
    );
    capabilities.enhances.push("ui.compositor-surfaces");
    const result = validateAndResolveSystemPlan(systemInput, {
      target: "macos-app",
      packages,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.map((item) => item.code)).toContain(
        "system.systemUICapabilityMissing",
      );
    }
  });

  test("rejects child companions until an AppInstance adapter exists", async () => {
    const packages = await packageInputs();
    const hero = packages.find((entry) => entry.source === "apps/hero/pocket.json")!;
    hero.manifest.app.companions = ["note"];
    const result = validateAndResolveSystemPlan(systemInput, {
      target: "macos-app",
      packages,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.map((item) => item.code)).toContain(
        "system.childCompanionUnsupported",
      );
    }
  });
});


test("native extensions survive System resolution and are rejected for web and system UI", async () => {
  const packages = await packageInputs();
  const app = packages.find(p => p.source === "apps/hero/pocket.json")!;
  const hostExtension = desktopNativeExtension({ library: "apps/hero/libhero.dylib", sha256: "a".repeat(64), config: { level: 1 } });
  const inputs = packages.map(p => p === app ? { ...p, hostExtension } : p);
  const result = validateAndResolveSystemPlan(systemInput, { target: "macos-app", packages: inputs });
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.plan.applications.find(p => p.package === HERO)?.plan.hostExtension).toEqual(hostExtension);
  expect(validateAndResolveSystemPlan(systemInput, { target: "web-app", packages: inputs }).ok).toBe(false);
  expect(validateAndResolveBuildPlan(app.manifest, { target: "macos-app", role: "systemUI", hostExtension }).ok).toBe(false);
  expect(() => desktopNativeExtension({ library: "../outside.so", sha256: "a".repeat(64) })).toThrow();
  expect(() => desktopNativeExtension({ library: "apps/a.so", sha256: "a".repeat(64), config: "x".repeat(16385) })).toThrow();
  const plain = validateAndResolveSystemPlan(systemInput, { target: "macos-app", packages });
  if (result.ok && plain.ok) expect(result.plan.planHash).not.toBe(plain.plan.planHash);
});
