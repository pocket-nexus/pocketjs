import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWasmUi } from "../hosts/web/wasm-ops.js";
import {
  PHYSICS_HANDLE_KIND_SHIFT,
  PHYSICS_KIND,
  PHYSICS_MODE,
  PHYSICS_QUERY as Q,
} from "../contracts/spec/physics.ts";
import { LETTER_ART } from "../apps/nexus-touch/art.ts";
import { POCKET_CX, POCKET_TOP_Y } from "../apps/nexus-touch/scene.ts";
import { resolveIPodTouch4BuildPlan } from "../tools/ipodtouch4-profile.ts";

// apps/nexus-touch on the wasm core at the iPod touch 4's 320x480 @2x, the
// guest the ipodtouch4-dev build embeds, driven by a touch tape. The intro
// must spill every letter into its slot; a letter dropped in the pocket's
// mouth must come back to it; the whole run must be a pure function of the
// tape.

const ROOT = new URL("..", import.meta.url).pathname;
const OUT = mkdtempSync(join(tmpdir(), "pocketjs-nexus-touch-"));
const GUEST = join(OUT, "guest", "nexus-touch-main");
const GLOBALS = ["ui", "__pak", "__simHz", "frame"] as const;
const saved = new Map(GLOBALS.map((key) => [key, (globalThis as any)[key]]));

beforeAll(() => {
  const plan = resolveIPodTouch4BuildPlan(JSON.parse(readFileSync(join(ROOT, "apps/nexus-touch/pocket.json"), "utf8")));
  writeFileSync(join(OUT, "plan.json"), JSON.stringify(plan));
  const build = Bun.spawnSync(
    [process.execPath, "tools/build.ts", `--plan=${join(OUT, "plan.json")}`, `--outdir=${join(OUT, "guest")}`],
    { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
  );
  if (build.exitCode !== 0) throw new Error(`nexus-touch guest build failed\n${build.stdout}${build.stderr}`);
}, 120_000);

afterAll(() => {
  for (const [key, value] of saved) (globalThis as any)[key] = value;
  rmSync(OUT, { recursive: true, force: true });
});

/** A handle the core issued for the object in `slot`, first generation. */
const handle = (kind: number, slot: number) => (kind << PHYSICS_HANDLE_KIND_SHIFT) | slot;

type Tape = Record<number, [number, number] | null>;

async function run(frames: number, tape: Tape, probe: (frame: number, wasm: any) => void = () => {}) {
  const wasm = await createWasmUi(await Bun.file(`${ROOT}hosts/web/pocketjs.wasm`).arrayBuffer(), { width: 320, height: 480, rasterDensity: 2 });
  const g = globalThis as any;
  g.ui = wasm.ops;
  g.__pak = await Bun.file(`${GUEST}.pak`).arrayBuffer();
  g.__simHz = 60;
  g.frame = undefined;
  (0, eval)(await Bun.file(`${GUEST}.js`).text());
  let touch: [number, number] | null = null;
  let hit = 0;
  for (let frame = 0; frame < frames; frame++) {
    if (frame in tape) {
      const next = tape[frame];
      if (next && !touch) hit = wasm.ops.hitTestBounds?.(next[0], next[1]) ?? 0;
      touch = next;
    }
    g.frame(0, 0x8080, touch ? [(touch[1] << 9) | touch[0]] : [], touch ? [hit] : [], touch ? [0] : [], 0x8080);
    wasm.tick();
    probe(frame, wasm);
  }
  return wasm;
}

/** The letter bodies, in word order: the bodies whose rest is a letter's
 *  home (layout places the slot boxes on whole pixels). */
function letterBodies(wasm: any): number[] {
  const q = (query: number, h: number) => wasm.ops.physicsQuery!(query, h);
  return LETTER_ART.map((l) => {
    for (let slot = 1; slot < 64; slot++) {
      const body = handle(PHYSICS_KIND.body, slot);
      if (Math.abs(q(Q.anchorX, body) - l.home[0]) <= 0.5 && Math.abs(q(Q.anchorY, body) - l.home[1]) <= 0.5) return body;
    }
    throw new Error(`no body rests at ${l.ch}'s home`);
  });
}

function settledHome(wasm: any, body: number) {
  const q = (query: number) => wasm.ops.physicsQuery!(query, body);
  expect(q(Q.mode)).toBe(PHYSICS_MODE.anchored);
  expect(q(Q.speed)).toBeLessThan(40);
  expect(q(Q.airborne)).toBe(0);
  expect(Math.abs(q(Q.x) - q(Q.anchorX))).toBeLessThan(3);
  expect(Math.abs(q(Q.y) - q(Q.anchorY))).toBeLessThan(3);
}

/** FNV-1a over the framebuffer. */
function hash(buffer: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < buffer.length; i++) h = Math.imul(h ^ buffer[i], 0x01000193) >>> 0;
  return h;
}

test("the intro spills POCKET NEXUS into the slots the homepage laid out", async () => {
  let before = 0;
  const wasm = await run(300, {}, (frame, w) => { if (frame === 20) before = hash(w.render()); });
  expect(hash(wasm.render())).not.toBe(before);
  for (const body of letterBodies(wasm)) settledHome(wasm, body);
  // the pocket is not pickable; a letter is
  const world = handle(PHYSICS_KIND.world, 1);
  expect(wasm.ops.physicsQuery!(Q.pick, world, POCKET_CX, POCKET_TOP_Y + 40, 0, 0)).toBe(0);
  const [hx, hy] = LETTER_ART[0].home;
  expect(wasm.ops.physicsQuery!(Q.pick, world, hx, hy, 0, 0)).toBe(letterBodies(wasm)[0]);
}, 60_000);

test("a letter dropped in the pocket's mouth is chewed and spat back home", async () => {
  // drag the C from its slot down onto the pocket's mouth and let go there
  const [cx, cy] = LETTER_ART[2].home.map(Math.round);
  const tape: Tape = { 300: [cx, cy] };
  for (let k = 1; k <= 30; k++) tape[300 + k] = [Math.round(cx + ((POCKET_CX - cx) * k) / 30), Math.round(cy + ((POCKET_TOP_Y - cy) * k) / 30)];
  tape[340] = null;
  let hidden = false, c = 0;
  const wasm = await run(560, tape, (frame, w) => {
    if (frame === 299) c = letterBodies(w)[2];
    // parked inside the pocket, out of sight, until it is spat back
    if (frame === 380) hidden = w.ops.physicsQuery!(Q.y, c) > 480;
  });
  expect(hidden).toBe(true);
  for (const body of letterBodies(wasm)) settledHome(wasm, body);
}, 60_000);

test("the scene is a pure function of the touch tape", async () => {
  const [px, py] = [POCKET_CX, Math.round(POCKET_TOP_Y + 40)];
  const tape: Tape = { 260: [px, py], 264: null, 300: [px, py], 303: null, 330: [px, py], 334: null, 380: [60, 200], 383: null, 390: [60, 200], 393: null };
  const hashes: number[][] = [[], []];
  for (const k of [0, 1]) {
    await run(480, tape, (frame, w) => { if (frame % 60 === 59) hashes[k].push(hash(w.render())); });
  }
  expect(hashes[0]).toEqual(hashes[1]);
  expect(new Set(hashes[0]).size).toBeGreaterThan(5);
}, 60_000);
