#!/usr/bin/env bun
// vapor/scripts/promo/capture.ts — capture synchronized gameplay footage.
//
// Runs the same choreography (navigate, toggle, cycle filters, open the
// editor, type "HN" with the glyph picker, save, toggle it done) on all
// three consoles, dumping EVERY video frame as PPM. All three use the same
// 24-frames-per-press schedule, so the composited side-by-side stays in
// lockstep. Frames land in dist/vapor/promo/frames/{gba,gb,nes}/.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { Controller, NES } from "jsnes";
import { compileVaporApp, type VaporTargetName } from "../../compiler/compile.ts";
import { buildRom } from "../../compiler/rom.ts";
import { Button } from "../../host/input.ts";

const ROOT = join(import.meta.dir, "..", "..", "..");
const OUT = join(ROOT, "dist", "vapor", "promo");
const ENTRY = join(import.meta.dir, "..", "..", "examples", "todo", "todo.tsx");
const MGBA = join(import.meta.dir, "..", "..", "tests", "harness", "mgba_runner");

const HOLD = 14;
const GAP = 10;
export const FRAMES_PER_PRESS = HOLD + GAP;
export const LEAD = 90;
export const TAIL = 120;

const GLYPHS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789";

/** The shared choreography, as a flat list of button ids. */
export function pressList(): number[] {
  const p: number[] = [];
  p.push(Button.Down, Button.Down, Button.A, Button.Up);
  p.push(Button.Right, Button.Right, Button.Right); // filters: ACTIVE, DONE, ALL
  p.push(Button.Start); // editor
  let at = 0;
  for (const ch of "HN") {
    const t = GLYPHS.indexOf(ch);
    for (let i = 0; i < (t - at + GLYPHS.length) % GLYPHS.length; i++) p.push(Button.Right);
    p.push(Button.A);
    at = t;
  }
  p.push(Button.Start); // save
  p.push(Button.Down, Button.Down, Button.Down); // cursor onto HN
  p.push(Button.A); // toggle it done
  return p;
}

export const TOTAL_FRAMES = LEAD + pressList().length * FRAMES_PER_PRESS + TAIL;

async function captureMgba(target: "gba" | "gb", preRoll: number): Promise<void> {
  const dir = join(OUT, "frames", target);
  mkdirSync(dir, { recursive: true });
  const app = compileVaporApp(ENTRY, await Bun.file(ENTRY).text(), "VAPOR TODO", target);
  const rom = join(OUT, `todo.${target}`);
  await buildRom(app, target as VaporTargetName, rom);

  const lines: string[] = [`A ${preRoll}`, `M ${LEAD} ${dir}/f`];
  for (const b of pressList()) {
    lines.push(`K ${(1 << b).toString(16)}`);
    lines.push(`M ${HOLD} ${dir}/f`);
    lines.push(`K 0`);
    lines.push(`M ${GAP} ${dir}/f`);
  }
  lines.push(`M ${TAIL} ${dir}/f`);
  const sc = join(OUT, `capture-${target}.txt`);
  await Bun.write(sc, lines.join("\n") + "\n");
  await $`${MGBA} ${rom} ${sc}`.quiet();
  console.log(`${target}: ${TOTAL_FRAMES} frames`);
}

async function captureNes(): Promise<void> {
  const dir = join(OUT, "frames", "nes");
  mkdirSync(dir, { recursive: true });
  const app = compileVaporApp(ENTRY, await Bun.file(ENTRY).text(), "VAPOR TODO", "nes");
  const rom = join(OUT, "todo.nes");
  await buildRom(app, "nes", rom);

  let frameBuffer: ArrayLike<number> | null = null;
  const nes = new NES({
    onFrame: (buf: ArrayLike<number>) => {
      frameBuffer = buf;
    },
    onAudioSample: () => {},
  });
  nes.loadROM(Buffer.from(new Uint8Array(await Bun.file(rom).arrayBuffer())).toString("latin1"));

  const BTN: Record<number, number> = {
    [Button.A]: Controller.BUTTON_A,
    [Button.B]: Controller.BUTTON_B,
    [Button.Select]: Controller.BUTTON_SELECT,
    [Button.Start]: Controller.BUTTON_START,
    [Button.Right]: Controller.BUTTON_RIGHT,
    [Button.Left]: Controller.BUTTON_LEFT,
    [Button.Up]: Controller.BUTTON_UP,
    [Button.Down]: Controller.BUTTON_DOWN,
  };

  let at = 0;
  const dump = async () => {
    if (!frameBuffer) return;
    const w = 256;
    const h = 240;
    const header = `P6\n${w} ${h}\n255\n`;
    const out = new Uint8Array(header.length + w * h * 3);
    out.set(new TextEncoder().encode(header), 0);
    let o = header.length;
    for (let i = 0; i < w * h; i++) {
      const p = (frameBuffer as number[])[i];
      out[o++] = p & 0xff;
      out[o++] = (p >> 8) & 0xff;
      out[o++] = (p >> 16) & 0xff;
    }
    await Bun.write(join(dir, `f${String(at++).padStart(5, "0")}.ppm`), out);
  };
  const run = async (n: number, record: boolean) => {
    for (let i = 0; i < n; i++) {
      nes.frame();
      if (record) await dump();
    }
  };

  await run(90, false); // pre-roll
  await run(LEAD, true);
  for (const b of pressList()) {
    nes.buttonDown(1, BTN[b] as never);
    await run(HOLD, true);
    nes.buttonUp(1, BTN[b] as never);
    await run(GAP, true);
  }
  await run(TAIL, true);
  console.log(`nes: ${TOTAL_FRAMES} frames`);
}

if (import.meta.main) {
  await captureMgba("gba", 20);
  await captureMgba("gb", 150);
  await captureNes();
  console.log(`total per console: ${TOTAL_FRAMES} frames (${(TOTAL_FRAMES / 60).toFixed(1)}s)`);
}
