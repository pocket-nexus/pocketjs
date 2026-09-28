import { dispatchOffload } from "../../../tools/offload-provider.ts";
declare const self: { onmessage: (event: MessageEvent) => void; postMessage(value: unknown): void };
let url = "";
self.onmessage = async event => {
  if (event.data.init) { url = event.data.init.url; return; }
  self.postMessage(await dispatchOffload({
    "test.pid": () => String(process.pid),
    "test.image": () => ({ width: 256, height: 256, format: "r5g6b5", pixels: new Uint8Array(131072).fill(event.data.id & 255) }),
    "test.fetch": async () => (await fetch(url, { signal: AbortSignal.timeout(8000) })).text(),
    "test.hang": () => new Promise<string>(() => {}),
    "test.crash": () => {
      if (!process.send) throw new Error("Crash fixture requires process isolation");
      process.kill(process.pid, "SIGKILL"); return "unreachable";
    },
  }, event.data));
};
