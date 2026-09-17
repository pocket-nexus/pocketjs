import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  INITIAL_KEYED_ROWS,
  keyedDelete,
  keyedInsert,
  keyedReorder,
} from "../tools/perf/apps/keyed-list-model.ts";
import {
  artifactBuildVariantKey,
  buildRenderConfig,
  DEFAULT_BUDGET_SET,
  isMetricId,
  parseInputTapeV1,
  parseScenarioV1,
} from "../tools/perf/core/index.ts";
import { expandInputTape } from "../tools/perf/runner/input.ts";
import {
  devtoolsTapeToInputTape,
  goldenSpecToInputTape,
  ppssppScriptToInputTape,
  vaporTodoToInputTape,
} from "../tools/perf/runner/legacy-input.ts";
import {
  runNativeQuick,
  type NativeBootAdapter,
  type NativeRunResult,
  type NativeSimWorld,
} from "../tools/perf/runner/native.ts";
import {
  estimatedSuiteSeconds,
  expandSuiteFrameworks,
  loadScenarioSuite,
  runNativeSuite,
} from "../tools/perf/runner/suite.ts";

const SCENARIO_DIR = join(import.meta.dir, "..", "tools", "perf", "scenarios");

function scenario(name: string) {
  return parseScenarioV1(
    JSON.parse(readFileSync(join(SCENARIO_DIR, `${name}.json`), "utf8")),
  );
}

describe("performance scenario catalog", () => {
  test("strictly validates the complete v1 scenario matrix", () => {
    const names = readdirSync(SCENARIO_DIR)
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -5))
      .sort();
    expect(names).toEqual([
      "boot",
      "damage",
      "deepzoom",
      "fixed-text",
      "idle",
      "list",
      "style",
      "timer",
      "touch",
      "vapor",
    ]);
    for (const name of names) {
      const parsed = scenario(name);
      expect(parsed.frames).toBe(parsed.tape.frames);
      expect(parsed.params.gateMetrics).toBeArray();
      for (const metric of parsed.params.gateMetrics as readonly string[]) {
        expect(isMetricId(metric), `${name}: ${metric}`).toBe(true);
        expect(metric, `${name}: aggregate load/store gate`).not.toBe("guest.loads");
        expect(metric, `${name}: aggregate load/store gate`).not.toBe("guest.stores");
        expect(metric, `${name}: current memory is diagnostic`).not.toBe("memory.current_bytes");
        expect(metric, `${name}: peak memory is diagnostic`).not.toBe("memory.peak_bytes");
      }
      expect(parsed.executorRequirements, `${name}: DrawList correctness capability`)
        .toContain("correctness.draw-list");
      expect(buildRenderConfig(parsed.params)).toEqual({
        width: 480,
        height: 272,
        rasterDensity: 1,
        renderScale: 1,
      });
    }
  });

  test("keys built app artifacts by their resolved raster density", () => {
    const base = scenario("boot");
    const highDensity = parseScenarioV1({
      ...base,
      params: {
        ...base.params,
        viewport: { rasterDensity: 2 },
      },
    });
    expect(artifactBuildVariantKey(base)).toEndWith("\0density=1");
    expect(artifactBuildVariantKey(highDensity)).toEndWith("\0density=2");
    expect(artifactBuildVariantKey(highDensity)).not.toBe(artifactBuildVariantKey(base));
  });

  test("keeps all ten approved workloads in the quick suite", () => {
    expect([
      "boot",
      "idle",
      "fixed-text",
      "list",
      "style",
      "timer",
      "damage",
      "touch",
      "vapor",
      "deepzoom",
    ].map((name) => scenario(name).suite)).toEqual(new Array(10).fill("quick"));
  });

  test("gives every required gate an applicable QEMU budget", () => {
    for (const name of readdirSync(SCENARIO_DIR)
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) => entry.slice(0, -5))) {
      const parsed = scenario(name);
      for (const metric of parsed.params.gateMetrics as readonly string[]) {
        const scenarioBudget = DEFAULT_BUDGET_SET.scenarios?.[parsed.id]?.[metric];
        const globalBudget = DEFAULT_BUDGET_SET.metrics[metric];
        const budget = scenarioBudget ?? globalBudget;
        expect(budget, `${parsed.id}: ${metric}`).toBeDefined();
        for (const executor of ["qemu-armv7-thumb2", "qemu-aarch64"]) {
          expect(
            budget?.executors === undefined || budget.executors.includes(executor),
            `${parsed.id}: ${metric} must apply to ${executor}`,
          ).toBe(true);
        }
      }
    }
  });

  test("maps framework matrix entries to their real application artifacts", () => {
    const expanded = expandSuiteFrameworks([scenario("boot")]);
    expect(expanded.map((item) => [item.subject.framework, item.subject.id, item.subject.entry]))
      .toEqual([
        ["solid", "hero-main", "hero-main"],
        ["vue-vapor", "hero-vue-vapor-main", "hero-vue-vapor-main.vue-vapor"],
        ["octane", "hero-main", "hero-main.octane"],
      ]);
  });

  test("drives real keyed insert, reorder, and delete operations", () => {
    const keyed = scenario("list");
    expect([keyed.subject.id, keyed.subject.entry]).toEqual([
      "tools/perf/apps/list-fixture-main.tsx",
      "list-fixture-main",
    ]);
    expect(keyed.phases.map((phase) => [phase.name, phase.collect])).toEqual([
      ["warmup", false],
      ["keyed-insert", true],
      ["keyed-reorder", true],
      ["keyed-delete", true],
      ["steady", true],
    ]);
    expect(keyed.tape.tracks.map((track) => track.kind === "button" ? track.control : track.kind))
      .toEqual(["quaternary", "secondary", "primary"]);
    expect(keyed.checkpoints.map((checkpoint) => checkpoint.frame)).toEqual([59, 89, 119, 179]);
    for (const checkpoint of keyed.checkpoints) expect(checkpoint.capture).toContain("drawList");
    const fixtureSource = readFileSync(
      join(import.meta.dir, "..", "tools", "perf", "apps", "list-fixture-main.tsx"),
      "utf8",
    );
    expect(fixtureSource).toContain("<For each={rows()}>");
    expect(fixtureSource).toContain("onButtonPress(BTN.SQUARE");
    expect(fixtureSource).toContain("onButtonPress(BTN.TRIANGLE");
    expect(fixtureSource).toContain("onButtonPress(BTN.CIRCLE");

    const initial = [...INITIAL_KEYED_ROWS];
    const inserted = keyedInsert(initial);
    expect(inserted.map((item) => item.id)).toEqual([
      "alpha", "inserted", "bravo", "charlie", "delta",
    ]);
    expect(inserted[0]).toBe(initial[0]);
    expect(inserted[2]).toBe(initial[1]);

    const reordered = keyedReorder(inserted);
    expect(reordered.map((item) => item.id)).toEqual([
      "inserted", "bravo", "charlie", "delta", "alpha",
    ]);
    expect(reordered[4]).toBe(initial[0]);
    expect(reordered[1]).toBe(initial[1]);

    const deleted = keyedDelete(reordered);
    expect(deleted.map((item) => item.id)).toEqual(["bravo", "charlie", "delta", "alpha"]);
    expect(deleted[0]).toBe(initial[1]);
    expect(deleted[3]).toBe(initial[0]);
  });

  test("uses a genuinely static idle application", () => {
    const idle = scenario("idle");
    expect([idle.id, idle.subject.id, idle.subject.entry]).toEqual([
      "guest.fixture.idle-600.v1",
      "tools/perf/apps/idle-fixture-main.tsx",
      "idle-fixture-main",
    ]);
    expect(idle.tape.tracks).toEqual([]);
    for (const checkpoint of idle.checkpoints) {
      expect(checkpoint.capture).toContain("framebuffer");
      expect(checkpoint.capture).toContain("drawList");
    }
    const source = readFileSync(
      join(import.meta.dir, "..", "tools", "perf", "apps", "idle-fixture-main.tsx"),
      "utf8",
    );
    expect(source).toContain('class="h-[144] flex-row gap-4"');
    expect(source).toContain('class="w-[216] h-[144]');
    expect(source).not.toMatch(/\bitems-center\b|\bjustify-center\b/);
    expect(source).not.toMatch(/\bonFrame\s*\(/);
    expect(source).not.toMatch(/\bcreateSpriteAnimation\s*\(/);
    expect(source).not.toMatch(/<(?:Sprite|Image)\b/);
    expect(source).not.toMatch(/\b(?:animate|spring)\s*\(/);
  });

  test("does not claim final state capture for the core damage adapter", () => {
    const damage = scenario("damage");
    expect(damage.executorRequirements).not.toContain("correctness.state-final");
    expect(damage.checkpoints.flatMap((checkpoint) => checkpoint.capture)).not.toContain("state");
  });

  test("keeps the local quick suite within an explicit estimated-time budget", async () => {
    const quick = loadScenarioSuite("quick", SCENARIO_DIR);
    expect(quick).toHaveLength(10);
    expect(estimatedSuiteSeconds(quick)).toBe(80);
    expect(estimatedSuiteSeconds(expandSuiteFrameworks(quick))).toBe(88);
    expect(estimatedSuiteSeconds(expandSuiteFrameworks(quick))).toBeLessThan(1500);
    expect(
      runNativeSuite("quick", {
        sourceRoot: "/tmp/unused",
        scenarioDir: SCENARIO_DIR,
        maxEstimatedSeconds: 87,
        bootAdapter: { async boot() { throw new Error("must not boot"); } },
      }),
    ).rejects.toThrow(/estimate 88s exceeds the 87s limit/);
  });
});

describe("hardware-neutral input adapter", () => {
  test("lowers logical controls only at the guest ABI boundary", () => {
    const tape = parseInputTapeV1({
      schemaVersion: 1,
      kind: "pocketjs.perf.input-tape",
      id: "adapter-contract",
      frames: 6,
      tracks: [
        {
          kind: "button",
          control: "primary",
          samples: [
            { frame: 1, pressed: true },
            { frame: 3, pressed: false },
          ],
        },
        {
          kind: "analog",
          control: "x",
          samples: [
            { frame: 2, value: -1 },
            { frame: 4, value: 0 },
          ],
        },
        {
          kind: "touch",
          control: "contact-0",
          samples: [
            { frame: 2, phase: "start", x: 240, y: 90 },
            { frame: 3, phase: "move", x: 241, y: 91 },
            { frame: 4, phase: "end", x: 241, y: 91 },
          ],
        },
        {
          kind: "relative-axis",
          control: "primary",
          samples: [{ frame: 3, delta: -45000 }],
        },
        {
          kind: "effect",
          effect: "probe",
          samples: [{ frame: 5, value: { ok: true } }],
        },
      ],
    });
    const frames = expandInputTape(tape);

    expect(frames[0]).toMatchObject({ buttons: 0, analog: 0x8080, touches: undefined });
    expect(frames[1].buttons).toBe(0x2000); // logical primary -> guest CIRCLE
    expect(frames[2].analog).toBe(0x0080); // target-neutral x=-1 -> guest raw x=0
    expect(frames[2].touches).toEqual([((90 << 9) | 240) >>> 0]);
    expect(frames[3].relativeAxes).toEqual([{ control: "primary", delta: -45000 }]);
    expect(frames[4].buttons).toBe(0);
    expect(frames[4].analog).toBe(0x8080);
    expect(frames[4].touches).toBeUndefined();
    expect(frames[5].effects).toEqual([{ effect: "probe", value: { ok: true } }]);
  });

  test("freezes GoldenSpec, DevTools, PPSSPP and Vapor inputs into one shape", () => {
    const golden = goldenSpecToInputTape("golden", {
      frames: 4,
      input: (frame) => frame === 1 ? 0x2000 : 0,
      touch: (frame) => frame >= 1 && frame < 3 ? [{ id: 0, x: 20 + frame, y: 30 }] : [],
    });
    expect(golden.tracks.find((track) => track.kind === "button")).toEqual({
      kind: "button",
      control: "primary",
      samples: [
        { frame: 1, pressed: true },
        { frame: 2, pressed: false },
      ],
    });
    expect(golden.tracks.find((track) => track.kind === "touch")?.samples).toEqual([
      { frame: 1, phase: "start", x: 21, y: 30 },
      { frame: 2, phase: "move", x: 22, y: 30 },
      { frame: 3, phase: "end", x: 22, y: 30 },
    ]);

    const devtools = devtoolsTapeToInputTape("devtools", {
      frames: 4,
      masks: [[0, 4]],
      analog: [[0x8080, 2], [0x0080, 1], [0x8080, 1]],
      touch: [[1, [((30 << 9) | 20) >>> 0]]],
      startFrame: 0,
    });
    const devFrames = expandInputTape(devtools);
    expect(devFrames[2].analog).toBe(0x0080);
    expect(devFrames[1].touches).toEqual([((30 << 9) | 20) >>> 0]);
    expect(devFrames[2].touches).toBeUndefined();

    const ppsspp = expandInputTape(
      ppssppScriptToInputTape("ppsspp", 4, "0:0,1:0x40,3:0"),
    );
    expect(ppsspp.map((frame) => frame.buttons)).toEqual([0, 0x40, 0x40, 0]);

    const vapor = vaporTodoToInputTape("vapor", [7, 0], { bootFrames: 1, spacing: 2 });
    expect(vapor.frames).toBe(5);
    expect(expandInputTape(vapor).map((frame) => frame.buttons)).toEqual([
      0,
      0x40,
      0,
      0x2000,
      0,
    ]);
  });

  test("rejects wrapped recorder tapes instead of approximate replay", () => {
    expect(() => devtoolsTapeToInputTape("wrapped", {
      frames: 1,
      masks: [[0, 1]],
      startFrame: 99,
    })).toThrow(/startFrame must be 0/);
  });
});

describe("native quick runner", () => {
  test("separates correctness and measurement replays", async () => {
    const worlds: FakeWorld[] = [];
    const idleScenario = scenario("idle");
    const adapter: NativeBootAdapter = {
      async boot(sourceRoot, parsedScenario) {
        expect(sourceRoot).toEndWith("candidate-source");
        expect(parsedScenario.subject.entry).toBe("idle-fixture-main");
        const world = new FakeWorld();
        worlds.push(world);
        return world;
      },
    };

    const result = await runNativeQuick(idleScenario, {
      sourceRoot: "/tmp/candidate-source",
      bootAdapter: adapter,
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(worlds).toHaveLength(2);
    expect(worlds[0].treeReads).toBe(1);
    expect(worlds[1].treeReads).toBe(0);
    expect(worlds[0].jobDrains).toBe(idleScenario.frames);
    expect(worlds[1].jobDrains).toBe(idleScenario.frames);
    expect(result.correctness.finalFramebufferHash)
      .toBe(result.measurement.finalFramebufferHash);
    expect(result.correctness.drawListHash)
      .toBe(result.measurement.finalDrawListHash);
    expect(result.measurement.phases.map((phase) => phase.name)).toEqual(["idle"]);
    expect(result.diagnosticMetrics["native.measured_frames"].value).toBe(600);
    expect(result.unsupportedMetrics).toContain("guest.instructions");
    expect(result.correctness.drawListHash).toStartWith("fnv1a64:");
  });

  test("returns structured unsupported instead of placeholder metrics", async () => {
    const result = await runNativeQuick(scenario("damage"), {
      sourceRoot: "/tmp/unused",
      bootAdapter: { async boot() { throw new Error("must not boot"); } },
    });
    expect(result.status).toBe("unsupported");
    if (result.status !== "unsupported") return;
    expect(result.reasons.some((reason) => reason.includes("core-lab"))).toBe(true);
    expect(result.reasons.some((reason) => reason.includes("fixture.core.damage"))).toBe(true);
    expect(Object.hasOwn(result, "metrics")).toBe(false);
  });

  test("dispatches damage and Vapor through their specialized suite adapters", async () => {
    const calls: string[] = [];
    const unsupported = async (
      parsedScenario: ReturnType<typeof scenario>,
      options: { readonly sourceRoot: string; readonly harnessRoot: string },
    ): Promise<NativeRunResult> => {
      calls.push(`${parsedScenario.subject.family}:${parsedScenario.id}`);
      expect(options).toMatchObject({
        sourceRoot: "/tmp/candidate-source",
        harnessRoot: "/tmp/perf-harness",
      });
      return {
        schemaVersion: 1,
        kind: "pocketjs.perf.native-result",
        status: "unsupported",
        scenarioId: parsedScenario.id,
        executor: "native",
        reasons: ["fixture adapter disabled by this unit test"],
      };
    };
    const result = await runNativeSuite("quick", {
      sourceRoot: "/tmp/candidate-source",
      harnessRoot: "/tmp/perf-harness",
      scenarioDir: SCENARIO_DIR,
      maxEstimatedSeconds: 1500,
      bootAdapter: { async boot() { return new FakeWorld(); } },
      suiteAdapters: { damage: unsupported, vapor: unsupported },
    });
    expect(result.results).toHaveLength(12);
    expect(result.results.filter((item) => item.status === "ok")).toHaveLength(10);
    expect(result.results
      .filter((item) => item.status === "unsupported")
      .map((item) => item.scenarioId)
      .sort()).toEqual(["core.damage-cases.v1", "vapor.todo.reactive-grid.v1"]);
    expect(calls).toEqual([
      "core-lab:core.damage-cases.v1",
      "vapor:vapor.todo.reactive-grid.v1",
    ]);
  });
});

class FakeWorld implements NativeSimWorld {
  readonly ticksPerFrame = 1;
  readonly effects: unknown[] = [];
  treeReads = 0;
  jobDrains = 0;
  private value = 0;

  frame(buttons: number, analog = 0x8080, touches?: readonly number[]): void {
    this.value = Math.imul(this.value ^ buttons ^ analog ^ (touches?.[0] ?? 0), 16777619) >>> 0;
  }

  async drainJobs(): Promise<void> {
    this.jobDrains++;
    await Promise.resolve();
  }

  tick(): void {
    this.value = (this.value + 1) >>> 0;
  }

  render(): Uint8Array {
    return new Uint8Array([
      this.value & 0xff,
      (this.value >>> 8) & 0xff,
      (this.value >>> 16) & 0xff,
      (this.value >>> 24) & 0xff,
    ]);
  }

  drawHash(): string {
    return `fnv1a64:${this.value.toString(16).padStart(16, "0")}`;
  }

  getTree(): unknown {
    this.treeReads++;
    return { value: this.value };
  }
}
