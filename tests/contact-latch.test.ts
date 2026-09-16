import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachGesture, resetGestures, __runGestures } from "../framework/src/gesture-core.ts";
import { __setTouches, __resetTouches, touches } from "../framework/src/touch.ts";
import { createKeyboardTouch } from "../apps/clear/keyboard-touch.ts";

const directory = mkdtempSync(join(tmpdir(), "pocket-contact-latch-"));
const binary = join(directory, "test");
const build = Bun.spawnSync(["cc", "-std=c11", "-Wall", "-Wextra", "-Werror", "-fsanitize=address,undefined",
  "tests/fixtures/contact-latch.c", "-o", binary], { stderr: "pipe" });
if (build.exitCode) throw new Error(build.stderr.toString());
afterAll(() => rmSync(directory, { recursive: true, force: true }));
afterEach(() => { resetGestures(); __resetTouches(); });
function trace(events: string) {
  const run = Bun.spawnSync([binary, "trace"], { stdin: Buffer.from(events), stdout: "pipe", stderr: "pipe" });
  expect(run.exitCode, run.stderr.toString()).toBe(0);
  return run.stdout.toString().trim().split("\n").map(line => JSON.parse(line) as { packed: number[]; hits: number[] });
}
function deliver(frame: { packed: number[]; hits: number[] }) { __setTouches(frame.packed, frame.hits); __runGestures(); }
test("native contact lifetimes survive pointer reuse and suppress cancelled tap latches", () => {
  const run = Bun.spawnSync([binary], { stderr: "pipe" });
  expect(run.exitCode, run.stderr.toString()).toBe(0);
});
test("native DOWN order survives storage reuse through the gesture onDown callbacks", () => {
  let text = "";
  attachGesture({ onDown: c => { text += String.fromCharCode(c.x); } });
  const frames = trace("d 0 194\nf 0 0\nd 1 220\nu 0 194\nd 0 210\nf 0 0\nm 1 224\nf 0 0\n");
  for (const frame of frames) deliver(frame);
  expect(text).toBe("ani");
  expect(touches().map(c => c.x)).toEqual([112, 105]);
});
for (const cancel of ["c 0 200", "x 0 0"]) for (const sampled of [false, true])
  test(`native ${cancel[0]} reaches keyboard cancel without Space commit (sampled=${sampled})`, () => {
    const events: string[] = [];
    const keyboard = createKeyboardTouch({ space: () => events.push("space"), backspace() {}, caret() {}, trackpad() {} });
    attachGesture({
      onDown: c => { keyboard.begin(c.id, c.x, c.y, c.x === 100 ? "space" : "other", { x: 0, y: 0, w: 400, h: 800 }, 0); },
      onUp: c => keyboard.release(c.id),
      onCancel: c => { events.push("cancel"); keyboard.release(c.id, true); },
    });
    for (const frame of trace(`d 0 200\n${sampled ? "f 0 0\n" : ""}${cancel}\nd 0 300\nf 0 0\nu 0 300\nf 0 0\n`)) deliver(frame);
    expect(events).toEqual(sampled ? ["cancel"] : []);
  });
test("eight cancelled contacts leave room for eight new DOWNs in the same guest frame", () => {
  const downs: number[] = [], cancels: number[] = [], ups: number[] = [];
  attachGesture({ onDown: c => downs.push(c.id), onCancel: c => cancels.push(c.id), onUp: c => ups.push(c.id) });
  const down = Array.from({ length: 8 }, (_, id) => `d ${id} 200`).join("\n");
  for (const frame of trace(`${down}\nf 0 0\nx 0 0\n${down}\nf 0 0\nf 0 0\n`)) deliver(frame);
  expect(downs).toHaveLength(16); expect(new Set(downs).size).toBe(16);
  expect(cancels).toEqual(downs.slice(0, 8)); expect(ups).toEqual([]); expect(touches()).toHaveLength(8);
});
test("eight normal releases also free guest tracks before replacement DOWNs", () => {
  let count = 0;
  attachGesture({ onDown: () => count++ });
  const events = (phase: string) => Array.from({ length: 8 }, (_, id) => `${phase} ${id} 200`).join("\n");
  for (const frame of trace(`${events("d")}\nf 0 0\n${events("u")}\n${events("d")}\nf 0 0\n`)) deliver(frame);
  expect(count).toBe(16);
});
