/** Profiling-only worker; page aggregation is an experiment, not a wire change. */
import { readFile } from "node:fs/promises";
import { createTextEngine } from "../hosts/web/text-engine.js";
import { runtimeFontPaths } from "../tests/helpers/runtime-text-worker.ts";
let engine: Awaited<ReturnType<typeof createTextEngine>>;
let compactPages = false;
self.onmessage = async ({ data }) => {
  if (data.init) {
    compactPages = !!data.compactPages;
    engine = await createTextEngine(await readFile("hosts/web/pocket_text.wasm"), undefined,
      await Promise.all(runtimeFontPaths.map(path => readFile(path))),
      { freetypeBytes: await readFile("hosts/web/pocket_freetype.wasm") });
    self.postMessage({ ready: true }); return;
  }
  const request = JSON.parse(data.record);
  const start = performance.now();
  let record = engine.request(data.record), calls = 1;
  if (compactPages && request.method === "runtime.layout.page") {
    const first = JSON.parse(record);
    if (first.payload) {
      const input = JSON.parse(request.payload), page = JSON.parse(first.payload);
      const items: unknown[] = [];
      let current = page;
      let full = false;
      while (!full) {
        for (const item of current.items) {
          const count = items.length + 1, next = input.offset + count;
          const payload = JSON.stringify({ items: [...items, item], next: next < page.total ? next : null, total: page.total });
          if (count > 64 || payload.length > 2400 || Buffer.byteLength(JSON.stringify({ id: request.id, payload })) > 4096) { full = true; break; }
          items.push(item);
        }
        const next = input.offset + items.length;
        if (full || next >= page.total || items.length >= 64) break;
        const response = JSON.parse(engine.request(JSON.stringify({ ...request, payload: JSON.stringify({ ...input, offset: next }) })));
        calls++;
        if (response.error) break;
        current = JSON.parse(response.payload);
      }
      const next = input.offset + items.length;
      record = JSON.stringify({ id: request.id, payload: JSON.stringify({ items, next: next < page.total ? next : null, total: page.total }) });
    }
  }
  self.postMessage({ record, workerMs: performance.now() - start, calls });
};
