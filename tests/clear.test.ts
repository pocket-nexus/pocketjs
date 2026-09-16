// Pocket Clear journeys on the deterministic sim: every gesture the app is
// built from, driven through the real vue-vapor entry (touch latching, the
// gesture pump, hit facts) at the iPod touch 4 viewport. Vue Vapor flushes
// dependent render effects on the microtask queue, so every frame awaits one
// promise turn before the tree is inspected (the vue-sfc-lab pattern).
//
// Geometry comes from the app's own JSX-free modules (metrics/keyboard
// metrics); pull gestures aim for the DISPLAYED overscroll thresholds through
// the scroller's rubber curve, so the finger travel below is comfortably past
// the ~130px / ~305px the curve maps PULL_CREATE / PULL_BACK to.

import { beforeAll, describe, expect, test } from "bun:test";
import { bootWorld, treeHasText, type SimWorld } from "../hosts/sim/sim.ts";
import { __packTouch } from "../framework/src/touch.ts";
import { KB_GAP, KB_H, KB_PAD, KB_ROW_H } from "../apps/clear/keyboard-metrics.ts";
import { KB_LAYERS, type KbKey } from "../apps/clear/kb-layout.ts";
import { ROW_H, SCREEN_H, SCREEN_W } from "../apps/clear/metrics.ts";

const W = SCREEN_W;
const H = SCREEN_H;

let world: SimWorld;

async function step(touches?: readonly number[]): Promise<void> {
  world.frame(0, undefined, touches);
  for (let tick = 0; tick < world.ticksPerFrame; tick++) world.tick();
  await Promise.resolve();
}

async function idle(frames: number): Promise<void> {
  for (let i = 0; i < frames; i++) await step();
}

async function tap(x: number, y: number): Promise<void> {
  await step([__packTouch(0, x, y)]);
  await step([__packTouch(0, x, y)]);
  await step();
}

async function glide(x0: number, y0: number, x1: number, y1: number, frames: number): Promise<void> {
  for (let f = 0; f <= frames; f++) {
    const t = f / frames;
    await step([__packTouch(0, Math.round(x0 + (x1 - x0) * t), Math.round(y0 + (y1 - y0) * t))]);
  }
  await step();
}

/** Screen center of a key on a layer, from the app's own geometry. */
function keyCenterIn(layer: keyof typeof KB_LAYERS, match: (key: KbKey) => boolean): [number, number] {
  const rows = KB_LAYERS[layer];
  for (let r = 0; r < rows.length; r++) {
    for (const key of rows[r]) {
      if (match(key)) {
        return [
          Math.round(key.x + key.w / 2),
          Math.round(H - KB_H + KB_PAD + r * (KB_ROW_H + KB_GAP) + KB_ROW_H / 2),
        ];
      }
    }
  }
  throw new Error("clear test: key not found");
}

const keyCenter = (match: (key: KbKey) => boolean) => keyCenterIn("lower", match);

async function tapKey(layer: keyof typeof KB_LAYERS, match: (key: KbKey) => boolean): Promise<void> {
  const [x, y] = keyCenterIn(layer, match);
  await tap(x, y);
  await idle(3);
}

const rowCenterY = (index: number) => index * ROW_H + ROW_H / 2;

describe("Pocket Clear on the sim", () => {
  beforeAll(async () => {
    world = await bootWorld("clear-main.vue-vapor", 60, undefined, undefined, {
      width: W,
      height: H,
      rasterDensity: 2,
    });
    await idle(5);
  });

  test("boots to the lists screen with the reference seed", () => {
    const tree = world.getTree();
    expect(treeHasText(tree, "How to Use")).toBe(true);
    expect(treeHasText(tree, "This is a demo")).toBe(true);
    expect(treeHasText(tree, "PocketJS + Vue Vapor")).toBe(true);
    expect(treeHasText(tree, "Test")).toBe(true);
    expect(treeHasText(tree, "Made with PocketJS + Vue Vapor")).toBe(true);
  });

  test("tap opens a list through the vertical unfold", async () => {
    await tap(160, rowCenterY(0));
    await idle(25);
    const tree = world.getTree();
    expect(treeHasText(tree, "Swipe right to complete")).toBe(true);
    expect(treeHasText(tree, "Pinch two rows apart to insert")).toBe(true);
    // Short and long titles share the row's 12-point left inset.
    const pixels = world.render();
    for (let row = 0; row < 4; row++) {
      let left = W;
      for (let y = row * ROW_H; y < (row + 1) * ROW_H; y++) {
        for (let x = 0; x < W; x++) {
          const i = (y * W + x) * 4;
          if (pixels[i] > 210 && pixels[i + 1] > 210 && pixels[i + 2] > 210) left = Math.min(left, x);
        }
      }
      expect(left).toBeGreaterThanOrEqual(12);
      expect(left).toBeLessThanOrEqual(16);
    }
  });

  test("swipe right completes the row under the finger", async () => {
    // 9 pending. Row 0 "Swipe right to complete" moves to the done pile.
    await glide(20, rowCenterY(0), 220, rowCenterY(0), 12);
    await idle(30);
    // Order is the proof: the next test deletes the NEW row 0 and expects it
    // to be "Swipe left to delete" — impossible if row 0 hadn't moved away.
    expect(treeHasText(world.getTree(), "Swipe right to complete")).toBe(true);
  });

  test("swipe left deletes", async () => {
    await glide(300, rowCenterY(0), 60, rowCenterY(0), 12);
    await idle(30);
    const tree = world.getTree();
    expect(treeHasText(tree, "Swipe left to delete")).toBe(false);
    expect(treeHasText(tree, "Swipe right to complete")).toBe(true); // done pile
  });

  test("long-press picks a row up and reorders it", async () => {
    // Rows: 0 "Tap to edit", 1 "Long tap to reorder", ... Hold row 0 past the
    // long-press deadline, carry it down two rows, release.
    for (let i = 0; i < 32; i++) await step([__packTouch(0, 160, rowCenterY(0))]);
    await glide(160, rowCenterY(0), 160, rowCenterY(2), 10);
    await idle(30);
    // "Long tap to reorder" is now row 0: deleting row 0 proves the order.
    await glide(300, rowCenterY(0), 60, rowCenterY(0), 12);
    await idle(30);
    const tree = world.getTree();
    expect(treeHasText(tree, "Long tap to reorder")).toBe(false);
    expect(treeHasText(tree, "Tap to edit")).toBe(true);
  });

  test("pull down creates a row and typing commits it", async () => {
    // ~230px of finger travel → ~100px displayed: past PULL_CREATE, short of
    // PULL_BACK. (A bare "|" can't probe the caret: the symbols layer's pipe
    // key is a literal "|" in the tree — assert through typed prefixes.)
    await glide(160, 60, 160, 290, 14);
    await idle(20);
    const [qx, qy] = keyCenter((key) => key.ch === "q");
    await tap(qx, qy);
    await idle(5);
    // The editor is open on the fresh row: the caret trails the typed glyph.
    expect(treeHasText(world.getTree(), "q|")).toBe(true);
    const [ex, ey] = keyCenter((key) => key.action === "return");
    await tap(ex, ey);
    await idle(20);
    expect(treeHasText(world.getTree(), "q|")).toBe(false);
    expect(treeHasText(world.getTree(), "q")).toBe(true);
  });

  test("pinch inserts a row; the keyboard walks its classic layers", async () => {
    // Two fingers on rows 1 and 2, diverging vertically.
    for (let f = 0; f <= 14; f++) {
      const spread = f * 4;
      await step([
        __packTouch(0, 160, rowCenterY(1) - Math.min(spread, 26)),
        __packTouch(1, 160, rowCenterY(2) + spread),
      ]);
    }
    await step();
    await idle(10);
    // The insert opened the editor on the fresh row. Exercise the classic
    // layout end to end: one-shot shift (Z, then back on lower), the "123"
    // layer (5), its in-place "#+=" toggle (€), and "ABC" home (m).
    await tapKey("lower", (key) => key.action === "shift");
    await tapKey("upper", (key) => key.ch === "Z");
    await tapKey("lower", (key) => key.action === "num");
    await tapKey("numbers", (key) => key.ch === "5");
    await tapKey("numbers", (key) => key.action === "sym");
    await tapKey("symbols", (key) => key.ch === "€");
    await tapKey("symbols", (key) => key.action === "abc");
    await tapKey("lower", (key) => key.ch === "m");
    expect(treeHasText(world.getTree(), "Z5€m|")).toBe(true);
    // Erase it all and commit the empty text: the fresh row is removed again
    // (the iOS keyboard has no dismiss key).
    for (let i = 0; i < 4; i++) await tapKey("lower", (key) => key.action === "backspace");
    await tapKey("lower", (key) => key.action === "return");
    await idle(20);
    expect(treeHasText(world.getTree(), "Z5€m|")).toBe(false);
  });

  test("held space scrubs the real editor; held backspace deletes and stops at lift", async () => {
    await tap(160, rowCenterY(0));
    await idle(20);
    const [bx, by] = keyCenter(key => key.action === "backspace");
    for (let i = 0; i < 180; i++) await step([__packTouch(0, bx, by)]);
    await step();
    // Probe a blank part of q's popup: quick taps retain it, then fade;
    // holding a character keeps it up beyond the minimum display duration.
    const [qx, qy] = keyCenter(key => key.ch === "q");
    const pixel = () => Array.from(world.render().slice(((qy - 64) * W + qx) * 4, ((qy - 64) * W + qx) * 4 + 3));
    const empty = pixel();
    await step([__packTouch(0, qx, qy)]); await step();
    const raised = pixel(); expect(raised).not.toEqual(empty);
    await idle(10); expect(pixel()).toEqual(raised);
    await idle(20); expect(pixel()).toEqual(empty);
    for (let i = 0; i < 35; i++) await step([__packTouch(0, qx, qy)]);
    expect(pixel()).toEqual(raised);
    await step(); await idle(5); expect(pixel()).toEqual(raised);
    await idle(20); expect(pixel()).toEqual(empty);
    await tapKey("lower", key => key.action === "backspace");
    await tapKey("lower", key => key.action === "backspace");
    for (const ch of "abcdef") await tapKey("lower", key => key.ch === ch);
    expect(treeHasText(world.getTree(), "abcdef|")).toBe(true);
    const [sx, sy] = keyCenter(key => key.ch === " ");
    const spacePixel = () => Array.from(world.render().slice((sy * W + sx - 60) * 4, (sy * W + sx - 60) * 4 + 3));
    const restingCap = spacePixel();
    await step([__packTouch(0, sx, sy)]);
    const pressedCap = spacePixel(); expect(pressedCap).not.toEqual(restingCap);
    // The cap stays pressed before and across the shorter 200 ms activation.
    for (let i = 0; i < 8; i++) await step([__packTouch(0, sx, sy)]);
    expect(spacePixel()).toEqual(pressedCap);
    for (let i = 0; i < 6; i++) await step([__packTouch(0, sx, sy)]);
    expect(spacePixel()).toEqual(pressedCap); // activation must not release the cap
    await step([__packTouch(0, sx - 30, sy)]);
    await step(); await idle(13);
    expect(spacePixel()).toEqual(restingCap);
    expect(treeHasText(world.getTree(), "abc|def")).toBe(true);
    await tapKey("lower", key => key.ch === "x");
    expect(treeHasText(world.getTree(), "abcx|def")).toBe(true);
    for (let i = 0; i < 40; i++) await step([__packTouch(0, bx, by)]);
    await step(); await idle(30);
    expect(treeHasText(world.getTree(), "|def")).toBe(true);
    await tapKey("lower", key => key.ch === "q");
    await idle(30); // no delayed repeat may erase q
    expect(treeHasText(world.getTree(), "q|def")).toBe(true);
    await tapKey("lower", key => key.action === "return");
    await idle(20);
  });

  test("pull up past the end clears the done pile", async () => {
    // One done row exists ("Swipe right to complete"); 9 rows total, so the
    // range max is 558-480=78 and the clear needs ~382px of finger travel.
    await glide(160, 470, 160, 40, 16);
    await idle(40);
    expect(treeHasText(world.getTree(), "Swipe right to complete")).toBe(false);
    expect(treeHasText(world.getTree(), "q")).toBe(true); // pending row stays
  });

  test("pulling down further navigates back to the lists", async () => {
    await glide(160, 60, 160, 460, 20);
    await idle(30);
    const tree = world.getTree();
    expect(treeHasText(tree, "This is a demo")).toBe(true);
    // "How to Use" went 9 pending → complete/delete/delete/create → 8, and
    // the live count cell reflects it.
    expect(treeHasText(tree, "8")).toBe(true);
  });
});
