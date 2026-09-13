import { createTextEngine } from "./text-engine.js";
let engine;
self.onmessage = async ({ data }) => {
  if (data.init) {
    const response = await fetch(data.wasmUrl);
    if (!response.ok) throw Error("Text WASM unavailable");
    engine = await createTextEngine(await response.arrayBuffer(), data.pak);
    self.postMessage({ ready: true });
    return;
  }
  if (!engine) throw Error("Text worker not ready");
  self.postMessage({ record: engine.request(data.record) });
};
