/** Real archive I/O stays in this Worker, as in the companion provider. */
import { createFontArchiveProvider } from "../../tools/font-archive-provider.ts";

let provider: ReturnType<typeof createFontArchiveProvider>;
self.onmessage = async ({ data }) => {
  if (data.init) {
    provider = createFontArchiveProvider({ "benchmark.pjfa": data.init.archive });
    self.postMessage({ ready: true });
    return;
  }
  try {
    const method = provider.methods[data.method];
    if (!method) throw Error("Unknown font benchmark method");
    const payload = await method(data.payload);
    self.postMessage({ id: data.id, payload });
  } catch (error) {
    self.postMessage({ id: data.id, error: String(error) });
  }
};
