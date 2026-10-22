import { describe, expect, test } from "bun:test";
import {
existsSync,
mkdtempSync,
readFileSync,
rmSync,
writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveModality } from "../contracts/spec/modality.ts";
import { validateAndResolveBuildPlan } from "../framework/src/manifest/resolve.ts";
import { hashPocketProfile } from "../framework/src/profile.ts";
import profile from "../profiles/symbian-e7-dev.ts";
import {
encodeSymbianCatalog,
includeExternalManifests,
launcherGeneratedSources,
needsLauncherCompile,
scanRegistry,
withLauncherSourceLock,
type SymbianCatalogEntry,
} from "../tools/launcher.ts";
import {
SYMBIAN_E7_DEV_CONTRACTS,
SYMBIAN_E7_DEV_HOST_ABI,
SYMBIAN_E7_DEV_TARGET_ID,
resolveSymbianE7BuildPlan,
symbianE7Orientation,
} from "../tools/symbian-profile.ts";

const repository = new URL("..", import.meta.url).pathname;

describe("experimental Nokia E7 runtime profile", () => {
  test("maps the E7 scan matrix without changing unrelated keys", () => {
    const compiler = Bun.which("cc");
    expect(
      compiler,
      "cc is required to validate the Symbian key mapper",
    ).toBeTruthy();
    if (!compiler) return;
    const root = mkdtempSync(join(tmpdir(), "pocketjs-e7-key-map-"));
    try {
      const executable = join(root, "symbian-key-map-test");
      const compiled = Bun.spawnSync([
        compiler,
        "-std=c11",
        "-Wall",
        "-Wextra",
        "-Werror",
        join(
          repository,
          "tests/fixtures/symbian-key-normalization-test.c",
        ),
        "-o",
        executable,
      ], { cwd: repository });
      expect(compiled.exitCode, compiled.stderr.toString()).toBe(0);

      // Managed macOS hosts can attach provenance to a freshly linked
      // temporary executable and hold its first launch beyond Bun's timeout.
      // This file is built above from the committed hermetic fixture.
      if (process.platform === "darwin") {
        const xattr = Bun.which("xattr");
        if (xattr) {
          Bun.spawnSync([
            xattr,
            "-d",
            "com.apple.provenance",
            executable,
          ]);
        }
      }
      const ran = Bun.spawnSync([executable], { cwd: repository });
      expect(ran.exitCode, ran.stderr.toString()).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("serializes the shared launcher source tree across targets", async () => {
    const root = mkdtempSync(join(tmpdir(), "pocketjs-launcher-source-lock-"));
    try {
      const env = { POCKET_NEXUS_CACHE_DIR: join(root, "cache") };
      let active = 0;
      let maxActive = 0;
      const build = () => withLauncherSourceLock(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await Bun.sleep(20);
        active -= 1;
      }, env);
      await Promise.all([build(), build()]);
      expect(maxActive).toBe(1);

      const launcher = readFileSync(
        join(repository, "tools/launcher.ts"),
        "utf8",
      );
      const sourceLock = launcher.indexOf(
        "await withLauncherSourceLock(async () =>",
      );
      const outputLock = launcher.indexOf(
        "await withSymbianBuildTransaction(paths.output",
        sourceLock,
      );
      expect(sourceLock).toBeGreaterThan(-1);
      expect(outputLock).toBeGreaterThan(sourceLock);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("never reuses stale Symbian guests", () => {
    const root = mkdtempSync(join(tmpdir(), "pocketjs-launcher-freshness-"));
    try {
      writeFileSync(join(root, "probe.js"), "js");
      writeFileSync(join(root, "probe.pak"), "pak");
      expect(
        needsLauncherCompile("probe", SYMBIAN_E7_DEV_TARGET_ID, root, false),
      ).toBe(true);
      rmSync(join(root, "probe.pak"));
      expect(needsLauncherCompile("probe", SYMBIAN_E7_DEV_TARGET_ID, root, false)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("encodes an aligned verbatim package catalog for the Qt host", () => {
    const entry = (
      output: string,
      id: string,
      title: string,
      bytes: number[],
      liveViewport: boolean,
    ): SymbianCatalogEntry => ({
      plan: {
        app: {
          output,
          id,
          title,
          version: "0.1.0",
          entry: "app.tsx",
          framework: "solid",
        },
        presentation: { id: "default", entry: "app.tsx" },
        target: { id: SYMBIAN_E7_DEV_TARGET_ID, hostAbi: SYMBIAN_E7_DEV_HOST_ABI },
        viewport: {
          logical: liveViewport ? [640, 360] : [480, 272],
          physical: liveViewport ? [640, 360] : [480, 272],
          presentation: "native",
          rasterDensity: 1,
          policy: liveViewport ? "dynamic" : "fixed",
        },
        modality: deriveModality(SYMBIAN_E7_DEV_CONTRACTS.targets[SYMBIAN_E7_DEV_TARGET_ID]),
        features: {},
        companions: [],
        profile,
    profileHash: hashPocketProfile(profile),
    planHash: `sha256:${"0".repeat(64)}`,
      },
      packageBytes: new Uint8Array(bytes),
      liveViewport,
    });
    const launcher = entry(
      "launcher-main",
      "dev.pocket-nexus.launcher",
      "PocketJS: Launcher",
      [1, 2, 3],
      false,
    );
    const hero = entry(
      "hero-main",
      "dev.pocket-nexus.hero",
      "PocketJS: Hero",
      [4, 5],
      true,
    );
    const catalog = encodeSymbianCatalog([launcher, hero]);
    expect(new TextDecoder().decode(catalog.index)).toBe(
      "launcher-main\tdev.pocket-nexus.launcher\tPocketJS: Launcher\t0\t3\t480\t272\tfixed\n" +
        "hero-main\tdev.pocket-nexus.hero\tPocketJS: Hero\t16\t2\t640\t360\tlive\n",
    );
    expect([...catalog.blob.subarray(0, 3)]).toEqual([1, 2, 3]);
    expect([...catalog.blob.subarray(3, 16)]).toEqual(new Array(13).fill(0));
    expect([...catalog.blob.subarray(16)]).toEqual([4, 5]);
  });

  test("launcher admission includes only genuine E7 live-viewport apps", () => {
    const outputs = scanRegistry(
      new Set(),
      SYMBIAN_E7_DEV_TARGET_ID,
    ).apps.map((app) => app.output);
    expect(outputs).toEqual(["note-main", "hero-main"]);
    expect(outputs).not.toContain("cafe-main");
    expect(outputs).not.toContain("launcher-main");
  });

  test("thins the E7 launcher source to admitted Cover Flow textures", () => {
    const registry = scanRegistry(new Set(), SYMBIAN_E7_DEV_TARGET_ID);
    const generated = launcherGeneratedSources(registry);
    expect(generated.registryTs).toContain("cover-note-main.png");
    expect(generated.registryTs).toContain("cover-hero-main.png");
    expect(generated.registryTs).not.toContain("cover-cafe-main.png");
    expect(generated.registryTs).toContain("refl-note-main.png");
    expect(JSON.parse(generated.imagesJson)).toEqual({
      "covers/launcher-bg.png": { linear: true },
      "covers/cover-note-main.png": { linear: true },
      "covers/refl-note-main.png": { linear: true },
      "covers/cover-hero-main.png": { linear: true },
      "covers/refl-hero-main.png": { linear: true },
    });
  });

  test("adds explicit external manifests without leaking paths or dirtying sources", () => {
    const external = mkdtempSync(join(tmpdir(), "pocketjs-launcher-external-"));
    const registrySource = join(
      repository,
      "apps/launcher/registry.generated.ts",
    );
    const imagesSource = join(repository, "apps/launcher/images.json");
    const registryBefore = readFileSync(registrySource);
    const imagesBefore = readFileSync(imagesSource);
    const emittedPaths = [
      join(
        repository,
        "dist/launcher/symbian/launcher-registry.json",
      ),
      join(
        repository,
        "dist/launcher/symbian/launcher-registry.tsv",
      ),
    ];
    const emittedBefore = emittedPaths.map((path) =>
      existsSync(path) ? readFileSync(path) : undefined
    );
    try {
      const manifest = JSON.parse(
        readFileSync(join(repository, "apps/hero/pocket.json"), "utf8"),
      );
      manifest.id = "dev.pocket-nexus.external-probe";
      manifest.name = "external-probe";
      manifest.title = "External Probe";
      manifest.app.entry = "app.tsx";
      manifest.app.output = "external-probe";
      delete manifest.app.viewport.fixed;
      const externalManifest = join(external, "pocket.json");
      writeFileSync(externalManifest, JSON.stringify(manifest, null, 2));
      writeFileSync(join(external, "app.tsx"), "export default function App() {}\n");

      const scanned = Bun.spawnSync([
        "bun",
        "tools/launcher.ts",
        "scan",
        "--target",
        "symbian",
        "--include-manifest",
        externalManifest,
      ], { cwd: repository });
      expect(scanned.exitCode).toBe(0);
      expect(readFileSync(registrySource)).toEqual(registryBefore);
      expect(readFileSync(imagesSource)).toEqual(imagesBefore);

      const emitted = JSON.parse(readFileSync(
        join(
          repository,
          "dist/launcher/symbian/launcher-registry.json",
        ),
        "utf8",
      )) as {
        apps: Array<Record<string, unknown>>;
      };
      const app = emitted.apps.find(
        (entry) => entry.output === "external-probe",
      );
      expect(app).toMatchObject({
        id: "dev.pocket-nexus.external-probe",
        manifest: "pocket.json",
      });
      expect(app).not.toHaveProperty("projectRoot");
      expect(JSON.stringify(emitted)).not.toContain(external);
    } finally {
      emittedPaths.forEach((path, index) => {
        const previous = emittedBefore[index];
        if (previous) writeFileSync(path, previous);
        else rmSync(path, { force: true });
      });
      rmSync(external, { recursive: true, force: true });
    }
  });

  test("external manifests cannot replace the launcher identity", () => {
    const external = mkdtempSync(join(tmpdir(), "pocketjs-launcher-collision-"));
    try {
      const manifest = JSON.parse(
        readFileSync(join(repository, "apps/launcher/pocket.json"), "utf8"),
      );
      manifest.app.entry = "app.tsx";
      manifest.app.viewport.dynamic = {
        default: [640, 360],
        min: [360, 360],
        max: [640, 640],
      };
      const manifestPath = join(external, "pocket.json");
      writeFileSync(manifestPath, JSON.stringify(manifest));
      writeFileSync(join(external, "app.tsx"), "export default function App() {}\n");
      expect(() =>
        includeExternalManifests(
          scanRegistry(new Set(), SYMBIAN_E7_DEV_TARGET_ID),
          [manifestPath],
          new Set(),
          SYMBIAN_E7_DEV_TARGET_ID,
        )
      ).toThrow("external output launcher-main duplicates");
    } finally {
      rmSync(external, { recursive: true, force: true });
    }
  });

  test("selects the Hero's dynamic E7 viewport without changing its PSP viewport", () => {
    const manifest = JSON.parse(
      readFileSync(join(repository, "apps/hero/pocket.json"), "utf8"),
    );
    const plan = resolveSymbianE7BuildPlan(manifest);
    expect(plan.target).toEqual({
      id: SYMBIAN_E7_DEV_TARGET_ID,
      hostAbi: SYMBIAN_E7_DEV_HOST_ABI,
    });
    expect(plan.viewport).toEqual({
      logical: [640, 360],
      physical: [640, 360],
      presentation: "native",
      rasterDensity: 1,
      policy: "dynamic",
    });
    expect(plan.features["display.viewport.live"]).toBe(true);

    const psp = validateAndResolveBuildPlan(manifest, { target: "psp" });
    expect(psp.ok).toBe(true);
    if (!psp.ok) return;
    expect(psp.plan.viewport).toEqual({
      logical: [480, 272],
      physical: [480, 272],
      presentation: "integer-fit",
      rasterDensity: 1,
      policy: "fixed",
    });
    expect(psp.plan.features["display.viewport.live"]).toBe(false);
  });

  test("holds a portrait-only range in portrait and binds physics for the plans that require it", () => {
    const manifest = (path: string) => JSON.parse(readFileSync(join(repository, path), "utf8"));
    const orientation = (path: string) => symbianE7Orientation(manifest(path), resolveSymbianE7BuildPlan(manifest(path)));
    // Clear and Pocket Nexus lay out once for 360x640; Hero relayouts live
    expect(orientation("apps/clear/pocket.symbian.json")).toBe("portrait");
    expect(orientation("apps/nexus-touch/pocket.symbian.json")).toBe("portrait");
    expect(orientation("apps/hero/pocket.json")).toBe("auto");
    // a navigation registry entry held in portrait folds into the same lock
    const hero = manifest("apps/hero/pocket.json");
    expect(symbianE7Orientation(hero, resolveSymbianE7BuildPlan(hero), "portrait")).toBe("portrait");
    const wide = { ...hero, app: { ...hero.app, viewport: { dynamic: { default: [640, 360], min: [640, 360], max: [640, 360] } } } };
    expect(symbianE7Orientation(wide, resolveSymbianE7BuildPlan(wide))).toBe("landscape");
    expect(() => symbianE7Orientation(wide, resolveSymbianE7BuildPlan(wide), "portrait")).toThrow("admits landscape only");
    expect(resolveSymbianE7BuildPlan(manifest("apps/nexus-touch/pocket.symbian.json")).features["ui.physics"]).toBe(true);
    expect(resolveSymbianE7BuildPlan(manifest("apps/clear/pocket.symbian.json")).features["ui.physics"]).toBeUndefined();

  });
});
