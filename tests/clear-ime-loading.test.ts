import { afterAll, expect, test } from "bun:test";
import { bootWorld, treeHasText } from "../hosts/sim/sim.ts";
import { __packTouchWide } from "../framework/src/touch.ts";
import type { HostOps } from "../framework/src/host.ts";
import type { OffloadRequest } from "../contracts/spec/offload.ts";
import { IME } from "../contracts/spec/ime.ts";
import { PROP } from "../contracts/spec/spec.ts";
import { KB_H, KB_PAD, KB_ROW_H, KB_GAP, IME_BAR_H, IME_LABEL_H, IME_LABEL_GAP } from "../apps/clear/keyboard-metrics.ts";

afterAll(() => { delete (globalThis as { offload?: unknown }).offload; });
for (const [width, height] of [[320, 480], [360, 800]]) test(`Clear retains text and paints compact IME controls at ${width}x${height}`, async () => {
  const sent: OffloadRequest[] = [], replies: string[] = [], held: OffloadRequest[] = [], uploads: number[] = [];
  let textWrites = 0, topWrites = 0, allowGlyphs = false, frame = 0, lastUpload = -1, session = 1, ops: HostOps;
  function answerGlyph(request: OffloadRequest) {
    const { face, size, density } = JSON.parse(request.payload);
    const width = size * density, height = 2 ** Math.ceil(Math.log2((size + 8) * density));
    replies.push(JSON.stringify({ id: request.id, payload: JSON.stringify({ face, advance: size, xoff: 0, width, height,
      mask: Buffer.alloc(width * height / 4, 255).toString("base64") }) }));
  }
  const world = await bootWorld("clear-main.vue-vapor", 60, { offload: {
    session: () => session, take: () => replies.shift(),
    submit(raw: string) {
      const request = JSON.parse(raw) as OffloadRequest; sent.push(request);
      if (request.method === "text.font") replies.push(JSON.stringify({ id: request.id, payload: JSON.stringify({ id: "a".repeat(64), mapping: "scalar" }) }));
      if (request.method === "text.glyph") { if (allowGlyphs) answerGlyph(request); else held.push(request); }
      if (request.method === "ime.candidates") {
        const { offset } = JSON.parse(request.payload);
        const candidates = Array.from({ length: 15 }, (_, i) => offset + i === 0 ? "你好" : `你${offset + i}`);
        replies.push(JSON.stringify({ id: request.id, payload: JSON.stringify({ offset, candidates, last: offset >= 45 }) }));
      }
      return true;
    },
    uploadCoverage(mask: string, width: number, height: number) {
      if (lastUpload === frame) return 0;
      lastUpload = frame; uploads.push(frame);
      const envelope = 2 ** Math.ceil(Math.log2(width)), data = new Uint8Array(envelope * height * 4), packed = Buffer.from(mask, "base64");
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const i = y * width + x, j = (y * envelope + x) * 4;
        data[j] = data[j + 1] = data[j + 2] = 255; data[j + 3] = ((packed[i >> 2] >> ((i & 3) * 2)) & 3) * 85;
      }
      return ops.uploadTexture(data, envelope, height, 3);
    },
  } }, native => {
    ops = native as unknown as HostOps;
    const setProp = ops.setProp.bind(ops), batch = ops.setPropBatch?.bind(ops);
    ops.setProp = (id, prop, value) => { if (prop === PROP.insetT) topWrites++; setProp(id, prop, value); };
    if (batch) ops.setPropBatch = records => {
      const values = new Float64Array(records);
      for (let i = 0; i < values.length; i += 3) if (values[i + 1] === PROP.insetT) topWrites++;
      batch(records);
    };
    for (const method of ["setText", "replaceText"] as const) {
      const original = ops[method].bind(ops);
      ops[method] = (id, text) => { if (text) textWrites++; return original(id, text); };
    }
  }, { width, height, rasterDensity: 2 });
  async function step(x?: number, y?: number) {
    frame++; world.frame(0, undefined, x === undefined ? undefined : [__packTouchWide(0, x, y!)]); world.tick(); await Promise.resolve();
  }
  async function idle(n: number) { for (let i = 0; i < n; i++) await step(); }
  async function tap(x: number, y: number) { await step(x, y); await step(x, y); await step(); }
  const barTop = height - KB_H - IME_BAR_H, candidateY = barTop + 22;
  const keyY = (row: number) => height - KB_H + KB_PAD + row * (KB_ROW_H + KB_GAP) + KB_ROW_H / 2;
  const pixel = (x = 12, y = candidateY) => Array.from(world.render().slice((y * width + x) * 4, (y * width + x) * 4 + 3));
  const glyphs = () => sent.filter(r => r.method === "text.glyph" && JSON.parse(r.payload).size === 16);
  const compositions = () => sent.filter(r => r.method === "ime.compose");
  function answerComposition(preedit: string, commit = "") {
    const request = compositions().at(-1)!;
    replies.push(JSON.stringify({ id: request.id, payload: JSON.stringify({ preedit, raw: preedit.replaceAll(" ", ""), rawCaret: preedit.replaceAll(" ", "").length, caret: preedit.length, commit,
      candidates: preedit ? ["你好", "呢"] : [], page: 0, last: false }) }));
  }
  function controlsInk() {
    const pixels = world.render(); let ink = 0;
    for (let y = barTop + 1; y < barTop + 43; y++) for (let x = width - 87; x < width - 1; x++) if (pixels[(y * width + x) * 4] > 90) ink++;
    return ink;
  }
  await idle(8); await tap(100, 31); await idle(25); await tap(100, 31); await idle(25);
  expect(controlsInk()).toBe(0); // empty PY exposes no useless controls
  const rest = pixel();
  expect(treeHasText(world.getTree(), "Pinyin")).toBe(false);
  await tap(224 * width / 320, keyY(2)); await idle(18); // n, conversion held
  expect(treeHasText(world.getTree(), "...")).toBe(false);
  const low = pixel(); expect(low[0]).toBeGreaterThan(rest[0]); expect(Math.max(...low)).toBeLessThan(100);
  await idle(35); const high = pixel(); expect(high).not.toEqual(low);
  expect(Math.max(...high.map((v, i) => Math.abs(v - low[i])))).toBeLessThan(20);
  answerComposition("n"); await idle(20);
  expect(held.length).toBe(2); // scheduler allows two concurrent glyph reads
  expect(controlsInk()).toBeGreaterThan(0);
  allowGlyphs = true; for (const request of held.splice(0)) answerGlyph(request);
  await idle(60); expect(pixel()).toEqual([255, 255, 255]);
  expect(pixel(Math.round(166 * width / 320), keyY(3))).toEqual([255, 255, 255]); // mode glyphs must paint inside the Space cap
  expect(glyphs()).toHaveLength(3); // 你 好 呢, one resident texture each
  const count = glyphs().length;
  const badgeY = barTop - IME_LABEL_H - IME_LABEL_GAP + 2;
  const shortBadge = pixel(38, badgeY);
  await tap(240 * width / 320, keyY(0)); await idle(12); answerComposition("nihao"); await idle(12);
  expect(pixel(38, badgeY)).not.toEqual(shortBadge); // measured label grows from the left
  expect(pixel(200, badgeY)).toEqual(pixel(250, badgeY)); // no full-width second row
  expect(glyphs()).toHaveLength(count);
  await tap(width - 22, candidateY); await idle(30); // 44-point disclosure target
  expect(sent.some(r => r.method === "ime.candidates")).toBe(true);
  await step(30, height - 40);
  let peakWrites = 0;
  for (let dy = 1; dy <= 120; dy++) {
    const before = textWrites, topBefore = topWrites; await step(30, height - 40 - dy);
    peakWrites = Math.max(peakWrites, textWrites - before);
    if (dy >= 10 && dy <= 30) expect(topWrites).toBe(topBefore); // scroll inside one row moves paint, not layout
  }
  await step(); await idle(20);
  // A row entering the viewport creates at most one row of text; surviving
  // candidates must not all be rebound in a frame at the overscan boundary.
  expect(peakWrites).toBeGreaterThan(0);
  expect(peakWrites).toBeLessThanOrEqual(Math.floor(width / 64));
  const beforeDrag = compositions().length;
  await step(30, height - 40); for (let y = height - 50; y >= height - 180; y -= 10) await step(30, y); await step(); await idle(30);
  expect(compositions()).toHaveLength(beforeDrag); // scroll release never commits
  expect(sent.filter(r => r.method === "ime.candidates").some(r => JSON.parse(r.payload).offset >= 15)).toBe(true);
  await tap(width - 22, candidateY); await idle(5); await tap(width - 22, candidateY); await idle(5);
  await tap(30, height - KB_H + 22); await idle(5);
  expect(JSON.parse(compositions().at(-1)!.payload).at(-1)).toBe(IME.selectAbsolute + 3); // continue after inline candidates
  answerComposition("", "你好"); await idle(40);
  expect(treeHasText(world.getTree(), "Swipe right to complete你好|")).toBe(true);
  expect(controlsInk()).toBe(0);
  const prefixWidth = ops!.measureText("Swipe right to complete", 11), x = Math.floor(12 + prefixWidth);
  const before = world.render(), requestCount = glyphs().length;
  session = 0; await idle(2); await tap(width - 20, keyY(2)); await idle(2); // delete 好 offline
  expect(treeHasText(world.getTree(), "Swipe right to complete你|")).toBe(true);
  const after = world.render();
  for (let y = 12; y < 48; y++) for (let px = 12; px < x + 19; px++) {
    const i = (y * width + px) * 4;
    expect(Array.from(after.slice(i, i + 4))).toEqual(Array.from(before.slice(i, i + 4)));
  }
  expect(pixel(x + 34, 31)).not.toEqual([255, 255, 255]);
  expect(glyphs()).toHaveLength(requestCount);
  const spaceX = Math.round(166 * width / 320);
  for (let i = 0; i < 16; i++) await step(spaceX, keyY(3));
  await step(spaceX - 10, keyY(3)); await step(); await idle(20);
  expect(pixel(spaceX, keyY(3))).toEqual([255, 255, 255]); // mode label survives the trackpad branch
  await tap(72 * width / 320, keyY(3)); await idle(4); expect(controlsInk()).toBe(0); // EN
  expect(new Set(uploads).size).toBe(uploads.length);
});

for (const [width, height] of [[320, 480], [360, 800]]) test(`Clear offline editor can commit, switch mode and close at ${width}x${height}`, async () => {
  let session = 0;
  const sent: string[] = [];
  const world = await bootWorld("clear-main.vue-vapor", 60, { offload: {
    session: () => session, take: () => undefined, submit: (raw: string) => { sent.push(raw); return true; },
  } }, undefined, { width, height, rasterDensity: 2 });
  async function idle(n = 20) { for (let i = 0; i < n; i++) { world.frame(0); world.tick(); await Promise.resolve(); } }
  async function tap(x: number, y: number) {
    world.frame(0, undefined, [__packTouchWide(0, x, y)]); world.tick();
    await idle(1); await idle(3);
  }
  const keyY = (row: number) => height - KB_H + KB_PAD + row * (KB_ROW_H + KB_GAP) + KB_ROW_H / 2;
  const has = (s: string) => treeHasText(world.getTree(), s);
  await idle(); await tap(100, 31); await idle(); await tap(100, 31); await idle();
  await tap(224 * width / 320, keyY(2)); await tap(240 * width / 320, keyY(0));
  expect(has("ni|")).toBe(true);
  await tap(166 * width / 320, keyY(3)); await idle();
  expect(has("Swipe right to completeni|")).toBe(true);
  await tap(224 * width / 320, keyY(2)); await tap(72 * width / 320, keyY(3)); // raw n then EN
  expect(has("Swipe right to completenin|")).toBe(true);
  await tap(32 * width / 320, keyY(1));
  expect(has("Swipe right to completenina|")).toBe(true);
  await tap(width - 20, keyY(3)); await idle(); // Return closes
  expect(has("Swipe right to completenina")).toBe(true);
  expect(has("Swipe right to completenina|")).toBe(false);
  expect(sent).toHaveLength(0);
  session = 2; await idle(35);
  expect(sent.map(raw => JSON.parse(raw).method)).not.toContain("ime.compose");
  await tap(100, 31); await idle(); // another edit proves the app remains interactive
  expect(has("Swipe right to completenina|")).toBe(true);
});
