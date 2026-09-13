import { readFile } from "node:fs/promises";
import { createTextEngine } from "../hosts/web/text-engine.js";
let engine: Awaited<ReturnType<typeof createTextEngine>>;
let ready: Promise<void>;
self.onmessage = async ({ data }) => {
  if (data.init) {
    ready = (async () => {
      engine = await createTextEngine(
        await readFile(data.init.wasm),
        await readFile(data.init.pak),
        await Promise.all(
          (data.init.fonts ?? []).map((path: string) => readFile(path)),
        ),
      );
    })();
    await ready;
    self.postMessage({ ready: true });
    return;
  }
  await ready;
  self.postMessage(JSON.parse(engine.request(JSON.stringify(data))));
};
