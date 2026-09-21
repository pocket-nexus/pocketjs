/** Keep the worker's complete import/wasm/license closure in every static deployment. */
export const TEXT_WORKER_ASSETS = [
  "offload-worker.js", "text-worker.js", "text-engine.js", "freetype-bridge.js",
  "pocket_text.wasm", "pocket_freetype.js", "pocket_freetype.wasm", "FreeType-LICENSE.txt",
] as const;
