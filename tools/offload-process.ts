/** Bun subprocess adapter for existing provider modules using self.onmessage.
 * OS process termination isolates fetch/native-addon teardown from the LAN
 * transport. IPC uses structured cloning, including bounded image planes. */
import { OFFLOAD } from "../contracts/spec/offload.ts";
const waiting: unknown[] = [];
let loaded = false;
const scope = {
  onmessage: undefined as ((event: { data: unknown }) => unknown) | undefined,
  postMessage(value: unknown) { process.send?.(value); },
};
(globalThis as unknown as { self: typeof scope }).self = scope;
function deliver(data: unknown) {
  try {
    if (!scope.onmessage) throw new Error("Provider module has no message handler");
    Promise.resolve(scope.onmessage({ data })).catch(() => process.exit(1));
  } catch { process.exit(1); }
}
process.on("message", data => {
  if (loaded) deliver(data);
  else if (waiting.length < OFFLOAD.pending + 1) waiting.push(data);
  else process.exit(1);
});
// Do not leave a provider behind when its transport process goes away.
process.on("disconnect", () => process.exit(0));
await import(process.argv[2]!);
loaded = true;
for (const data of waiting) deliver(data);
waiting.length = 0;
