import { resolve } from "node:path";
import { createTextEngine } from "../../hosts/web/text-engine.js";

export const runtimeFontPaths = ["assets/fonts/Inter-Regular.ttf", "assets/fonts/JetBrainsMono-Regular.ttf", "tests/fixtures/runtime-font/NotoSansSC-Test.ttf", "tests/fixtures/runtime-font/NotoSans-Ligature.ttf"].map(p => resolve(p));
export async function runtimeEngine() {
  const engine = await createTextEngine(await Bun.file("hosts/web/pocket_text.wasm").arrayBuffer(), undefined,
    await Promise.all(runtimeFontPaths.map(p => Bun.file(p).arrayBuffer())),
    { freetypeBytes: await Bun.file("hosts/web/pocket_freetype.wasm").arrayBuffer() });
  let id = 0;
  return {
    request(method: string, data: unknown = {}) {
      const reply = JSON.parse(engine.request(JSON.stringify({ v: 1, id: ++id, method, payload: JSON.stringify(data) })));
      if (reply.error) throw new Error(reply.error);
      return JSON.parse(reply.payload);
    },
  };
}

/** Actual worker used by the PSP companion, with the same bounded records. */
export async function runtimeWorker(pak?: string) {
  const worker = new Worker(new URL("../../tools/text-provider-worker.ts", import.meta.url), { type: "module" });
  let id = 0;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const ready = new Promise<void>((resolveReady, rejectReady) => {
    const timer = setTimeout(() => rejectReady(new Error("Text worker startup timeout")), 30000);
    worker.onerror = event => { clearTimeout(timer); rejectReady(new Error(event.message)); };
    worker.onmessage = ({ data }) => {
      if (data.ready) { clearTimeout(timer); resolveReady(); return; }
      const request = pending.get(data.id);
      if (!request) return;
      pending.delete(data.id); clearTimeout(request.timer);
      if (data.error) request.reject(new Error(data.error)); else request.resolve(JSON.parse(data.payload));
    };
  });
  worker.postMessage({ init: { wasm: resolve("hosts/web/pocket_text.wasm"), pak, fonts: runtimeFontPaths } });
  try { await ready; } catch (error) { worker.terminate(); throw error; }
  return {
    request(method: string, data: unknown = {}): Promise<any> {
      const serial = ++id;
      return new Promise((resolveReply, reject) => {
        const timer = setTimeout(() => { pending.delete(serial); reject(new Error(`Worker timeout: ${method}`)); }, 10000);
        pending.set(serial, { resolve: resolveReply, reject, timer });
        worker.postMessage({ v: 1, id: serial, method, payload: JSON.stringify(data) });
      });
    },
    close() {
      for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error("Worker closed")); }
      pending.clear(); worker.terminate();
    },
  };
}
