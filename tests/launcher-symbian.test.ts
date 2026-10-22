import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { BTN, IMG_FLAG_LINEAR } from "../contracts/spec/spec.ts";
import {
  launcherGeneratedSources,
  renderCovers,
  prepareIsolatedLauncherSource,
  scanDisplayRegistry,
  scanRegistry,
  withLauncherSourceLock,
} from "../tools/launcher.ts";
import {
  resolveSymbianE7BuildPlan,
  SYMBIAN_E7_DEV_TARGET_ID,
} from "../tools/symbian-profile.ts";
import { unpack } from "../framework/compiler/pak.ts";
import { validateAndResolveBuildPlan } from "../framework/src/manifest/resolve.ts";

const repository = new URL("..", import.meta.url).pathname;


describe("Symbian launcher", () => {
  test("committed display metadata matches the repository app admission", () => {
    const generated = launcherGeneratedSources(scanDisplayRegistry(new Set()));
    expect(readFileSync(join(repository, "apps/launcher/registry.generated.ts"), "utf8")).toBe(generated.registryTs);
    expect(readFileSync(join(repository, "apps/launcher/images.json"), "utf8")).toBe(generated.imagesJson);
  });

  test("serializes one checkout even when cache environments differ", async () => {
    let active = 0;
    let maxActive = 0;
    const build = (cache: string) =>
      withLauncherSourceLock(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await Bun.sleep(20);
        active -= 1;
      }, { POCKET_NEXUS_CACHE_DIR: cache });
    await Promise.all([
      build("/tmp/pocketjs-launcher-lock-a"),
      build("/tmp/pocketjs-launcher-lock-b"),
    ]);
    expect(maxActive).toBe(1);
  });

  test("keeps generated source bytes unchanged throughout a failing non-scan command", async () => {
    const external = mkdtempSync(join(tmpdir(), "pocketjs-launcher-throw-"));
    const registrySource = join(
      repository,
      "apps/launcher/registry.generated.ts",
    );
    const imagesSource = join(repository, "apps/launcher/images.json");
    const registryBefore = readFileSync(registrySource);
    const imagesBefore = readFileSync(imagesSource);
    const emittedPaths = [
      join(repository, "dist/launcher/symbian/launcher-registry.json"),
      join(repository, "dist/launcher/symbian/launcher-registry.tsv"),
    ];
    const emittedBefore = emittedPaths.map((path) =>
      existsSync(path) ? readFileSync(path) : undefined
    );
    const output = "launcher-throw-probe";
    try {
      const manifest = JSON.parse(
        readFileSync(join(repository, "apps/hero/pocket.json"), "utf8"),
      );
      manifest.id = "dev.pocket-nexus.launcher.throw-probe";
      manifest.name = output;
      manifest.title = "AAAA Launcher Throw Probe";
      manifest.app.entry = "app.tsx";
      manifest.app.output = output;
      delete manifest.app.viewport.fixed;
      const externalManifest = join(external, "pocket.json");
      writeFileSync(externalManifest, JSON.stringify(manifest, null, 2));
      writeFileSync(
        join(external, "app.tsx"),
        "export default function App( {\n",
      );

      let exited = false;
      const failed = Bun.spawn(
        [
          "bun",
          "tools/launcher.ts",
          "covers",
          "--target",
          "symbian",
          "--include-manifest",
          externalManifest,
        ],
        {
          cwd: repository,
          stdout: "ignore",
          stderr: "ignore",
        },
      );
      const exit = failed.exited.then((code) => {
        exited = true;
        return code;
      });
      while (!exited) {
        expect(readFileSync(registrySource)).toEqual(registryBefore);
        expect(readFileSync(imagesSource)).toEqual(imagesBefore);
        await Bun.sleep(5);
      }
      expect(await exit).not.toBe(0);
      expect(readFileSync(registrySource)).toEqual(registryBefore);
      expect(readFileSync(imagesSource)).toEqual(imagesBefore);
    } finally {
      emittedPaths.forEach((path, index) => {
        const previous = emittedBefore[index];
        if (previous) writeFileSync(path, previous);
        else rmSync(path, { force: true });
      });
      for (const path of [
        join(repository, "dist/.plans", `${output}.json`),
        join(repository, "dist", `${output}.js`),
        join(repository, "dist", `${output}.pak`),
        join(repository, "apps/launcher/covers", `cover-${output}.png`),
        join(repository, "apps/launcher/covers", `refl-${output}.png`),
      ]) {
        rmSync(path, { force: true });
      }
      rmSync(external, { recursive: true, force: true });
    }
  });

  test("compiles an isolated E7 launcher with exactly 1 + 2N images", async () => {
    const dist = join(repository, "dist");
    mkdirSync(dist, { recursive: true });
    const testRoot = mkdtempSync(join(dist, ".launcher-isolation-test-"));
    const source = join(testRoot, "source");
    const output = join(testRoot, "output");
    const planPath = join(testRoot, "plan.json");
    const registrySource = join(
      repository,
      "apps/launcher/registry.generated.ts",
    );
    const imagesSource = join(repository, "apps/launcher/images.json");
    const registryBefore = readFileSync(registrySource);
    const imagesBefore = readFileSync(imagesSource);
    try {
      const targetRegistry = scanRegistry(
        new Set(),
        SYMBIAN_E7_DEV_TARGET_ID,
      );
      await renderCovers(targetRegistry, false);
      const launcher = prepareIsolatedLauncherSource(
        SYMBIAN_E7_DEV_TARGET_ID,
        targetRegistry,
        source,
      );
      const manifest = JSON.parse(readFileSync(launcher.manifest, "utf8"));
      const plan = resolveSymbianE7BuildPlan(manifest);
      writeFileSync(planPath, JSON.stringify(plan, null, 2) + "\n");

      expect(manifest.app.entry).toBe(
        relative(repository, join(source, "main.tsx")).replaceAll("\\", "/"),
      );
      expect(readFileSync(join(source, "main.tsx"), "utf8")).toContain(
        "<Launcher registry={REGISTRY} />",
      );
      expect(readFileSync(registrySource)).toEqual(registryBefore);
      expect(readFileSync(imagesSource)).toEqual(imagesBefore);

      let exited = false;
      const compiler = Bun.spawn(
        [
          "bun",
          "tools/build.ts",
          `--plan=${planPath}`,
          `--project-root=${repository}`,
          `--outdir=${output}`,
        ],
        { cwd: repository, stdout: "ignore", stderr: "pipe" },
      );
      const exit = compiler.exited.then((code) => {
        exited = true;
        return code;
      });
      while (!exited) {
        expect(readFileSync(registrySource)).toEqual(registryBefore);
        expect(readFileSync(imagesSource)).toEqual(imagesBefore);
        await Bun.sleep(5);
      }
      const exitCode = await exit;
      const stderr = await new Response(compiler.stderr).text();
      if (exitCode !== 0) {
        throw new Error(`isolated launcher compile failed:\n${stderr}`);
      }

      const entries = unpack(
        new Uint8Array(
          readFileSync(join(output, "launcher-main.pak")),
        ),
      );
      const imageEntries = entries.filter((entry) =>
        entry.key.startsWith("ui:img.")
      );
      const images = imageEntries.map((entry) => entry.key);
      expect(images).toHaveLength(1 + targetRegistry.apps.length * 2);
      expect(images).toEqual(
        [
          "ui:img.covers/launcher-bg.png",
          ...targetRegistry.apps.flatMap((app) => [
            `ui:img.covers/cover-${app.output}.png`,
            `ui:img.covers/refl-${app.output}.png`,
          ]),
        ].sort(),
      );
      for (const entry of imageEntries) {
        const image = new DataView(
          entry.data.buffer,
          entry.data.byteOffset,
          entry.data.byteLength,
        );
        expect(entry.data[5]! & IMG_FLAG_LINEAR).toBe(IMG_FLAG_LINEAR);
        if (entry.key.includes("/refl-")) {
          expect([image.getUint16(0, true), image.getUint16(2, true)]).toEqual(
            [128, 64],
          );
        } else {
          expect([image.getUint16(0, true), image.getUint16(2, true)]).toEqual(
            [256, 128],
          );
        }
      }
      expect(readFileSync(registrySource)).toEqual(registryBefore);
      expect(readFileSync(imagesSource)).toEqual(imagesBefore);
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  }, 120_000);
});
