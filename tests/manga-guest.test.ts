import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import vm from "node:vm";
import { BTN } from "../contracts/spec/spec.ts";
import { THREE_DS_DEV_HOST_ABI } from "../tools/3ds-profile.ts";
import { MangaRelayAuthority } from "../apps/manga/companion/relay.ts";
import { RelayEndpoint } from "../framework/src/relay/endpoint.ts";
import { MANGA_RELAY, MANGA_PRIVATE_OPS, mangaRelayLimits } from "../apps/manga/relay-profile.ts";

test.each([false, true])("compiled terminal retains selection and caches with Relay lane=%s", async relay => {
  mkdirSync(".pocket", { recursive: true });
  const out = mkdtempSync(resolve(".pocket/test-manga-"));
  try {
    const build = Bun.spawnSync([process.execPath, "tools/3ds.ts", "manga", "--pocket-only", `--outdir=${out}/guest`, `--package-outdir=${out}`], { timeout: 30000 });
    if (build.exitCode !== 0) throw Error(build.stderr.toString());
    const children = new Map<number, number[]>(), parents = new Map<number, number>(), texts = new Map<number, string>();
    let next = 10, handle = 100, token = 1, saved = "";
    const noop = () => {};
    const ui: any = new Proxy({
      __host: "3ds-dev", __hostAbi: THREE_DS_DEV_HOST_ABI, __viewport: { w: 400, h: 240 }, __auxiliarySurface: { root: 2, w: 320, h: 240 },
      createNode() { return next++; },
      destroyNode(id: number) { for (const c of children.get(id) ?? []) ui.destroyNode(c); children.delete(id); parents.delete(id); texts.delete(id); },
      insertBefore(p: number, c: number, anchor: number) {
        if (parents.has(c)) ui.removeChild(parents.get(c), c);
        const list = children.get(p) ?? [], at = list.indexOf(anchor);
        list.splice(at < 0 ? list.length : at, 0, c); children.set(p, list); parents.set(c, p);
      },
      removeChild(p: number, c: number) { children.set(p, (children.get(p) ?? []).filter(n => n !== c)); parents.delete(c); },
      setText(id: number, value: string) { texts.set(id, value); },
      replaceText(id: number, value: string) { texts.set(id, value); },
      getRect: () => [0, 0, 0, 0], getProp: () => 0, isFocused: () => false,
    }, { get: (o, key) => key in o ? o[key as keyof typeof o] : String(key).startsWith("__") ? undefined : noop });
    const series = ["a", "b"].map(slug => ({ slug, title: slug === "a" ? "Alpha" : "Beta", pages: 2, direction: "rtl" }));
    const records = new Map<string, string>([["manga-index/0", JSON.stringify({ v: 3, series })],
      ...series.map(s => [`manga-${s.slug}/0`, JSON.stringify({ ...s, pageW: 400, pageH: 600, levels: [{ scale: 1, cols: 2, rows: 3 }] })] as [string, string])]);
    if (relay) { records.set("mc-123/0", records.get("manga-index/0")!); records.set("manga-index/0", '{"catalog":"mc-123"}'); }
    const cached = relay ? new Map<string, string>() : records;
    const cachedImages = new Set<string>();
    const replies: string[] = [], requests: string[] = [];
    const packs = {
      session: () => 1,
      enqueue(id: number, pack: string, entry: number) {
        requests.push(`${pack}/${entry}`);
        if (entry === 0) {
          const payload = cached.get(`${pack}/${entry}`);
          replies.push(JSON.stringify(payload ? { id, payload } : { id, error: "Resource pack not installed" }));
        } else if (!relay || cachedImages.has(`${pack}/${entry}`)) replies.push(JSON.stringify({ id, image: { token: token++, width: entry === 1 ? 128 : 256, height: entry === 1 ? 128 : 256 } }));
        else replies.push(JSON.stringify({ id, error: "Resource pack not installed" }));
        return true;
      },
      take: () => replies.shift(), uploadImage: () => handle++, releaseImage: noop, stats: () => "",
      cacheImage: () => false,
      cacheText(id: number, pack: string, entry: number, value: string) {
        cached.set(`${pack}/${entry}`, value); replies.push(JSON.stringify({ id, payload: "saved" })); return true;
      },
      cachePixels(id: number, pack: string, entry: number, bytes: Uint8Array, w: number, h: number) {
        expect(bytes.length).toBe(w * h * 2); cachedImages.add(`${pack}/${entry}`);
        replies.push(JSON.stringify({ id, payload: "saved" })); return true;
      },
    };
    const inbound: Uint8Array[] = [], outbound: Uint8Array[] = [];
    let attachment = 1;
    const authority = relay ? new MangaRelayAuthority({
      async call(method, payload) {
        if (method === "manga.progress-part") return { payload: JSON.stringify({ saved: JSON.parse(payload).updated }) };
        if (method === "manga.image") {
          requests.push(payload); const side = payload.endsWith("/1") ? 128 : 256;
          return { image: { width: side, height: side, format: "r5g6b5", pixels: new Uint8Array(side * side * 2) } };
        }
        return { payload: records.get(payload)! };
      }, close() {},
    }) : undefined;
    await authority?.refresh();
    const peer = { id: "reader", grants: [MANGA_RELAY.app] }, binding = authority?.connection(peer);
    const provider = relay ? new RelayEndpoint({ role: "provider", privateOps: MANGA_PRIVATE_OPS,
      local: { versions: [[1, 0]], profiles: [MANGA_RELAY.profile], codecs: MANGA_RELAY.codecs, kinds: MANGA_RELAY.kinds, rxLimits: mangaRelayLimits(true) },
      transport: { peer, trySend(bytes) { if (inbound.length >= 8) return "busy"; inbound.push(bytes.slice()); return "accepted"; } },
      hooks: binding!.hooks, scheduler: { now: () => 0, setTimeout: () => 1, clearTimeout() {} },
    }) : undefined;
    binding?.bind(provider!);
    const context = vm.createContext({ console, ui, resourcePacks: packs, state: { read: () => saved, write: (s: string) => { saved = s; return 0; } }, queueMicrotask,
      ...(relay ? { relayChannel: { session: () => attachment, send(bytes: Uint8Array) {
        if (outbound.length >= 8) return false; outbound.push(new Uint8Array(bytes)); return true;
      }, take(target: Uint8Array) { const bytes = inbound.shift(); if (!bytes) return 0; target.set(bytes); return bytes.length; } } } : {}),
    });
    vm.runInContext(readFileSync(join(out, "guest/manga-main.js"), "utf8"), context);
    const frames = async (count = relay ? 100 : 40, buttons = 0) => { for (let n = 0; n < count; n++) {
      while (outbound.length) provider!.handleRecord(outbound.shift()!);
      context.frame(buttons, 0); provider?.flush(); await Promise.resolve();
    } };
    const press = async (button: number) => { await frames(1, button); await frames(); };
    const visible = () => {
      const values: string[] = [];
      const visit = (id: number) => { if (texts.has(id)) values.push(texts.get(id)!); for (const c of children.get(id) ?? []) visit(c); };
      visit(1); visit(2); return values.join("|");
    };
    await frames(); expect(visible()).toContain("Alpha"); expect(visible()).toContain("Beta");
    await press(BTN.DOWN); await press(BTN.CIRCLE); await press(BTN.CIRCLE);
    await press(BTN.RTRIGGER); await press(BTN.SELECT);
    expect(visible()).toContain("Beta");
    expect(JSON.parse(saved).series.b.page).toBe(1);
    expect(JSON.parse(saved).series.b.bookmarks).toEqual([1]);
    expect(requests.some(r => r.startsWith("manga-a/") && Number(r.split("/")[1]) > 1)).toBe(false);
    await press(BTN.CROSS); await press(BTN.CROSS); await press(BTN.DOWN); await press(BTN.CIRCLE);
    expect(visible()).toContain("Alpha");
    if (relay) {
      expect(cachedImages.size).toBeGreaterThan(0); expect(cached.has("manga-index/0")).toBe(true);
      attachment = 0; inbound.length = 0; outbound.length = 0;
      await frames(); expect(visible()).toContain("Alpha");
      expect(provider!.protocolErrors).toBe(0); await authority!.close();
    }
  } finally { rmSync(out, { recursive: true, force: true }); }
}, 40000);
