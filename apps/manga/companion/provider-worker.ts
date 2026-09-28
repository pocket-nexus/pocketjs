import { dispatchOffload } from "../../../tools/offload-provider.ts";
import { mangaMethods } from "./provider.ts";
import { dispatchManga } from "./backend.ts";
let service: ReturnType<typeof mangaMethods> | undefined;
self.onmessage = async ({ data }) => {
  if (data.init) { service?.close(); service = mangaMethods(data.init.root); return; }
  if (service && data.relay) { self.postMessage({ id: data.id, ...dispatchManga(service, data.method, data.payload, data.ifRevision) }); return; }
  if (service) self.postMessage(await dispatchOffload(service.methods, data));
};
