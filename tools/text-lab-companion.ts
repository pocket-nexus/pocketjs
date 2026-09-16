import { resolve } from "node:path";
import { connectOffloadProvider } from "./offload-provider.ts";
import { connectOffloadUsbProvider } from "./offload-usb-provider.ts";
const arg = (name: string) => { const at = Bun.argv.indexOf(name); return at < 0 ? undefined : Bun.argv[at + 1]; };
const directory = resolve(arg("--assets") ?? ".pocket-build/text-lab");
const worker = new URL("./text-lab-worker.ts", import.meta.url);
const usb = arg("--usb");
const provider = usb
  ? connectOffloadUsbProvider({ directory: resolve(usb), app: "dev.pocket-stack.text-cjk", worker, data: { directory }, log: console.log })
  : connectOffloadProvider({ address: arg("--address") ?? "127.0.0.1", key: process.env.POCKET_COMPANION_KEY ?? "",
      worker, data: { directory }, log: console.log });
process.on("SIGINT", () => { provider.close(); process.exit(0); });
