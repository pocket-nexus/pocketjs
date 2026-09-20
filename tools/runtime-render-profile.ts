/** Isolate resident text rendering from font I/O, shaping, and glyph delivery.
 * bun tools/runtime-render-profile.ts --output=.pocket-build/validation/font-optimization/render.json
 * The atlas and runtime glyph path use identical FreeType coverage and integer positions.
 * Draw/hash timings include the draw-list hash; full-frame timings include software rasterization.
 * GPU bind counts below are derived from the renderer's consecutive-handle batching rules,
 * not hardware measurements. Packing numbers are estimates, not an implemented atlas.
 */
import { createWasmUi } from "../hosts/web/wasm-ops.js";
import { runtimeWorker } from "../tests/helpers/runtime-text-worker.ts";
import { runtimeGlyphPacket, runtimeLayoutPacket, type RuntimeGlyphBitmap, type RuntimeTextLayout } from "../contracts/spec/runtime-text.ts";
import { FONT_MAGIC, FONT_VERSION, NODE_TYPE, PROP } from "../contracts/spec/spec.ts";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createHash } from "node:crypto";

const out = Bun.argv.find(a => a.startsWith("--output="))?.slice(9) ?? ".pocket-build/validation/font-optimization/render.json";
const wasmPath = Bun.argv.find(a => a.startsWith("--wasm="))?.slice(7) ?? "hosts/web/pocketjs.wasm";
const wasmBytes = await Bun.file(wasmPath).arrayBuffer();
const compiled = await WebAssembly.compile(wasmBytes);
const referencePath = Bun.argv.find(a => a.startsWith("--reference-wasm="))?.slice(17);
const reference = referencePath ? await WebAssembly.compile(await Bun.file(referencePath).arrayBuffer()) : undefined;
const worker = await runtimeWorker();
const pow2 = (n: number) => n ? 2 ** Math.ceil(Math.log2(n)) : 0;
const records: unknown[] = [];
const columns = 24, cell = 20, advance = 16, baseline = 16;
const digest = (bytes: ArrayBuffer | Uint8Array) => createHash("sha256").update(new Uint8Array(bytes)).digest("hex");

function summarize(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return { p50Ms: sorted[Math.floor(sorted.length * .5)], p95Ms: sorted[Math.floor(sorted.length * .95)], maxMs: sorted.at(-1), samples: sorted.length };
}

// First-fit decreasing shelf estimate with one transparent texel on each side.
function packedPages(glyphs: RuntimeGlyphBitmap[], pageSize: number, insertionOrder = false, appendOnly = false) {
  const pages: { shelves: { y: number; height: number; x: number }[]; used: number }[] = [];
  const placements = new Map<number, number>();
  for (const g of insertionOrder ? glyphs : [...glyphs].sort((a, b) => b.height - a.height)) {
    if (!g.width || !g.height) continue;
    const w = g.width + 2, h = g.height + 2;
    if (w > pageSize || h > pageSize) throw Error("Glyph too large for estimated page");
    let placed = false;
    for (const page of appendOnly ? pages.slice(-1) : pages) {
      const shelf = page.shelves.find(s => s.height >= h && s.x + w <= pageSize);
      if (shelf) { shelf.x += w; placements.set(g.glyph, pages.indexOf(page)); placed = true; break; }
      if (page.used + h <= pageSize) {
        page.shelves.push({ y: page.used, height: h, x: w }); page.used += h;
        placements.set(g.glyph, pages.indexOf(page)); placed = true; break;
      }
    }
    if (!placed) { placements.set(g.glyph, pages.length); pages.push({ shelves: [{ y: 0, height: h, x: w }], used: h }); }
  }
  let consecutiveBinds = 0, previous = -1;
  for (const g of glyphs) {
    const page = placements.get(g.glyph); if (page == null) continue;
    if (page !== previous) consecutiveBinds++; previous = page;
  }
  return { pageSize, insertionOrder, appendOnly, pages: pages.length, consecutiveBinds, rgba8888Bytes: pages.length * pageSize ** 2 * 4,
    rgba4444Bytes: pages.length * pageSize ** 2 * 2, r8Bytes: pages.length * pageSize ** 2 };
}

try {
  for (const count of [128, 256]) {
    const characters = Array.from({ length: count }, (_, i) => String.fromCodePoint(0x4e00 + i));
    const text = characters.map((c, i) => i && i % columns === 0 ? "\n" + c : c).join("");
    const font = await worker.request("runtime.font", { family: "Pocket CJK Test", size: 16, fallback: [] });
    const shaped = await worker.request("runtime.prepare", { font: font.font, text: characters.join(""), leaseKey: `render-${count}` });
    const positions: number[][] = [...(shaped.inline?.glyphs ?? [])];
    while (positions.length < shaped.glyphs) {
      const page = await worker.request("runtime.layout.page", { layout: shaped.layout, kind: "glyphs", offset: positions.length });
      positions.push(...page.items);
    }
    if (positions.length !== count || new Set(positions.map(p => p[0])).size !== count) throw Error("Expected one unique glyph per Han character");
    const glyphs: RuntimeGlyphBitmap[] = [];
    for (const [id] of positions) {
      let offset = 0, bitmap: RuntimeGlyphBitmap | undefined;
      do {
        const data = await worker.request("runtime.glyph", { glyph: id, offset });
        bitmap ??= { glyph: id, width: data.width, height: data.height, left: data.left, top: data.top, coverage: new Uint8Array(data.total) };
        bitmap.coverage.set(Buffer.from(data.coverage, "base64"), offset);
        offset = data.next;
      } while (offset !== null);
      glyphs.push(bitmap!);
    }
    const atlasCount = count + 1, cellW = 16, cellH = cell;
    const atlas = new Uint8Array(16 + atlasCount * 8 + atlasCount * cellW * cellH), av = new DataView(atlas.buffer);
    av.setUint32(0, FONT_MAGIC, true); av.setUint16(4, FONT_VERSION, true); av.setUint16(6, atlasCount, true);
    atlas.set([cellW, cellH, baseline, cell, 2, 0, 1, 0], 8);
    glyphs.forEach((g, i) => {
      const at = 16 + i * 8;
      av.setUint32(at, 0x4e00 + i, true); av.setUint16(at + 4, i + 1, true); atlas[at + 6] = advance;
      if (g.left < 0 || g.left + g.width > cellW || baseline - g.top < 0 || baseline - g.top + g.height > cellH)
        throw Error(`Glyph ${g.glyph} does not fit the shared comparison cell`);
      const cellAt = 16 + atlasCount * 8 + (i + 1) * cellW * cellH;
      for (let y = 0; y < g.height; y++) atlas.set(g.coverage.subarray(y * g.width, (y + 1) * g.width), cellAt + (baseline - g.top + y) * cellW + g.left);
    });
    av.setUint32(16 + count * 8, 0xfffd, true); atlas[16 + count * 8 + 6] = advance;
    const baked = await createWasmUi(compiled), runtime = await createWasmUi(compiled);
    const setup = (ui: typeof baked) => {
      const node = ui.ops.createNode(NODE_TYPE.text); ui.ops.setProp(node, PROP.textColor, 0xffffffff);
      ui.ops.setProp(node, PROP.fontSlot, 2); ui.ops.insertBefore(1, node, 0); return node;
    };
    const bakedNode = setup(baked), runtimeNode = setup(runtime);
    baked.ops.loadFontAtlas!(atlas); baked.ops.setText(bakedNode, text);
    const uploadStart = performance.now();
    glyphs.forEach(g => { if (!runtime.ops.fontStreamCommit!(runtimeGlyphPacket(1, g))) throw Error("Runtime glyph admission failed"); });
    const uploadMs = performance.now() - uploadStart;
    const layout: RuntimeTextLayout = { id: 1, text, font, width: columns * advance, height: Math.ceil(count / columns) * cell,
      baseline, truncated: false, rows: [], carets: [], glyphs: glyphs.map((g, i) => [g.glyph, i % columns * advance, Math.floor(i / columns) * cell + baseline, advance, i, i + 1, Math.floor(i / columns)]) };
    if (!runtime.ops.fontStreamCommit!(runtimeLayoutPacket(runtimeNode, layout, 1))) throw Error("Runtime layout admission failed");
    baked.tick(); runtime.tick();
    const bakedPixels = new Uint8Array(baked.render()), runtimePixels = new Uint8Array(runtime.render());
    let differingBytes = 0, maxDifference = 0;
    for (let i = 0; i < bakedPixels.length; i++) {
      const delta = Math.abs(bakedPixels[i] - runtimePixels[i]);
      if (delta) differingBytes++; maxDifference = Math.max(maxDifference, delta);
    }
    if (differingBytes) throw Error(`Shared coverage comparison differs: ${differingBytes} bytes, max ${maxDifference}`);
    for (let i = 0; i < 100; i++) { baked.tick(); baked.drawHash!(); baked.render(); runtime.tick(); runtime.drawHash!(); runtime.render(); }
    const timings = {
      baked: { drawHash: [] as number[], fullFrame: [] as number[] },
      runtime: { drawHash: [] as number[], fullFrame: [] as number[] },
    };
    // Alternate order every sample to reduce order-dependent thermal/JIT bias.
    for (let sample = 0; sample < 100; sample++) {
      const order = sample % 2 ? [[baked, timings.baked], [runtime, timings.runtime]] as const : [[runtime, timings.runtime], [baked, timings.baked]] as const;
      for (const [ui, result] of order) {
        let start = performance.now();
        for (let i = 0; i < 10; i++) { ui.tick(); ui.drawHash!(); }
        result.drawHash.push((performance.now() - start) / 10);
        start = performance.now();
        for (let i = 0; i < 10; i++) { ui.tick(); ui.render(); }
        result.fullFrame.push((performance.now() - start) / 10);
      }
    }
    const rawCoverageBytes = glyphs.reduce((n, g) => n + g.coverage.length, 0);
    const runtimeRgbaBytes = glyphs.reduce((n, g) => n + pow2(g.width) * pow2(g.height) * 4, 0);
    const transformControls: { scale: number; rotate: number; x: number; y: number; color: number; differingBytes: number; sha256: string }[] = [];
    if (reference) {
      const referenceUi = await createWasmUi(reference), referenceNode = setup(referenceUi);
      for (const g of glyphs) if (!referenceUi.ops.fontStreamCommit!(runtimeGlyphPacket(1, g))) throw Error("Reference glyph admission failed");
      if (!referenceUi.ops.fontStreamCommit!(runtimeLayoutPacket(referenceNode, layout, 1))) throw Error("Reference layout admission failed");
      for (const scale of [1, .75, 1.25, 2]) for (const rotate of [0, 13, 45]) {
        const x = rotate ? .375 : -4.5, y = rotate ? .625 : -.25, color = 0xaaf08351;
        for (const [ui, node] of [[runtime, runtimeNode], [referenceUi, referenceNode]] as const) {
          ui.ops.setProp(node, PROP.scaleX, scale); ui.ops.setProp(node, PROP.scaleY, scale);
          ui.ops.setProp(node, PROP.rotate, rotate); ui.ops.setProp(node, PROP.translateX, x); ui.ops.setProp(node, PROP.translateY, y);
          ui.ops.setProp(node, PROP.textColor, color); ui.tick();
        }
        const actual = new Uint8Array(runtime.render()), expected = new Uint8Array(referenceUi.render());
        let different = 0;
        for (let i = 0; i < actual.length; i++) if (actual[i] !== expected[i]) different++;
        if (different) throw Error(`Reference differs: count=${count} scale=${scale} rotate=${rotate} bytes=${different}`);
        transformControls.push({ scale, rotate, x, y, color, differingBytes: different, sha256: digest(actual) });
      }
    }
    const record = { count, size: 16, coverage: "identical FreeType gray8", positions: "identical integer grid", framebufferSha256: digest(bakedPixels), differingBytes,
      runtimeUploadMs: uploadMs, bitmapBytes: rawCoverageBytes, currentRuntimeRgbaBytes: runtimeRgbaBytes, paddedPixels: runtimeRgbaBytes / 4,
      rgbaExpansionVsGray8: runtimeRgbaBytes / rawCoverageBytes, exactCoverageR8LowerBound: rawCoverageBytes,
      pageEstimates: [128, 256, 512].flatMap(size => [packedPages(glyphs, size), packedPages(glyphs, size, true), packedPages(glyphs, size, true, true)]),
      bakedCoverageBytes: atlasCount * cellW * cellH, runtimeResources: JSON.parse(runtime.ops.fontStreamStats!()).runtime,
      drawCommands: { bakedGlyphRunWords: 3 + count * 2, runtimeTexQuadWords: count * 9,
        runtimeConsecutiveHandleBinds: count, bakedWgpuConsecutiveAtlasPageBinds: 1,
        bakedPspConsecutiveAtlasPageBinds: Math.floor(count / (Math.floor(64 / cellW) * Math.floor(128 / cellH))) + 1,
        bindCountKind: "inferred from consecutive unique glyphs; not hardware telemetry" },
      timings: Object.fromEntries(Object.entries(timings).map(([path, result]) => [path, { drawAndHash: summarize(result.drawHash), fullFrame: summarize(result.fullFrame) }])),
      transformControls, samples: timings };
    records.push(record); console.log(JSON.stringify({ ...record, samples: undefined }));
    await worker.request("runtime.release", { key: `render-${count}` });
  }
} finally { worker.close(); }
await mkdir(dirname(out), { recursive: true });
await Bun.write(out, JSON.stringify({ timestamp: new Date().toISOString(), platform: `${process.platform}/${process.arch}`, renderer: "core WASM software RGBA, full render forced every frame",
  wasmPath, wasmSha256: digest(wasmBytes), referencePath, notes: ["Resources are all resident before timing; excludes FreeType/shaping/I/O/transport.",
    "Baked atlas constructed from the same FreeType bytes; pixel equality required.", "DrawAndHash includes hash cost and is not a pure draw-list construction metric.",
    "Binding counts and packed-page memory are code-derived estimates; no PSP hardware speedup is claimed."], records }, null, 2) + "\n");
