import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWasmUi } from "../hosts/web/wasm-ops.js";
import {
  PHYSICS_HANDLE_GEN_SHIFT,
  PHYSICS_HANDLE_KIND_SHIFT,
  PHYSICS_KIND,
  PHYSICS_MODE,
  PHYSICS_QUERY as Q,
} from "../contracts/spec/physics.ts";
import { WORD_BOX } from "../apps/nexus/art.ts";
import { WORD } from "../apps/nexus/homepage.ts";
import { WORD_TOP } from "../apps/nexus/scene.ts";

// apps/nexus on the wasm core with the 3DS geometry: a 400x240 primary and a
// 320x240 auxiliary surface, the guest the 3ds-dev build ships, and a stylus
// tape on the bottom screen. The spill must put every letter in its slot, and
// the whole run must be a pure function of the tape.

const ROOT = new URL("..", import.meta.url).pathname;
const OUT = mkdtempSync(join(tmpdir(), "pocketjs-nexus-"));
const GUEST = join(OUT, "guest", "nexus-main");
const GLOBALS = ["ui", "__pak", "__simHz", "frame"] as const;
const saved = new Map(GLOBALS.map((key) => [key, (globalThis as any)[key]]));

beforeAll(() => {
  const build = Bun.spawnSync(
    [process.execPath, "tools/3ds.ts", "nexus", "--pocket-only", `--outdir=${join(OUT, "guest")}`, `--package-outdir=${OUT}`],
    { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
  );
  if (build.exitCode !== 0) throw new Error(`nexus guest build failed\n${build.stdout}${build.stderr}`);
}, 120_000);

afterAll(() => {
  for (const [key, value] of saved) (globalThis as any)[key] = value;
  rmSync(OUT, { recursive: true, force: true });
});

/** A handle the core issued for the object in `slot`, first generation. */
const handle = (kind: number, slot: number) => (kind << PHYSICS_HANDLE_KIND_SHIFT) | (0 << PHYSICS_HANDLE_GEN_SHIFT) | slot;

async function run(frames: number, tape: Record<number, [number, number] | null>, probe: (frame: number, ops: any, wasm: any) => void) {
  const wasm = await createWasmUi(await Bun.file(`${ROOT}hosts/web/pocketjs.wasm`).arrayBuffer(), { width: 400, height: 240, auxiliary: [320, 240] });
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
      if (next && !touch) hit = wasm.ops.hitTestBoundsAuxiliary?.(next[0], next[1]) ?? 0;
      touch = next;
    }
    g.frame(0, 0x8080, touch ? [(touch[1] << 9) | touch[0]] : [], touch ? [hit] : [], touch ? [1] : [], 0x8080);
    wasm.tick();
    probe(frame, wasm.ops, wasm);
  }
  return wasm;
}

/** FNV-1a over both surfaces' pixels. */
function hash(...buffers: Uint8Array[]): number {
  let h = 0x811c9dc5;
  for (const buffer of buffers) for (let i = 0; i < buffer.length; i++) h = Math.imul(h ^ buffer[i], 0x01000193) >>> 0;
  return h;
}

const TAP_POCKET: Record<number, [number, number] | null> = { 40: [160, 180], 44: null };

test("tapping the pocket spills POCKET NEXUS into its slots on the top screen", async () => {
  let before = 0, after: Uint8Array | undefined;
  const wasm = await run(300, TAP_POCKET, (frame, _ops, w) => {
    if (frame === 39) before = hash(w.render());
    if (frame === 299) after = w.render().slice();
  });
  expect(before).not.toBe(hash(after!));
  // the app's world is the first one created; its letters are the anchored
  // bodies whose rest positions lie in the wordmark block
  const world = handle(PHYSICS_KIND.world, 1);
  const q = (query: number, h: number) => wasm.ops.physicsQuery!(query, h);
  const letters: number[] = [];
  for (let slot = 1; slot < 64; slot++) {
    const body = handle(PHYSICS_KIND.body, slot);
    const y = q(Q.anchorY, body);
    if (q(Q.mode, body) === PHYSICS_MODE.anchored && y > WORD_TOP && y < WORD_TOP + WORD_BOX.h) letters.push(body);
  }
  expect(letters.length).toBe(WORD.length);
  for (const b of letters) {
    expect(q(Q.speed, b)).toBeLessThan(40); // settled, not flying
    expect(q(Q.airborne, b)).toBe(0);
    expect(Math.abs(q(Q.y, b) - q(Q.anchorY, b))).toBeLessThan(3); // resting on its flexbox slot
  }
  expect(wasm.ops.physicsQuery!(Q.pick, world, 160, 180, 1, 0)).toBe(0); // the pocket is not pickable
}, 60_000);

test("the scene is a pure function of the stylus tape", async () => {
  const tape = { ...TAP_POCKET, 260: [160, 180], 264: null, 300: [160, 175], 303: null } as Record<number, [number, number] | null>;
  const hashes: number[][] = [[], []];
  for (const k of [0, 1]) {
    await run(420, tape, (frame, _ops, w) => {
      if (frame % 60 === 59) hashes[k].push(hash(w.render(), w.renderAuxiliary()));
    });
  }
  expect(hashes[0]).toEqual(hashes[1]);
  expect(new Set(hashes[0]).size).toBeGreaterThan(3);
}, 60_000);
