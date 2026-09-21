import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createTextEngine } from "../hosts/web/text-engine.js";
import { readTextWorkerFonts } from "./text-worker-assets.ts";
let engine: Awaited<ReturnType<typeof createTextEngine>>;
let ready: Promise<void>;
self.onmessage = async ({ data }) => {
  if (data.init) {
    ready = (async () => {
      engine = await createTextEngine(
        await readFile(data.init.wasm),
        data.init.pak ? await readFile(data.init.pak) : undefined,
        await readTextWorkerFonts(data.init.fonts ?? []),
        { freetypeBytes: await readFile(join(dirname(data.init.wasm), "pocket_freetype.wasm")) },
      );
    })();
    await ready;
    self.postMessage({ ready: true });
    return;
  }
  await ready;
  self.postMessage(JSON.parse(engine.request(JSON.stringify(data))));
};
