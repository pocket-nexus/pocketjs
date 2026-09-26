import { expect, test } from "bun:test";
import vm from "node:vm";
import { utf8Length } from "../framework/src/relay/utf8.ts";

test("relay counts UTF-8 without allocating browser encoders", () => {
  for (const text of ["", "abc", "漫画", "😀", "\ud800", "x\udfff漫画😀"])
    expect(utf8Length(text)).toBe(new TextEncoder().encode(text).length);
});

test("bundled relay negotiates and decodes metadata in a realm without Web APIs", async () => {
  const build = await Bun.build({ entrypoints: ["./framework/src/relay/endpoint.ts"], target: "browser", format: "cjs" });
  expect(build.success).toBe(true);
  const context = vm.createContext({ module: { exports: {} } });
  vm.runInContext(await build.outputs[0]!.text(), context);
  const result = await vm.runInContext(`(async () => {
    const { RelayEndpoint } = module.exports;
    const limits = { maxWireBytes: 4096, maxMetaBytes: 2048, windowFrames: 8, windowBytes: 32768,
      maxPending: 8, maxObjectBytes: 131072, maxAssemblies: 2, maxScratchBytes: 262144 };
    const local = { versions: [[1, 0]], profiles: [{name: "manga.library", version: 1}], codecs: [0, 1], kinds: [1], rxLimits: limits };
    const queue = [];
    const options = { local, scheduler: { now: () => 0, setTimeout: () => 1, clearTimeout() {} },
      randomBytes: n => new Uint8Array(n).fill(3) };
    const guest = new RelayEndpoint({ ...options, role: "guest", local: { ...local, app: "pocket-manga" },
      transport: { peer: { id: "companion", grants: ["pocket-manga"] }, trySend(b) { queue.push(() => provider.handleRecord(b)); return "accepted"; } } });
    const provider = new RelayEndpoint({ ...options, role: "provider",
      transport: { peer: { id: "reader", grants: ["pocket-manga"] }, trySend(b) { queue.push(() => guest.handleRecord(b)); return "accepted"; } } });
    const drain = async () => { for (let n = 0; n < 30; n++) { while (queue.length) queue.shift()(); await Promise.resolve(); } };
    guest.hello(); await drain();
    const opened = guest.open({ app: "pocket-manga", namespace: "manga/漫画😀", profile: local.profiles[0] });
    await drain();
    const stream = await opened;
    const result = [guest.phase, provider.phase, stream.namespace, guest.protocolErrors, provider.protocolErrors];
    guest.close(); provider.close(); return result;
  })()`, context);
  expect(Array.from(result)).toEqual(["ready", "ready", "manga/漫画😀", 0, 0]);
});
