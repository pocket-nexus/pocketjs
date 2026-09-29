import { beforeAll, expect, test } from "bun:test";
import { createWasmUi } from "../hosts/web/wasm-ops.js";
import { PHYSICS_KIND, PHYSICS_QUERY as Q } from "../contracts/spec/physics.ts";
import { LETTER_ART } from "../apps/nexus/art.ts";

// apps/nexus on the wasm core with the 3DS geometry: a 400x240 primary and a
// 320x240 auxiliary surface, the guest the 3ds-dev build ships, and a stylus
// tape on the bottom screen. The spill must put every letter in its slot, and
// the whole run must be a pure function of the tape.

const ROOT = new URL("..", import.meta.url).pathname;
const GUEST = `${ROOT}dist/3ds/guest/pocket-nexus`;

beforeAll(() => {
  const build = Bun.spawnSync([process.execPath, "tools/3ds.ts", "nexus", "--pocket-only"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  if (build.exitCode !== 0) throw new Error(`nexus guest build failed\n${build.stdout}${build.stderr}`);
}, 120_000);

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
  // the letters' bodies: kind-tagged handles, generation 0, slots in creation order
  const world = (PHYSICS_KIND.world << 28) | 1;
  const q = (query: number, handle: number) => wasm.ops.physicsQuery!(query, handle);
  const anchored: number[] = [];
  for (let slot = 1; slot < 64; slot++) {
    const handle = (PHYSICS_KIND.body << 28) | slot;
    if (q(Q.mode, handle) === 1) anchored.push(handle);
  }
  // the pocket rests below the hinge and the lede under the wordmark; the
  // letters are the anchored bodies in the top screen's upper half
  const letters = anchored.filter((b) => q(Q.y, b) < 140);
  expect(letters.length).toBe(LETTER_ART.length);
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
