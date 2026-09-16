import { afterAll, expect, test } from "bun:test";
import { bootWorld, treeHasText } from "../hosts/sim/sim.ts";
import { __packTouchWide, __packTouchCancel } from "../framework/src/touch.ts";
import { KB_LAYERS } from "../apps/clear/kb-layout.ts";
import { KB_H, KB_PAD, KB_ROW_H, KB_GAP } from "../apps/clear/keyboard-metrics.ts";
import { PROP } from "../contracts/spec/spec.ts";
import { IME } from "../contracts/spec/ime.ts";
import type { OffloadRequest } from "../contracts/spec/offload.ts";
import type { HostOps } from "../framework/src/host.ts";

afterAll(() => { delete (globalThis as { offload?: unknown }).offload; });
type Tree = { i: number; x?: string; k?: Tree[] };
function ancestors(tree: Tree, text: string): Tree[] {
  if (tree.x === text) return [tree];
  for (const child of tree.k ?? []) { const path = ancestors(child, text); if (path.length) return [tree, ...path]; }
  return [];
}
for (const connected of [false, true]) test(`Clear text layout owns offline symbols and completed-row width (connected=${connected})`, async () => {
  const width = 360, height = 800, replies: string[] = [], held: OffloadRequest[] = [], sent: OffloadRequest[] = [];
  const props = new Map<number, Map<number, number>>(), nativeText = new Set<string>();
  let allowTitle = false, ops: HostOps;
  const answer = (r: OffloadRequest) => {
    const g = JSON.parse(r.payload), width = g.size * 2, height = 64;
    replies.push(JSON.stringify({ id: r.id, payload: JSON.stringify({ face: g.face, advance: g.size === 20 ? 17 : 16,
      xoff: 0, width, height, mask: Buffer.alloc(width * height / 4, 255).toString("base64") }) }));
  };
  const world = await bootWorld("clear-main.vue-vapor", 60, { offload: {
    session: () => connected ? 1 : 0, take: () => replies.shift(),
    submit(raw: string) {
      const r = JSON.parse(raw) as OffloadRequest; sent.push(r);
      if (r.method === "text.font") replies.push(JSON.stringify({ id: r.id, payload: JSON.stringify({ id: "a".repeat(64), mapping: "scalar" }) }));
      if (r.method === "text.glyph") { if (JSON.parse(r.payload).size === 20 && !allowTitle) held.push(r); else answer(r); }
      if (r.method === "ime.compose") {
        const keys = JSON.parse(r.payload) as number[], selected = keys.some(k => k >= IME.select);
        replies.push(JSON.stringify({ id: r.id, payload: JSON.stringify({ preedit: selected ? "" : "n", raw: selected ? "" : "n", rawCaret: selected ? 0 : 1,
          caret: selected ? 0 : 1, commit: selected ? "你好世界" : "", candidates: selected ? [] : ["你好世界"], page: 0, last: true }) }));
      }
      return true;
    },
    uploadCoverage(mask: string, w: number, h: number) { const envelope = 2 ** Math.ceil(Math.log2(w)); return ops.uploadTexture(new Uint8Array(envelope * h * 4).fill(255), envelope, h, 3); },
  } }, native => {
    ops = native as unknown as HostOps;
    for (const method of ["setText", "replaceText"] as const) {
      const original = ops[method].bind(ops);
      ops[method] = (id, text) => { nativeText.add(text); return original(id, text); };
    }
    const record = (id: number, prop: number, value: number) => { if (!props.has(id)) props.set(id, new Map()); props.get(id)!.set(prop, value); };
    const set = ops.setProp.bind(ops), batch = ops.setPropBatch?.bind(ops);
    ops.setProp = (id, prop, value) => { record(id, prop, value); set(id, prop, value); };
    if (batch) ops.setPropBatch = records => { const values = new Float64Array(records); for (let i = 0; i < values.length; i += 3) record(values[i], values[i + 1], values[i + 2]); batch(records); };
  }, { width, height, rasterDensity: 2 });
  async function step(touch?: number[]) { world.frame(0, undefined, touch); world.tick(); await Promise.resolve(); }
  async function idle(n = 25) { for (let i = 0; i < n; i++) await step(); }
  async function tap(x: number, y: number) { await step([__packTouchWide(0, x, y)]); await step(); }
  const keyY = (row: number) => height - KB_H + KB_PAD + row * (KB_ROW_H + KB_GAP) + KB_ROW_H / 2;
  const key = async (layer: keyof typeof KB_LAYERS, label: string) => {
    for (let row = 0; row < KB_LAYERS[layer].length; row++) for (const k of KB_LAYERS[layer][row]) if ((k.label ?? k.ch) === label) {
      await tap((k.x + k.w / 2) * width / 320, keyY(row)); return;
    }
    throw new Error(`missing key ${label}`);
  };
  await idle(); await tap(100, 31); await idle(); await tap(100, 31); await idle();
  // System CANCEL after a sampled Space must leave the full editor unchanged.
  const before = JSON.stringify(world.getTree());
  await step([__packTouchWide(0, 166 * width / 320, keyY(3))]);
  await step([__packTouchCancel(0)]); await idle(3);
  expect(treeHasText(world.getTree(), "Swipe right to complete|")).toBe(true);
  expect(treeHasText(world.getTree(), "Swipe right to complete |")).toBe(false);
  expect(before).toContain("Swipe right to complete");
  // Remove the demo title through the real keyboard.
  for (let i = 0; i < "Swipe right to complete".length; i++) await tap(width - 20, keyY(2));
  if (!connected) {
    await key("lower", "123"); await key("numbers", "#+=");
    for (const symbol of "£¥€•") await key("symbols", symbol);
    await idle(); expect(treeHasText(world.getTree(), "£¥€•|")).toBe(true);
    // Local text creates native text children, with no glyph placeholder cells.
    expect(sent).toEqual([]); expect(nativeText.has("£¥€•|")).toBe(true);
    await tap(width - 20, keyY(3)); await idle();
    expect(treeHasText(world.getTree(), "£¥€•")).toBe(true);
  } else {
    await key("lower", "n"); await idle();
    await step([__packTouchWide(0, 166 * width / 320, keyY(3))]);
    await step([__packTouchCancel(0)]); await idle(3);
    expect(sent.filter(r => r.method === "ime.compose").some(r => (JSON.parse(r.payload) as number[]).some(k => k >= IME.select))).toBe(false);
    await tap(20, height - KB_H - 22); await idle(8);
    await tap(width - 20, keyY(3)); await idle();
    expect(treeHasText(world.getTree(), "你好世界")).toBe(true);
    // Completion occurs while title glyph metrics are still unavailable.
    for (let i = 0; i <= 16; i++) await step([__packTouchWide(0, 30 + i * 15, 31)]);
    await step(); await idle(40);
  }
  const title = connected ? "你好世界" : "£¥€•";
  // The front contains the text container and strike as siblings.
  const strike = ancestors(world.getTree() as Tree, title).flatMap(n => n.k ?? []).find(c => props.get(c.i)?.get(PROP.insetT) === 30 && props.get(c.i)?.get(PROP.height) === 2);
  expect(strike).toBeDefined();
  if (connected) {
    expect(props.get(strike!.i)!.get(PROP.width)).toBe(80);
    expect(props.get(strike!.i)!.get(PROP.scaleX)).toBe(1);
    allowTitle = true; for (const r of held.splice(0)) answer(r); await idle(100);
    expect(props.get(strike!.i)!.get(PROP.width)).toBe(68);
    const drawn = ancestors(world.getTree() as Tree, title).at(-1)!;
    expect(drawn.k!.map(c => props.get(c.i)!.get(PROP.insetL))).toEqual([0, 17, 34, 51]);
  } else expect(props.get(strike!.i)!.get(PROP.width)).toBe(ops!.measureText(title, 11));
});
