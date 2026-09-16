import { afterEach, expect, test } from "bun:test";
import { createMediaService } from "../framework/src/media-service.ts";
import { installHost, type HostOps } from "../framework/src/host.ts";
import { runServicePumps } from "../framework/src/services.ts";
import type { ServiceClient, ServiceMessage } from "../framework/src/service-client.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); delete (globalThis as any).media; });
function rig(native: boolean) {
  const requests: { message: ServiceMessage; reply: (message: ServiceMessage) => void }[] = [];
  const calls: unknown[] = [];
  let push = (_: ServiceMessage) => {}, index = 0;
  const ops = { videoTick: () => index++, videoTexture: () => 7, videoClose: () => calls.push("close-ring") } as unknown as HostOps;
  installHost({ ops, kind: "injected", target: "test", strict: false });
  if (native) (globalThis as any).media = {
    open: (...args: unknown[]) => { calls.push(args); return true; }, close: () => calls.push("close-native"),
    paused: (value: boolean) => calls.push(value), volume: (value: number) => calls.push(value), texture: () => 9,
    status: () => JSON.stringify({ phase: "playing", positionMs: 4500, presentedFrames: 10 }),
  };
  const service: ServiceClient = {
    transport: () => "companion", send: (message, reply) => requests.push({ message, reply }),
    subscribe: listener => { push = listener; return () => {}; }, image: () => -1,
    openStream: file => { calls.push(file); return true; }, dispose() {},
  };
  const player = createMediaService(service); cleanups.push(player.dispose);
  const source = native ? { host: "127.0.0.1", port: 9000, token: "a".repeat(64) } : undefined;
  const playing = { t: "playing", stream: "media/one.pkst", source, fps: 12, position: 0 };
  return { player, service, requests, calls, playing, push: (event: ServiceMessage) => push(event),
    step: (count: number) => { for (let i = 0; i < count; i++) runServicePumps(); } };
}
for (const native of [true, false]) test(`${native ? "native" : "ring"} provider owns open, clock, pause, seek and stop`, () => {
  const r = rig(native), delivered: ServiceMessage[] = [];
  r.player.send({ t: "play", videoId: "domain-key" }, message => delivered.push(message));
  r.requests.shift()!.reply(r.playing); r.step(1);
  expect(r.player.texture()).toBe(native ? 9 : 7);
  r.player.send({ t: "pause" }, message => delivered.push(message));
  if (native) { expect(r.requests).toHaveLength(0); expect(r.calls).toContain(true); expect(r.player.status().positionMs).toBe(4500); }
  else { expect(r.requests[0].message.t).toBe("pause"); r.requests.shift()!.reply({ t: "state", playing: false, position: 0 }); }
  r.player.send({ t: "resume" }, () => {});
  if (native) expect(r.calls).toContain(false);
  else r.requests.shift()!.reply({ t: "state", playing: true, position: 0 });
  r.player.send({ t: "seek", to: 30 }, () => {});
  expect(r.requests[0].message).toEqual({ t: "seek", to: 30 });
  r.requests.shift()!.reply(native ? { ...r.playing, position: 30 } : { t: "state", playing: true, position: 30 });
  r.player.send({ t: "stop" }, () => {});
  expect(r.player.status().phase).toBe("idle");
  expect(r.calls).toContain(native ? "close-native" : "close-ring");
});
test("only companion ring providers poll for end and ignore an obsolete end reply", () => {
  const r = rig(false), events: ServiceMessage[] = [];
  r.player.subscribe(event => events.push(event));
  r.player.send({ t: "play" }, () => {}); r.requests.shift()!.reply(r.playing); r.step(120);
  const old = r.requests.shift()!; expect(old.message.t).toBe("status");
  r.player.send({ t: "play" }, () => {}); r.requests.shift()!.reply(r.playing);
  old.reply({ t: "status", ended: true }); expect(events).toHaveLength(0);
  r.step(120); r.requests.shift()!.reply({ t: "status", ended: true });
  expect(events).toEqual([{ t: "ended" }]); expect(r.player.status().phase).toBe("ended");
});
test("native status needs no companion polling; disconnect invalidates pending opens", () => {
  const r = rig(true);
  r.player.send({ t: "play" }, () => {}); r.requests.shift()!.reply(r.playing); r.step(360);
  expect(r.requests).toHaveLength(0);
  let delivered = false;
  r.player.send({ t: "seek", to: 10 }, () => { delivered = true; });
  const old = r.requests.shift()!; r.push({ t: "offline" }); old.reply(r.playing);
  expect(delivered).toBe(false); expect(r.player.status().phase).toBe("idle");
  expect(r.calls).toContain("close-native");
});
test("a new playback lifetime does not cancel unrelated service deliveries", () => {
  const r = rig(false), delivered: ServiceMessage[] = [];
  r.player.send({ t: "search" }, reply => delivered.push(reply));
  const search = r.requests.shift()!;
  r.player.send({ t: "play" }, () => {}); r.requests.shift()!.reply(r.playing);
  search.reply({ t: "results", items: [] });
  expect(delivered).toEqual([{ t: "results", items: [] }]);
});
for (const native of [true, false]) test(`a refused ${native ? "native" : "ring"} open stays an error until retry`, () => {
  const r = rig(native), delivered: ServiceMessage[] = [];
  if (native) (globalThis as any).media.open = () => false;
  else r.service.openStream = () => false;
  r.player.send({ t: "play", id: 42 }, reply => delivered.push(reply));
  r.requests.shift()!.reply(r.playing); r.step(120);
  expect(delivered[0]).toMatchObject({ t: "error", id: 42 });
  expect(r.player.status().phase).toBe("error");
  expect(r.requests).toHaveLength(0);
});
