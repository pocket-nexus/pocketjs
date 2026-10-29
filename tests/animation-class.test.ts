// tests/animation-class.test.ts — the animation class a profile states, the
// plan that records it, and animate() on a still display.

import { describe, expect, test } from "bun:test";
import { ANIMATION_CLASSES } from "../contracts/spec/animation.ts";
import {
  POCKET_CAPABILITIES,
  POCKET_TARGETS,
  definePlatformContractRegistry,
  defineTargetRegistry,
} from "../contracts/spec/platforms.ts";
import { PROP } from "../contracts/spec/spec.ts";
import { installHost, type HostOps } from "../framework/src/host.ts";
import { validateAndResolveBuildPlan } from "../framework/src/manifest/resolve.ts";
import { parsePocketProfile, validatePocketProfile } from "../framework/src/profile.ts";
import { POCKET_PROFILES } from "../profiles/index.ts";
import { targetProfile } from "../profiles/contract.ts";
import { THREE_DS_DEV_CONTRACTS, THREE_DS_DEV_TARGET_ID } from "../tools/3ds-profile.ts";

/** An ESP-IDF program's profile: a CPU rasterizer, a repaint target. */
const tab5 = parsePocketProfile({
  format: "pocket-profile/2",
  id: "tab5-test",
  platform: "esp-idf",
  form: "takeover",
  cadences: [30],
  display: {
    logicalViewports: [[480, 272]],
    presentations: ["native", "integer-fit"],
    rasterDensity: 1,
    animation: "repaint",
  },
  panel: { primary: [480, 272] },
  capabilities: ["input.analog.left", "input.buttons", "text.glyphs.baked"],
});
const TAB5_CONTRACTS = definePlatformContractRegistry(
  POCKET_CAPABILITIES,
  defineTargetRegistry({ [tab5.id]: targetProfile(tab5) }),
);

const manifest = () => Bun.file(new URL("./fixtures/manifests/portable-psp.json", import.meta.url)).json();

describe("profile animation classes", () => {
  test("every built-in profile states a class", () => {
    for (const profile of Object.values(POCKET_PROFILES)) expect(ANIMATION_CLASSES).toContain(profile.display.animation);
  });

  test("GPU consoles composite, a CPU rasterizer repaints, electronic paper is still", () => {
    expect(POCKET_TARGETS.psp.display.animation).toBe("composited");
    expect(POCKET_TARGETS.vita.display.animation).toBe("composited");
    expect(THREE_DS_DEV_CONTRACTS.targets[THREE_DS_DEV_TARGET_ID]!.display.animation).toBe("composited");
    expect(POCKET_TARGETS.pocketbook.display.animation).toBe("still");
    expect(TAB5_CONTRACTS.targets["tab5-test"]!.display.animation).toBe("repaint");
  });

  test("a profile without a class or with an unknown one is refused", () => {
    const { animation: _animation, ...display } = tab5.display;
    expect(validatePocketProfile({ ...tab5, display }).ok).toBe(false);
    expect(validatePocketProfile({ ...tab5, display: { ...tab5.display, animation: "sometimes" } }).ok).toBe(false);
  });
});

describe("the plan", () => {
  test("records the class of the profile it resolved", async () => {
    const psp = validateAndResolveBuildPlan(await manifest(), { target: "psp" });
    expect(psp.ok).toBe(true);
    if (psp.ok) expect(psp.plan.animation).toBe("composited");
    const idf = validateAndResolveBuildPlan(await manifest(), { target: tab5.id }, TAB5_CONTRACTS);
    expect(idf.ok).toBe(true);
    if (idf.ok) expect(idf.plan.animation).toBe("repaint");
    const gpu = parsePocketProfile({ ...tab5, id: "tab5-gpu", display: { ...tab5.display, animation: "composited" } });
    const composited = validateAndResolveBuildPlan(await manifest(), { target: gpu.id },
      definePlatformContractRegistry(POCKET_CAPABILITIES, defineTargetRegistry({ [gpu.id]: targetProfile(gpu) })));
    expect(composited.ok && composited.plan.animation).toBe("composited");
  });
});

describe("animate() by class", () => {
  const calls: unknown[][] = [];
  const rec = (name: string) => (...args: unknown[]) => void calls.push([name, ...args]);
  const ops = {
    setProp: rec("setProp"),
    animate(...args: number[]) {
      calls.push(["animate", ...args]);
      return 7;
    },
    cancelAnim: rec("cancelAnim"),
  } as unknown as HostOps;

  test("a bundle built without a plan composites, and a tween reaches the core", async () => {
    const { animate, animationClass } = await import("../framework/src/anim.ts");
    expect(animationClass).toBe("composited");
    installHost({ ops, kind: "injected", target: "test", strict: false });
    calls.length = 0;
    expect(animate(5, "opacity", 0, { dur: 100 })).toBe(7);
    expect(calls).toEqual([["animate", 5, PROP.opacity, 0, 100, expect.any(Number), 0]]);
  });

  test("on a still display a tween is its end value and no animation", async () => {
    (globalThis as { __POCKET_ANIMATION__?: string }).__POCKET_ANIMATION__ = "still";
    try {
      const { animate, spring, animationClass } = await import(`../framework/src/anim.ts?still=${Date.now()}`);
      expect(animationClass).toBe("still");
      installHost({ ops, kind: "injected", target: "test", strict: false });
      calls.length = 0;
      expect(animate(5, "translateX", 40)).toBe(0);
      expect(spring(5, "scale", 1)).toBe(0);
      expect(calls).toEqual([
        ["setProp", 5, PROP.translateX, 40],
        ["setProp", 5, PROP.scale, 1],
      ]);
    } finally {
      delete (globalThis as { __POCKET_ANIMATION__?: string }).__POCKET_ANIMATION__;
    }
  });
});
