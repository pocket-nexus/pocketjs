import { RimeEngine } from "./rime.ts";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { connectOffloadProvider } from "../offload-provider.ts";
const args = Bun.argv.slice(2);
const option = (name: string, fallback: string) => args.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const key = readFileSync(resolve(option("key", ".pocket/clear-offload.key")), "utf8").trim();
const port = Number(option("port", "18741"));
const engine = new RimeEngine(resolve(option("data", ".pocket/ime")));
const token = randomBytes(32).toString("hex");
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, maxRequestBodySize: 2048,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (request.method !== "POST" || !["/compose", "/candidates"].includes(path) || request.headers.get("authorization") !== token)
      return new Response("Forbidden", { status: 403 });
    try { return new Response(await engine.compose(await request.text(), path === "/candidates")); }
    catch { return new Response("IME engine unavailable", { status: 503 }); }
  },
});
let lastSession = "";
const provider = connectOffloadProvider({ address: "127.0.0.1", port, key,
  worker: new URL("./worker.ts", import.meta.url),
  data: { enginePort: server.port, engineToken: token, font: option("font", "/System/Library/Fonts/STHeiti Medium.ttc") }, log: message => {
    if (!message.startsWith("Device ")) console.log(message);
    else if (message !== lastSession) { lastSession = message; console.log(`Paired ${message}`); }
  } });
process.on("SIGINT", () => { provider.close(); engine.close(); server.stop(true); process.exit(0); });
process.on("SIGTERM", () => { provider.close(); engine.close(); server.stop(true); process.exit(0); });
console.log(`Pocket IME companion: USB localhost:${port}`);
