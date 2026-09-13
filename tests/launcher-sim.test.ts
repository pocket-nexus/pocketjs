// tests/launcher-sim.test.ts — the launcher + app-switch protocol on the
// deterministic sim host (docs/LAUNCHER.md; hosts/sim/launcher.ts).
//
// Prereq (the `test` script runs it): bun tools/launcher.ts covers
//   -> dist/launcher-registry.{json,tsv}, apps/launcher/covers/*,
//      dist/launcher-main.* and every admitted app's dist bundle.
//
// Deliberately NO pixel goldens here: covers are live sim renders of the
// other demos, so a committed launcher PNG would break on ANY demo's visual
// change — cross-demo coupling for zero coverage. Determinism is asserted
// the sim way instead: two identical journeys must hash identically frame
// by frame.

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
import { bootLauncherWorld, type LauncherWorld } from "../hosts/sim/launcher.ts";
import { bootWorld, treeHasText } from "../hosts/sim/sim.ts";

const repository = new URL("..", import.meta.url).pathname;

const settle = async (w: LauncherWorld, frames: number) => {
  for (let i = 0; i < frames; i++) await w.step(0);
};

const stepForSeconds = async (
  w: LauncherWorld,
  mask: number,
  hz: number,
  seconds: number,
) => {
  const frames = hz * seconds;
  expect(Number.isInteger(frames)).toBe(true);
  for (let i = 0; i < frames; i++) await w.step(mask);
};

const registry = scanRegistry(new Set());
const vitaRegistry = scanRegistry(new Set(), "vita");

describe("launcher registry admission", () => {
  test("admits every PSP-compatible demo, excludes the rest", () => {
    const outputs = registry.apps.map((a) => a.output);
    // The two structurally incompatible demos (docs/LAUNCHER.md "Admission").
    expect(outputs).not.toContain("ipod-nano-main");
    expect(outputs).not.toContain("note-main");
    // The launcher never lists itself.
    expect(outputs).not.toContain("launcher-main");
    // Spot-check the shape of what IS admitted.
    expect(outputs).toContain("hero-main");
    expect(outputs).toContain("cafe-main");
    expect(outputs).toContain("im-main");
    expect(outputs).toContain("motions-main");
    expect(
      registry.apps.find((app) => app.output === "motions-main")?.title,
    ).toContain("yui540");
    expect(registry.apps.length).toBeGreaterThanOrEqual(15);
    // One entry per output (the root manifest duplicates apps/hero).
    expect(new Set(outputs).size).toBe(outputs.length);
  });

  test("every entry carries id + title for the deck", () => {
    for (const app of registry.apps) {
      expect(app.id).toMatch(/^dev\.pocket-stack\./);
      expect(app.title.length).toBeGreaterThan(0);
    }
  });

  test("PSP and Vita admit demos according to their independent capability profiles", () => {
    const pspOutputs = new Set(registry.apps.map((app) => app.output));
    const vitaOutputs = new Set(vitaRegistry.apps.map((app) => app.output));
    const pspOnly = registry.apps.filter((app) => !vitaOutputs.has(app.output));
    const vitaOnly = vitaRegistry.apps.filter((app) => !pspOutputs.has(app.output));
    // PSP advertises the paired text/offload path; Vita has touch, but does
    // not advertise that transport. A shared DrawList does not imply equal
    // runtime capabilities or make either target a superset of the other.
    expect(pspOnly.map((app) => app.output)).toEqual(["text-offload-main"]);
    expect(vitaOnly.map((app) => app.output).sort()).toEqual(["iphone16-demo-main", "nsengine-main"]);
    for (const app of registry.apps.filter((app) => vitaOutputs.has(app.output))) {
      expect(vitaRegistry.apps).toContainEqual(app);
    }
    expect(registry.apps).toHaveLength(18);
    expect(vitaRegistry.apps).toHaveLength(19);
  });

  test("committed registry.generated.ts is fresh (re-run tools/launcher.ts scan)", async () => {
    const { REGISTRY } = await import("../apps/launcher/registry.generated.ts");
    const displayRegistry = scanDisplayRegistry(new Set());
    expect(REGISTRY.map((r) => ({ output: r.output, id: r.id, title: r.title }))).toEqual(
      displayRegistry.apps.map((a) => ({
        output: a.output,
        id: a.id,
        title: a.title,
      })),
    );
    const generated = launcherGeneratedSources(displayRegistry);
    expect(
      await Bun.file(
        new URL("../apps/launcher/registry.generated.ts", import.meta.url),
      ).text(),
    ).toBe(generated.registryTs);
    expect(
      await Bun.file(
        new URL("../apps/launcher/images.json", import.meta.url),
      ).text(),
    ).toBe(generated.imagesJson);
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
      }, { POCKET_STACK_CACHE_DIR: cache });
    await Promise.all([
      build("/tmp/pocketjs-launcher-lock-a"),
      build("/tmp/pocketjs-launcher-lock-b"),
    ]);
    expect(maxActive).toBe(1);
  });

  test("never writes generated sources for non-scan excludes or bad backend args", () => {
    const registrySource = join(
      repository,
      "apps/launcher/registry.generated.ts",
    );
    const imagesSource = join(repository, "apps/launcher/images.json");
    const registryBefore = readFileSync(registrySource);
    const imagesBefore = readFileSync(imagesSource);
    const emittedPaths = [
      join(repository, "dist/launcher-registry.json"),
      join(repository, "dist/launcher-registry.tsv"),
    ];
    const emittedBefore = emittedPaths.map((path) =>
      existsSync(path) ? readFileSync(path) : undefined
    );
    try {
      const invalid = Bun.spawnSync([
        "bun",
        "tools/launcher.ts",
        "build",
        "--target",
        "symbian",
        "--",
        "--unknown-backend-option",
      ], { cwd: repository });
      expect(invalid.exitCode).toBe(1);
      expect(new TextDecoder().decode(invalid.stderr)).toContain(
        "unknown Symbian backend option --unknown-backend-option",
      );
      expect(readFileSync(registrySource)).toEqual(registryBefore);
      expect(readFileSync(imagesSource)).toEqual(imagesBefore);

      const covers = Bun.spawnSync([
        "bun",
        "tools/launcher.ts",
        "covers",
        "--target",
        "psp",
        "--exclude",
        "hero-main",
      ], { cwd: repository });
      if (covers.exitCode !== 0) {
        throw new Error(
          `launcher covers failed:\n${new TextDecoder().decode(covers.stderr)}`,
        );
      }
      expect(readFileSync(registrySource)).toEqual(registryBefore);
      expect(readFileSync(imagesSource)).toEqual(imagesBefore);
    } finally {
      emittedPaths.forEach((path, index) => {
        const previous = emittedBefore[index];
        if (previous) writeFileSync(path, previous);
        else rmSync(path, { force: true });
      });
    }
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
      manifest.id = "dev.pocket-stack.launcher.throw-probe";
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

  test("keeps the full display union in isolated PSP and Vita sources", () => {
    const dist = join(repository, "dist");
    mkdirSync(dist, { recursive: true });
    const testRoot = mkdtempSync(join(dist, ".launcher-console-source-test-"));
    try {
      const displayRegistry = scanDisplayRegistry(new Set());
      const expected = launcherGeneratedSources(displayRegistry);
      for (const target of ["psp", "vita"] as const) {
        const source = join(testRoot, target);
        const launcher = prepareIsolatedLauncherSource(
          target,
          displayRegistry,
          source,
        );
        expect(readFileSync(join(source, "registry.generated.ts"), "utf8")).toBe(
          expected.registryTs,
        );
        expect(readFileSync(join(source, "images.json"), "utf8")).toBe(
          expected.imagesJson,
        );
        const manifest = JSON.parse(readFileSync(launcher.manifest, "utf8"));
        const resolution = validateAndResolveBuildPlan(manifest, { target });
        expect(resolution.ok).toBe(true);
        if (!resolution.ok) continue;
        expect(resolution.plan.app.entry).toBe(
          relative(repository, join(source, "main.tsx")).replaceAll("\\", "/"),
        );
        expect(resolution.plan.viewport.logical).toEqual([480, 272]);
      }
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
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
    const stylesSource = join(repository, "framework/src/styles.generated.ts");
    const registryBefore = readFileSync(registrySource);
    const imagesBefore = readFileSync(imagesSource);
    const stylesBefore = existsSync(stylesSource)
      ? readFileSync(stylesSource)
      : undefined;
    try {
      const targetRegistry = scanRegistry(
        new Set(),
        SYMBIAN_E7_DEV_TARGET_ID,
      );
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
      if (stylesBefore) writeFileSync(stylesSource, stylesBefore);
      else rmSync(stylesSource, { force: true });
      rmSync(testRoot, { recursive: true, force: true });
    }
  });
});

describe("switch protocol (sim host policy)", () => {
  test("launch, summon with frozen shot + resume, relaunch", async () => {
    const w = await bootLauncherWorld({ hz: 60 });
    expect(w.current()).toBe("launcher-main");
    await settle(w, 30);

    // CIRCLE launches the front card (registry order: Café first).
    await w.step(BTN.CIRCLE);
    expect(w.current()).toBe("cafe-main");
    expect(w.resume()).toBeNull();
    await settle(w, 30);

    // SELECT summons the launcher; the interrupted app is the resume target
    // and its frozen frame was captured.
    await w.step(BTN.SELECT);
    expect(w.current()).toBe("launcher-main");
    expect(w.resume()).toBe("cafe-main");
    await settle(w, 20);
    expect(treeHasText(w.getTree(), "SELECT / CROSS RESUMES")).toBe(true);

    // SELECT again (release first — latched) resumes = relaunches.
    await w.step(0);
    await w.step(BTN.SELECT);
    expect(w.current()).toBe("cafe-main");
    expect(w.resume()).toBeNull();

    expect(w.switches.map((s) => s.reason)).toEqual(["boot", "launch", "summon", "launch"]);
  }, 120_000);

  test("guests never see SELECT; the launcher does", async () => {
    const w = await bootLauncherWorld({ hz: 60 });
    await settle(w, 10);
    // Browse one card right, launch Chrome, then hold SELECT for several
    // frames: exactly ONE summon (host edge, not level).
    await w.step(BTN.RIGHT);
    await settle(w, 20);
    await w.step(BTN.CIRCLE);
    const chrome = w.current();
    expect(chrome).not.toBe("launcher-main");
    await settle(w, 20);
    for (let i = 0; i < 5; i++) await w.step(BTN.SELECT);
    expect(w.current()).toBe("launcher-main");
    expect(w.switches.filter((s) => s.reason === "summon").length).toBe(1);
    // Held SELECT arrived latched: the launcher must NOT have resumed while
    // the chord stayed down.
    expect(w.resume()).toBe(chrome);
  }, 120_000);

  test("holding RTRIGGER flows the deck at 10 cards/s", async () => {
    const w = await bootLauncherWorld({ hz: 60 });
    await settle(w, 20);
    const motionIndex = registry.apps.findIndex((app) => app.title.includes("Motion Lab"));
    expect(motionIndex).toBeGreaterThan(0);
    // Move far enough to reach Motion Lab at 10 cards/s. Derive its index
    // from the registry so adding an earlier demo does not stale the test.
    const heldFrames = Math.ceil((motionIndex * 60) / 10);
    for (let i = 0; i < heldFrames; i++) await w.step(BTN.RTRIGGER);
    await settle(w, 20);
    expect(treeHasText(w.getTree(), "Motion Lab")).toBe(true);
    expect(w.current()).toBe("launcher-main");
  }, 120_000);

  for (const source of [
    { name: "triggers", right: BTN.RTRIGGER, left: BTN.LTRIGGER },
    { name: "d-pad", right: BTN.RIGHT, left: BTN.LEFT },
  ]) {
    test(`${source.name} flow distance is invariant at 60/30/20 Hz`, async () => {
      const hzValues = [60, 30, 20] as const;
      const holdSeconds = 0.5;
      const distance = 10 * holdSeconds;
      expect(Number.isInteger(distance)).toBe(true);
      const destination = registry.apps[distance]!;

      for (const hz of hzValues) {
        const w = await bootLauncherWorld({ hz });
        await stepForSeconds(w, 0, hz, 0.2);

        await stepForSeconds(w, source.right, hz, holdSeconds);
        await w.step(0); // release and settle to the exact destination
        await stepForSeconds(w, 0, hz, 0.2);
        expect(treeHasText(w.getTree(), destination.id)).toBe(true);

        await stepForSeconds(w, source.left, hz, holdSeconds);
        await w.step(0);
        await stepForSeconds(w, 0, hz, 0.2);
        expect(treeHasText(w.getTree(), registry.apps[0]!.id)).toBe(true);
      }
    }, 240_000);
  }

  test("a single-frame trigger tap moves exactly one card, never snaps back", async () => {
    const w = await bootLauncherWorld({ hz: 60 });
    await settle(w, 20);
    // One held frame advances pos by only 10/60 of a card — the release
    // rule must still land it one card over, not round home.
    await w.step(BTN.RTRIGGER);
    await settle(w, 20);
    expect(treeHasText(w.getTree(), "Chrome")).toBe(true);
    await w.step(BTN.LTRIGGER);
    await settle(w, 20);
    expect(treeHasText(w.getTree(), "Café")).toBe(true);
    // At the deck wall the tap has nowhere to go: Café stays.
    await w.step(BTN.LTRIGGER);
    await settle(w, 20);
    expect(treeHasText(w.getTree(), "Café")).toBe(true);
  }, 120_000);

  test("after a summon, CIRCLE launches the BROWSED card, never the resume app", async () => {
    // The real-hardware report behind the CIRCLE-confirm mapping: users
    // confirmed with O (then bound to resume) and every pick landed back in
    // the interrupted app. Guard the mapping: summon out of Café, browse two
    // cards right, confirm — must enter Cursor, not Café.
    const w = await bootLauncherWorld({ hz: 60 });
    await settle(w, 10);
    await w.step(BTN.CIRCLE); // launch Café (front card)
    expect(w.current()).toBe("cafe-main");
    await settle(w, 20);
    await w.step(BTN.SELECT); // summon
    expect(w.resume()).toBe("cafe-main");
    await settle(w, 10);
    await w.step(BTN.RIGHT);
    await settle(w, 15);
    await w.step(BTN.RIGHT);
    await settle(w, 15);
    await w.step(BTN.CIRCLE);
    expect(w.current()).toBe("cursor-main");
    expect(w.resume()).toBeNull();
  }, 120_000);

  test("two identical journeys produce identical frame hashes", async () => {
    const journey = async (): Promise<string[]> => {
      const w = await bootLauncherWorld({ hz: 60 });
      const hashes: string[] = [];
      const record = async (mask: number) => {
        await w.step(mask);
        hashes.push(w.hash());
      };
      for (let i = 0; i < 20; i++) await record(0);
      await record(BTN.RIGHT);
      for (let i = 0; i < 15; i++) await record(0);
      await record(BTN.CIRCLE);
      for (let i = 0; i < 20; i++) await record(0);
      await record(BTN.SELECT);
      for (let i = 0; i < 15; i++) await record(0);
      return hashes;
    };
    const a = await journey();
    const b = await journey();
    expect(b).toEqual(a);
  }, 240_000);
});

describe("degraded mode (hosts without the app* ops)", () => {
  test("plain bootWorld: deck browses, footer says why", async () => {
    const world = await bootWorld("launcher-main", 60);
    for (let f = 0; f < 30; f++) {
      world.frame(0);
      world.tick();
    }
    expect(treeHasText(world.getTree(), "browse only")).toBe(true);
  }, 120_000);
});
