import { expect, test } from "bun:test";
import { bakeFontArchive } from "../framework/compiler/font-archive.ts";
import { archiveProvider } from "./helpers/font-archive-provider.ts";
import { bootWorld, treeHasText, fnv1a } from "../hosts/sim/sim.ts";
import { BTN } from "../contracts/spec/spec.ts";
import { unpack } from "../framework/compiler/pak.ts";

const chapter = Array.from({ length: 190 }, (_, i) => String.fromCodePoint(0x4e00 + i)).join("");
const other = Array.from({ length: 60 }, (_, i) => String.fromCodePoint(0x4ec0 + i)).join("");
test("Text reveals complete runtime content with fallback, pause, cancellation, paging and retry", async () => {
  const build = Bun.spawnSync([process.execPath, "tools/build.ts", "text-cjk"], { stdout: "pipe", stderr: "pipe" });
  expect(build.exitCode, new TextDecoder().decode(build.stderr)).toBe(0);
  const bundle = await Bun.file("dist/text-cjk-main.js").text();
  expect(bundle).not.toContain("你好世界");
  const atlases = unpack(new Uint8Array(await Bun.file("dist/text-cjk-main.pak").arrayBuffer()))
    .filter(b => b.key.startsWith("ui:font."));
  for (const { data } of atlases) {
    const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
    for (let i = 0; i < v.getUint16(6, true); i++) expect(v.getUint32(16 + i * 8, true)).not.toBe(0x4e00);
  }
  const provider = archiveProvider(await bakeFontArchive({ font: "assets/fonts/NotoSansCJK-Demo.otf", slots: [2] }));
  provider.setText(["01 - 你好世界.flac\t4:32\tNight Sessions", "02 - 気迫.mp3\t3:48\tCity Lights",
    "03 - 日本語.ogg\t5:16\tLive", "04 - 文.m4a\t2:57\tQuiet Hours",
    "05 - 世界.wav\t6:04\tLost & Found", "06 - 你好.flac\t4:21\tNight Sessions"].join("\n"));
  provider.setDocument("chapter-1.txt", chapter); provider.setDocument("chapter-2.txt", other);
  let host: any;
  const world = await bootWorld("text-cjk-main", 60, { offload: { ...provider.ops, local: provider.ops } }, ops => { host = ops; });
  const step = (mask = 0) => { provider.step(); world.frame(mask); world.tick(); return world.render(); };
  const advance = (n: number) => { for (let i = 0; i < n; i++) step(); };
  const press = (mask: number) => { step(mask); step(); };
  const has = (text: string) => treeHasText(world.getTree(), text);
  const hasNode = (name: string) => JSON.stringify(world.getTree()).includes(`"${name}"`);
  function contentInk(pixels: Uint8Array) {
    let count = 0;
    for (let y = 50; y < 202; y++) for (let x = 8; x < 472; x++) {
      const at = (y * 480 + x) * 4;
      if (pixels[at] > 240 && pixels[at + 1] > 240 && pixels[at + 2] > 240) count++;
    }
    return count;
  }
  const bodyHash = (pixels: Uint8Array) => fnv1a(pixels.subarray(50 * 480 * 4, 202 * 480 * 4));
  // Navigate while the initial common-set file read has no provider reply yet.
  step();
  for (const mask of [BTN.RTRIGGER, 0, BTN.LTRIGGER, 0]) { world.frame(mask); world.tick(); world.render(); }
  advance(5); expect(hasNode("TextSkeleton")).toBe(true); expect(hasNode("MusicList")).toBe(false);
  expect(hasNode("FrameMotion")).toBe(false);
  advance(80); expect(has("MUSIC | READY"), JSON.stringify(world.getTree())).toBe(true); expect(has("你好世界")).toBe(true);
  expect(hasNode("MusicList")).toBe(true); expect(hasNode("TextSkeleton")).toBe(false);
  expect(has("Night Sessions / FLAC")).toBe(true); expect(has("4:32")).toBe(true);
  const musicReads = provider.seen.filter(r => r.method === "font.glyphs").length;
  press(BTN.UP); expect(has("6 tracks | 6 selected")).toBe(true); expect(hasNode("Track6")).toBe(true);
  press(BTN.DOWN); expect(has("6 tracks | 1 selected")).toBe(true); expect(hasNode("Track1")).toBe(true);
  expect(provider.seen.filter(r => r.method === "font.glyphs")).toHaveLength(musicReads);
  press(BTN.CIRCLE); press(BTN.RTRIGGER); advance(10);
  expect(has("CHAPTER 1 | PENDING")).toBe(true); expect(hasNode("TextSkeleton")).toBe(true);
  expect(has("Loading whole text")).toBe(false); expect(hasNode("PreparedContent")).toBe(false);
  expect(contentInk(step())).toBe(0);
  const earlySkeleton = bodyHash(step());
  advance(25); expect(bodyHash(step())).not.toBe(earlySkeleton);
  advance(220); expect(contentInk(step())).toBe(0); // no timeout reveals partial content
  expect(has("I/O PAUSED")).toBe(true);
  press(BTN.CIRCLE);
  const inks: number[] = [];
  for (let i = 0; i < 160; i++) inks.push(contentInk(step()));
  expect(has("CHAPTER 1 | READY")).toBe(true);
  const positive = inks.filter(n => n > 0);
  expect(positive.length).toBeGreaterThan(5);
  expect(inks.filter(n => n === 0).length).toBeGreaterThan(5);
  expect(new Set(positive).size).toBe(1); // first content frame equals the final whole-text frame
  const reads = provider.seen.filter(r => r.method === "font.glyphs").length;
  press(BTN.TRIANGLE); advance(20); expect(has("Page 2/")).toBe(true);
  expect(provider.seen.filter(r => r.method === "font.glyphs")).toHaveLength(reads);
  // Change selection again while another batch still has queued replies.
  press(BTN.RTRIGGER); advance(4); press(BTN.LTRIGGER); advance(80);
  expect(has("CHAPTER 1 | READY")).toBe(true); expect(has(other.slice(0, 20))).toBe(false);
  provider.fail(true); press(BTN.CROSS); advance(25);
  expect(has("ERROR")).toBe(true); expect(contentInk(step())).toBe(0);
  provider.fail(false); press(BTN.CROSS); advance(180);
  expect(has("CHAPTER 1 | READY")).toBe(true);
  provider.disconnect(); advance(5); press(BTN.RTRIGGER); advance(680);
  expect(has("CHAPTER 2 | ERROR")).toBe(true);
  expect(has("Unable to load this selection")).toBe(true);
  provider.reconnect(); advance(180); expect(has("CHAPTER 2 | READY")).toBe(true);
  // Ordinary browsing must never enter injected failure cases.
  press(BTN.RTRIGGER); advance(120); expect(has("MUSIC | READY")).toBe(true);
  press(BTN.LTRIGGER); advance(120); expect(has("CHAPTER 2 | READY")).toBe(true);
  press(BTN.LTRIGGER); advance(120); expect(has("CHAPTER 1 | READY")).toBe(true);
  press(BTN.START); press(BTN.RTRIGGER); advance(20);
  expect(has("OVER BUDGET | EXPECTED")).toBe(true); expect(contentInk(step())).toBe(0);
  press(BTN.RTRIGGER); advance(30); expect(has("MISSING GLYPH | EXPECTED")).toBe(true);
  expect(has("Expected: character absent from the font")).toBe(true);
  expect(JSON.parse(host.fontStreamStats()).pending).toBe(0);
  provider.fail(true); press(BTN.CROSS); advance(25);
  expect(has("MISSING GLYPH | ERROR")).toBe(true); expect(has("Expected:")).toBe(false);
  provider.fail(false); press(BTN.START); press(BTN.CROSS); advance(180);
  expect(has("MUSIC | READY")).toBe(true);
  expect(provider.seen.filter(r => r.method === "font.glyphs").every(r => JSON.parse(r.payload).scalars.length <= 4)).toBe(true);
}, 30000);
