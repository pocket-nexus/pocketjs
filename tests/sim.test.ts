// tests/sim.test.ts — the determinism proof (docs/DETERMINISM.md).
//
// Runs the café journey — an async menu fetch, focus navigation, an order
// mutation with latency, a timer-driven auto-dismiss; everything that makes
// ordinary UI tests flake — through the deterministic sim host and asserts
// the architectural claims directly:
//
//   1. IDENTITY    same tape -> byte-identical per-frame pixel trace, run
//                  after run.
//   2. CHAOS       real wall-clock sleeps, allocation churn and forced GC
//                  injected between frames change NOTHING — the wall clock
//                  is not an input to this world.
//   3. LOW HZ      the same journey runs at 4 Hz and 2 Hz (13 frames instead
//                  of 390) and is just as deterministic.
//   4. SUBSAMPLING a low-rate world is not an approximation: frame m of the
//                  hz-world equals frame (60/hz)(m+1)-1 of the 60 Hz world,
//                  byte for byte, for EVERY m.
//   5. ALIGNMENT   effects land at the same virtual second at every rate,
//                  and the settled final screen is byte-equal across rates.

import { describe, expect, test } from "bun:test";
import { bootWorld, fnv1a, runScenario, treeHasText, type Trace } from "../hosts/sim/sim.ts";
import { BTN } from "../contracts/spec/spec.ts";

// The user journey, in virtual seconds (one script drives every rate; the
// 0.5 s grid lands on an exact frame at 60/4/2 Hz).
const JOURNEY = [
  { at: 1.0, press: BTN.CIRCLE }, // add ESPRESSO (autofocused row 0)
  { at: 1.5, press: BTN.DOWN }, // focus OAT LATTE
  { at: 2.0, press: BTN.CIRCLE }, // add it
  { at: 3.0, press: BTN.CIRCLE }, // and again (x2)
  { at: 3.5, press: BTN.START }, // place the order
];
const SECONDS = 6.5; // menu@0.5, order placed@3.5, confirmed@4.5, reset@6.0

const scenario = (hz: number) => ({ app: "cafe-main", hz, seconds: SECONDS, script: JOURNEY });
const lifecycleFixture = "sim-lifecycle-main";

// One shared set of reference traces; individual tests re-run and compare.
const t60: Trace = await runScenario(scenario(60));
const t4: Trace = await runScenario(scenario(4));
const t2: Trace = await runScenario(scenario(2));

describe("determinism", () => {
  test("same tape, same world: repeat runs are hash-identical", async () => {
    for (let i = 0; i < 2; i++) {
      const again = await runScenario(scenario(60));
      expect(again.hashes).toEqual(t60.hashes);
      expect(again.effects).toEqual(t60.effects);
    }
  }, 30000);

  test("chaos cannot reach the world: sleeps + garbage + GC change nothing", async () => {
    const chaos = await runScenario(scenario(60), { maxSleepMs: 8, gcEvery: 60 });
    expect(chaos.hashes).toEqual(t60.hashes);
    expect(chaos.effects).toEqual(t60.effects);
  }, 30000);

  test("the low-rate worlds are deterministic too", async () => {
    expect((await runScenario(scenario(4))).hashes).toEqual(t4.hashes);
    expect((await runScenario(scenario(2))).hashes).toEqual(t2.hashes);
  }, 30000);
});

describe("the virtual clock", () => {
  test("an hz-world is the 60 Hz trajectory, strictly subsampled", () => {
    for (const t of [t4, t2]) {
      const k = 60 / t.hz;
      for (let m = 0; m < t.frames; m++) {
        expect(t.hashes[m]).toBe(t60.hashes[k * (m + 1) - 1]);
      }
    }
    // 6.5 virtual seconds is 390 observations at 60 Hz — and 13 at 2 Hz.
    expect(t60.frames).toBe(390);
    expect(t2.frames).toBe(13);
  });

  test("effects land at the same virtual second at every rate", () => {
    const seconds = (t: Trace) => t.effects.map((e) => ({ t: e.t as string, kind: e.kind, sec: e.frame / t.hz }));
    const want = [
      { t: "command", kind: "menu", sec: 0 },
      { t: "delivery", kind: "menu", sec: 0.5 },
      { t: "command", kind: "order", sec: 3.5 },
      { t: "delivery", kind: "order", sec: 4.5 },
    ];
    expect(seconds(t60)).toEqual(want);
    expect(seconds(t4)).toEqual(want);
    expect(seconds(t2)).toEqual(want);
  });

  test("the settled final screen is byte-equal across rates", () => {
    expect(Buffer.from(t4.finalFrame).equals(Buffer.from(t60.finalFrame))).toBe(true);
    expect(Buffer.from(t2.finalFrame).equals(Buffer.from(t60.finalFrame))).toBe(true);
  });
});

describe("the journey actually happened", () => {
  test("order placed, cart reset, world settled", () => {
    // The trace's tree probe (a DevTools getTree after the final frame) is
    // the sim's selector query — assert on content, not just pixels.
    expect(treeHasText(t60.tree, "ORDERS PLACED 1")).toBe(true);
    expect(treeHasText(t60.tree, "TOTAL $0.00")).toBe(true);
    expect(treeHasText(t60.tree, "OAT LATTE")).toBe(true);
    expect(treeHasText(t2.tree, "ORDERS PLACED 1")).toBe(true);
  });
});

describe("sim world lifecycle", () => {
  test("a newer overlapping boot supersedes the older request", async () => {
    const baseline = await bootWorld("cafe-main", 60);
    baseline.frame(0);
    baseline.tick();
    const expected = fnv1a(baseline.render());
    const [older, newer] = await Promise.allSettled([
      bootWorld("cafe-main", 60),
      bootWorld("cafe-main", 60),
    ]);

    expect(older.status).toBe("rejected");
    if (older.status === "rejected") {
      expect(String(older.reason)).toContain("superseded by a newer boot");
    }
    expect(newer.status).toBe("fulfilled");
    if (newer.status === "fulfilled") {
      newer.value.frame(0);
      newer.value.tick();
      expect(newer.value.render().byteLength).toBe(480 * 272 * 4);
      expect(fnv1a(newer.value.render())).toBe(expected);
    }
  });

  test("a stale overlapping request never mutates ops or installs globals", async () => {
    let olderMutations = 0;
    let newerMutations = 0;
    let olderEvals = 0;
    let newerEvals = 0;
    const [older, newer] = await Promise.allSettled([
      bootWorld(
        lifecycleFixture,
        60,
        { __simLifecycleEval: () => { olderEvals++; } },
        () => { olderMutations++; },
      ),
      bootWorld(
        lifecycleFixture,
        60,
        { __simLifecycleEval: () => { newerEvals++; } },
        () => { newerMutations++; },
      ),
    ]);

    expect(older.status).toBe("rejected");
    expect(newer.status).toBe("fulfilled");
    expect({ olderMutations, olderEvals }).toEqual({ olderMutations: 0, olderEvals: 0 });
    expect({ newerMutations, newerEvals }).toEqual({ newerMutations: 1, newerEvals: 1 });
  });

  test("a boot started from mutateOps supersedes its candidate before eval", async () => {
    let nested: Promise<Awaited<ReturnType<typeof bootWorld>>> | undefined;
    let outerEvals = 0;
    let candidateUiWasInstalled = false;
    const outer = bootWorld(
      lifecycleFixture,
      60,
      { __simLifecycleEval: () => { outerEvals++; } },
      (ops) => {
        candidateUiWasInstalled = (globalThis as Record<string, unknown>).ui === ops;
        nested = bootWorld(lifecycleFixture, 60);
      },
    );

    await expect(outer).rejects.toThrow("superseded by a newer boot");
    expect(outerEvals).toBe(0);
    expect(candidateUiWasInstalled).toBe(true);
    const active = await nested;
    expect(active).toBeDefined();
    expect(active?.render().byteLength).toBe(480 * 272 * 4);
  });

  test("an extra-global getter can supersede a candidate before eval", async () => {
    let nested: Promise<Awaited<ReturnType<typeof bootWorld>>> | undefined;
    let outerEvals = 0;
    const extraGlobals: Record<string, unknown> = {
      __simLifecycleEval: () => { outerEvals++; },
    };
    Object.defineProperty(extraGlobals, "__simLifecycleExtraProbe", {
      enumerable: true,
      get() {
        nested = bootWorld(lifecycleFixture, 60);
        return true;
      },
    });

    const outer = bootWorld(lifecycleFixture, 60, extraGlobals);
    await expect(outer).rejects.toThrow("superseded by a newer boot");
    expect(outerEvals).toBe(0);
    const active = await nested;
    expect(active).toBeDefined();
    expect(active?.render().byteLength).toBe(480 * 272 * 4);
  });

  test("a boot started from bundle eval supersedes its candidate before commit", async () => {
    let nested: Promise<Awaited<ReturnType<typeof bootWorld>>> | undefined;
    const outer = bootWorld(lifecycleFixture, 60, {
      __simLifecycleEval: () => { nested = bootWorld(lifecycleFixture, 60); },
    });

    await expect(outer).rejects.toThrow("superseded by a newer boot");
    const active = await nested;
    expect(active).toBeDefined();
    expect(active?.render().byteLength).toBe(480 * 272 * 4);
  });

  test("a replaced world cannot drive the active world", async () => {
    let olderOps: Record<string, unknown> | undefined;
    const older = await bootWorld(
      "cafe-main",
      60,
      undefined,
      (ops) => { olderOps = ops; },
      { width: 720, height: 480 },
    );
    let activeOps: Record<string, unknown> | undefined;
    const active = await bootWorld(
      "cafe-main",
      60,
      undefined,
      (ops) => { activeOps = ops; },
      { width: 480, height: 272 },
    );

    expect(() => older.frame(0)).toThrow("superseded by a newer boot");
    expect(() => older.tick()).toThrow("superseded by a newer boot");
    expect(() => older.render()).toThrow("superseded by a newer boot");
    expect(() => older.getTree()).toThrow("superseded by a newer boot");
    expect(olderOps?.__viewport).toEqual({ w: 720, h: 480 });
    expect(activeOps?.__viewport).toEqual({ w: 480, h: 272 });
    expect(active.render().byteLength).toBe(480 * 272 * 4);
  });

  test("a fresh boot clears capabilities and custom globals from its predecessor", async () => {
    const marker = {};
    const globals = globalThis as Record<string, unknown>;
    await bootWorld("cafe-main", 60, {
      net: marker,
      media: marker,
      __simLifecycleProbe: marker,
    });
    expect(globals.net).toBe(marker);
    expect(globals.media).toBe(marker);
    expect(globals.__simLifecycleProbe).toBe(marker);

    await bootWorld("cafe-main", 60);
    expect(globals.net).toBeUndefined();
    expect(globals.media).toBeUndefined();
    expect(globals.__simLifecycleProbe).toBeUndefined();
  });

  test("a failed candidate restores the active world and all global descriptors", async () => {
    const active = await bootWorld("cafe-main", 60);
    active.frame(0);
    active.tick();
    const expected = fnv1a(active.render());
    const globals = globalThis as Record<string, unknown>;
    class AmbientNode {}
    const ambientNodeBefore = Object.getOwnPropertyDescriptor(globals, "Node");
    Object.defineProperty(globals, "Node", {
      configurable: true,
      enumerable: false,
      writable: true,
      value: AmbientNode,
    });
    try {
      const consoleObject = console as unknown as Record<PropertyKey, unknown>;
      const consoleLogBefore = Object.getOwnPropertyDescriptor(consoleObject, "log");
      const consoleBridgeBefore = Object.getOwnPropertyDescriptor(consoleObject, "__pocketBridge");
      const nodeHasInstanceBefore = Object.getOwnPropertyDescriptor(AmbientNode, Symbol.hasInstance);
      const before = new Map(
        Reflect.ownKeys(globalThis).map((key) => [
          key,
          Object.getOwnPropertyDescriptor(globalThis, key),
        ]),
      );

      await expect(bootWorld(lifecycleFixture, 60, {
        __simLifecycleFrameworkMarker: {},
        __simLifecycleMutateNestedGlobals: true,
        __simLifecycleThrowDuringEval: true,
      })).rejects.toThrow("sim lifecycle fixture eval failed");

      expect(globals.__simLifecycleEvalLeak).toBeUndefined();
      expect(Object.getOwnPropertyDescriptor(consoleObject, "log")).toEqual(consoleLogBefore);
      expect(Object.getOwnPropertyDescriptor(consoleObject, "__pocketBridge")).toEqual(consoleBridgeBefore);
      expect(Object.getOwnPropertyDescriptor(AmbientNode, Symbol.hasInstance)).toEqual(nodeHasInstanceBefore);
      expect(Reflect.ownKeys(globalThis).length).toBe(before.size);
      for (const [key, descriptor] of before) {
        expect(Object.getOwnPropertyDescriptor(globalThis, key)).toEqual(descriptor);
      }
      active.frame(0);
      active.tick();
      expect(fnv1a(active.render())).toBe(expected);
    } finally {
      if (ambientNodeBefore) Object.defineProperty(globals, "Node", ambientNodeBefore);
      else Reflect.deleteProperty(globals, "Node");
    }
  });

  test("a failed candidate restores the console bridge retired by devtools init", async () => {
    const active = await bootWorld("cafe-main", 60);
    const consoleObject = console as unknown as {
      __pocketBridge?: { current: unknown };
    };
    const holder = consoleObject.__pocketBridge;
    expect(holder).toBeDefined();
    const activeBridge = holder?.current;
    let candidateBridge: unknown;

    await expect(bootWorld(lifecycleFixture, 60, {
      __simLifecycleBridgeHolder: holder,
      __simLifecycleInitDevtools: true,
      __simLifecycleAfterDevtools: (current: unknown) => { candidateBridge = current; },
      __simLifecycleThrowDuringEval: true,
    })).rejects.toThrow("sim lifecycle fixture eval failed");

    expect(candidateBridge).toBeDefined();
    expect(candidateBridge).not.toBe(activeBridge);
    expect(consoleObject.__pocketBridge).toBe(holder);
    expect(holder?.current).toBe(activeBridge);
    expect(active.render().byteLength).toBe(480 * 272 * 4);
  });

  test("a failed mutateOps callback restores the active world", async () => {
    const globals = globalThis as Record<string, unknown>;
    const active = await bootWorld("cafe-main", 60);
    const activeUi = globals.ui;
    let candidateUiWasInstalled = false;
    await expect(bootWorld(lifecycleFixture, 60, undefined, (ops) => {
      candidateUiWasInstalled = globals.ui === ops;
      globals.__simLifecycleMutateLeak = {};
      throw new Error("sim lifecycle mutateOps failed");
    })).rejects.toThrow("sim lifecycle mutateOps failed");

    expect(candidateUiWasInstalled).toBe(true);
    expect(globals.ui).toBe(activeUi);
    expect(globals.__simLifecycleMutateLeak).toBeUndefined();
    expect(active.render().byteLength).toBe(480 * 272 * 4);
  });

  test("a later boot restores caller-owned property descriptors", async () => {
    const globals = globalThis as Record<string, unknown>;
    const key = "__simLifecycleDescriptorProbe";
    const original = {};
    const replacement = {};
    Object.defineProperty(globals, key, {
      configurable: true,
      enumerable: false,
      writable: true,
      value: original,
    });
    const descriptor = Object.getOwnPropertyDescriptor(globals, key);
    try {
      await bootWorld("cafe-main", 60, { [key]: replacement });
      expect(globals[key]).toBe(replacement);
      await bootWorld("cafe-main", 60);
      expect(Object.getOwnPropertyDescriptor(globals, key)).toEqual(descriptor);
    } finally {
      Reflect.deleteProperty(globals, key);
    }
  });

  test("a later boot clears globals created during framework evaluation", async () => {
    const marker = {};
    const keys = [
      "document",
      "window",
      "Node",
      "Element",
      "HTMLElement",
      "Text",
      "Comment",
      "__pocketjsNativeReturn",
    ];
    const before = new Map(keys.map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]));
    await bootWorld(lifecycleFixture, 60, {
      __simLifecycleCreateFrameworkGlobals: true,
      __simLifecycleFrameworkMarker: marker,
    });
    for (const key of keys) expect((globalThis as Record<string, unknown>)[key]).toBe(marker);

    await bootWorld("cafe-main", 60);
    for (const [key, descriptor] of before) {
      expect(Object.getOwnPropertyDescriptor(globalThis, key)).toEqual(descriptor);
    }
  });

  test("a later boot restores framework mutations inside global objects", async () => {
    const globals = globalThis as Record<string, unknown>;
    await bootWorld(lifecycleFixture, 60);
    class AmbientNode {}
    Object.defineProperty(globals, "Node", {
      configurable: true,
      enumerable: false,
      writable: true,
      value: AmbientNode,
    });
    const consoleObject = console as unknown as Record<PropertyKey, unknown>;
    const consoleLogBefore = Object.getOwnPropertyDescriptor(consoleObject, "log");
    const consoleBridgeBefore = Object.getOwnPropertyDescriptor(consoleObject, "__pocketBridge");
    const nodeHasInstanceBefore = Object.getOwnPropertyDescriptor(AmbientNode, Symbol.hasInstance);
    try {
      const marker = {};
      await bootWorld(lifecycleFixture, 60, {
        __simLifecycleFrameworkMarker: marker,
        __simLifecycleMutateNestedGlobals: true,
      });
      expect(consoleObject.log).toBe(marker);
      expect(consoleObject.__simLifecycleNested).toBe(marker);
      expect(Object.getOwnPropertyDescriptor(AmbientNode, Symbol.hasInstance)?.value).toBe(marker);

      await bootWorld(lifecycleFixture, 60);
      expect(Object.getOwnPropertyDescriptor(consoleObject, "log")).toEqual(consoleLogBefore);
      expect(Object.getOwnPropertyDescriptor(consoleObject, "__pocketBridge")).toEqual(consoleBridgeBefore);
      expect(consoleObject.__simLifecycleNested).toBeUndefined();
      expect(Object.getOwnPropertyDescriptor(AmbientNode, Symbol.hasInstance)).toEqual(nodeHasInstanceBefore);
    } finally {
      Reflect.deleteProperty(globals, "Node");
    }
  });

  test("a later boot clears a native-return hook installed after commit", async () => {
    const globals = globalThis as Record<string, unknown>;
    const before = Object.getOwnPropertyDescriptor(globals, "__pocketjsNativeReturn");
    await bootWorld(lifecycleFixture, 60);
    globals.__pocketjsNativeReturn = () => {};
    expect(typeof globals.__pocketjsNativeReturn).toBe("function");

    await bootWorld(lifecycleFixture, 60);
    expect(Object.getOwnPropertyDescriptor(globals, "__pocketjsNativeReturn")).toEqual(before);
  });
});
