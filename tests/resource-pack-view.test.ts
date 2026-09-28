import { expect, test } from "bun:test";
import { createRoot } from "solid-js";
import { createOffloadClient } from "../framework/src/offload.ts";
import {
  createResourceRuntime,
  createResourceView,
} from "../framework/src/resource-view.ts";
import { installHost, type HostOps } from "../framework/src/host.ts";

test("pixel cache shares pack admission and releases withdrawn or expired buffers", async () => {
  const replies: string[] = [], writes: Uint8Array[] = [];
  let accept = false;
  (globalThis as any).resourcePacks = {
    session: () => 1, enqueue: () => false, take: () => replies.shift(), uploadImage: () => 1, releaseImage() {}, stats: () => "",
    cacheImage: () => false, cacheText: () => false,
    cachePixels(id: number, _pack: string, _entry: number, pixels: Uint8Array, w: number, h: number) {
      if (!accept) return false;
      expect([w, h]).toEqual([16, 16]); writes.push(pixels.slice());
      replies.push(JSON.stringify({ id, payload: "saved" })); return true;
    },
  };
  const api: typeof import("../apps/manga/pack-client.ts") = await import(`../apps/manga/pack-client.ts?pixels=${++realm}`);
  const packs = api.resourcePacks()!, cache = api.resourcePackCache()!, pixels = new Uint8Array(512).fill(7);
  let done = 0;
  const save = () => cache.pixels!("mg-test", 2, pixels, 16, 16, result => { expect(result.ok).toBe(true); done++; });
  try {
    const ids = Array.from({ length: 4 }, save);
    expect(ids.every(Boolean)).toBe(true); expect(save()).toBe(0);
    packs.cancel(ids[0]!); expect(save()).toBeGreaterThan(0);
    packs.step(); expect(writes).toHaveLength(0);
    accept = true;
    for (let n = 0; n < 12; n++) packs.step();
    expect(done).toBe(4); expect(writes).toHaveLength(4); expect(writes[0]).toEqual(pixels);
    accept = false;
    let expired = 0;
    for (let n = 0; n < 4; n++) cache.pixels!("mg-test", 2, pixels, 16, 16, result => { if (!result.ok) expired++; });
    for (let n = 0; n < 1300; n++) packs.step();
    expect(expired).toBe(4); expect(save()).toBeGreaterThan(0);
  } finally { packs.dispose(); delete (globalThis as any).resourcePacks; }
});

// Separate module realms model separate guest boots, including an unsupported
// host. The real offload client and collection own every ticket in these tests.
let realm = 0;
async function fixture(supported = true) {
  const sent: { id: number; name: string; entry: number }[] = [];
  const replies: string[] = [],
    released: number[] = [],
    freed: number[] = [];
  let upload = 0;
  const ops = {
    session: () => 1,
    enqueue(id: number, name: string, entry: number) {
      sent.push({ id, name, entry });
      return true;
    },
    take: () => replies.shift(),
    uploadImage: () => ++upload,
    releaseImage: (id: number) => released.push(id),
    stats: () => "",
  };
  const target = globalThis as any;
  if (supported) target.resourcePacks = ops;
  else delete target.resourcePacks;
  installHost({
    kind: "injected",
    target: "test",
    strict: true,
    ops: { freeTexture: (id: number) => freed.push(id) } as unknown as HostOps,
  });
  const api: typeof import("../apps/manga/pack-client.ts") = await import(
    `../apps/manga/pack-client.ts?realm=${++realm}`
  );
  const local = api.resourcePacks();
  const remoteSent: any[] = [],
    remoteReplies: string[] = [],
    remoteReleased: number[] = [];
  let connected = true;
  const remote = createOffloadClient({
    session: () => (connected ? 1 : 0),
    submit(raw) {
      remoteSent.push(JSON.parse(raw));
      return true;
    },
    take: () => remoteReplies.shift(),
    uploadImage: () => 100,
    releaseImage: (id) => remoteReleased.push(id),
  });
  return {
    api,
    local,
    remote,
    sent,
    replies,
    released,
    freed,
    remoteSent,
    remoteReplies,
    remoteReleased,
    disconnect() {
      connected = false;
    },
    uploaded: () => upload,
    reply(id: number, token: number) {
      replies.push(
        JSON.stringify({ id, image: { token, width: 16, height: 16 } }),
      );
    },
    close() {
      local?.dispose();
      remote.dispose();
      delete target.resourcePacks;
    },
  };
}
const demand = [{ input: "tile", priority: 0, pin: true }];
function collection(
  f: Awaited<ReturnType<typeof fixture>>,
  runtime: ReturnType<typeof createResourceRuntime>,
  materialized?: (s: "local" | "desktop") => void,
) {
  return f.api.createPackedImageCollection(runtime, {
    key: (i: string) => i,
    pack: () => ({ name: "atlas", entry: 1 }),
    width: 16,
    height: 16,
    maxEntries: 2,
    maxViews: 1,
    fallback: { client: f.remote, method: "map.tile", payload: (i) => i },
    materialized,
  });
}
test("prepared local images retain normal view cleanup and need no desktop credit", async () => {
  const f = await fixture();
  f.disconnect();
  createRoot((dispose) => {
    const runtime = createResourceRuntime({
      maxConcurrent: 1,
      maxCollections: 2,
      startsPerFrame: 1,
      completionsPerFrame: 1,
    });
    const query = f.api.createPackedImageCollection(runtime, {
      key: (i: string) => i,
      pack: () => undefined,
      width: 16, height: 16,
      maxEntries: 1, maxViews: 1,
      fallback: { client: f.remote, method: "manga.image", payload: i => i },
    });
    createResourceView(query, {
      demand: () => [{ input: "offline", priority: -10 }],
    });
    const sources: string[] = [],
      c = collection(f, runtime, (s) => sources.push(s));
    const v = createResourceView(c, { demand: () => demand });
    runtime.step();
    f.local!.step();
    expect(f.sent).toHaveLength(1);
    expect(f.remoteSent).toHaveLength(0);
    f.reply(f.sent[0]!.id, 8);
    f.local!.step();
    runtime.step();
    expect(v.state("tile").status).toBe("ready");
    expect(sources).toEqual(["local"]);
    expect(f.released).toEqual([8]);
    expect(f.freed).toEqual([]);
    dispose();
    expect(f.freed).toEqual([1]);
  });
  f.close();
});
test("missing packs and unsupported hosts resolve through the same desktop cache", async () => {
  for (const supported of [true, false]) {
    const f = await fixture(supported);
    createRoot((dispose) => {
      const runtime = createResourceRuntime({
        maxConcurrent: 1,
        maxCollections: 1,
        startsPerFrame: 1,
        completionsPerFrame: 1,
      });
      const sources: string[] = [],
        c = collection(f, runtime, (s) => sources.push(s)),
        v = createResourceView(c, { demand: () => demand });
      runtime.step();
      if (supported) {
        f.local!.step();
        f.replies.push(
          JSON.stringify({
            id: f.sent[0]!.id,
            error: "Resource pack not installed",
          }),
        );
        f.local!.step();
      }
      f.remote.step();
      expect(f.remoteSent).toHaveLength(1);
      f.remoteReplies.push(
        JSON.stringify({
          id: f.remoteSent[0].id,
          image: { token: 16, width: 16, height: 16 },
        }),
      );
      f.remote.step();
      runtime.step();
      expect(v.state("tile").status).toBe("ready");
      expect(sources).toEqual(["desktop"]);
      expect(f.remoteReleased).toEqual([16]);
      c.clear();
      runtime.step();
      f.local?.step();
      f.remote.step();
      expect(f.sent).toHaveLength(supported ? 1 : 0);
      expect(f.remoteSent).toHaveLength(2);

      dispose();
      expect(f.freed).toEqual([100]);
    });
    f.close();
  }
});
test("withdrawn and failed materializations release local staging exactly once", async () => {
  for (const failure of [false, true]) {
    const f = await fixture();
    createRoot((dispose) => {
      const runtime = createResourceRuntime({
        maxConcurrent: 1,
        maxCollections: 1,
        startsPerFrame: 1,
        completionsPerFrame: 1,
      });
      const c = collection(f, runtime, () => {
        if (failure) throw Error("consumer failed");
      });
      let wanted = true;
      const v = createResourceView(c, { demand: () => (wanted ? demand : []) });
      runtime.step();
      f.local!.step();
      f.reply(f.sent[0]!.id, 24);
      f.local!.step();
      if (!failure) wanted = false;
      runtime.step();
      expect(f.released).toEqual([24]);
      if (failure) {
        expect(v.state("tile").status).toBe("error");
        expect(f.freed).toEqual([1]);
      } else expect(f.uploaded()).toBe(0);
      dispose();
      expect(f.released).toEqual([24]);
    });
    f.close();
  }
});
