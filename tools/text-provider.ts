/** Paired companion reference implementation. Explicit pak/font paths are
 * provider grants; the remote guest can never supply a path or read a file. */
import { connectOffloadUsbProvider } from "./offload-usb-provider.ts";
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { connectOffloadProvider } from "./offload-provider.ts";
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    usb: { type: "string" },
    app: { type: "string" },
    address: { type: "string" },
    "key-file": { type: "string" },
    pak: { type: "string" },
    font: { type: "string", multiple: true },
    port: { type: "string" },
  },
});
if (
  !values.pak ||
  (!(values.usb && values.app) && !(values.address && values["key-file"]))
)
  throw Error(
    "Usage: --pak APP.pak [--font FONT.ttf] with either --usb HOST0_DIR --app APP_ID or --address DEVICE --key-file KEY",
  );
const shared = {
  worker: new URL("./text-provider-worker.ts", import.meta.url),
  data: {
    pak: resolve(values.pak),
    wasm: resolve(import.meta.dir, "../hosts/web/pocket_text.wasm"),
    fonts: (values.font ?? []).map((path) => resolve(path)),
  },
  log: console.log,
};
const provider = values.usb
  ? connectOffloadUsbProvider({
      ...shared,
      directory: values.usb,
      app: values.app!,
    })
  : connectOffloadProvider({
      ...shared,
      address: values.address!,
      key: readFileSync(values["key-file"]!, "utf8").trim(),
      port: values.port ? Number(values.port) : undefined,
    });
process.on("SIGINT", () => {
  provider.close();
  process.exit(0);
});
