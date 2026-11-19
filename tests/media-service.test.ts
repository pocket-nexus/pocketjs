import { afterEach, expect, test } from "bun:test";
import { createMediaService } from "../framework/src/media-service.ts";
import { installHost, type HostOps } from "../framework/src/host.ts";
import { runServicePumps } from "../framework/src/services.ts";
import type { ServiceClient, ServiceMessage } from "../framework/src/service-client.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
function rig() {
  const requests: { message: ServiceMessage; reply: (message: ServiceMessage) => void }[] = [];
  const calls: unknown[] = [];
  let push = (_: ServiceMessage) => {}, index = 0;
  const ops = { videoTick: () => index++, videoTexture: () => 7, videoClose: () => calls.push("close-ring") } as unknown as HostOps;
  installHost({ ops, kind: "injected", target: "test", strict: false });
  const service: ServiceClient = {
    transport: () => "companion", send: (message, reply) => requests.push({ message, reply }),
    subscribe: listener => { push = listener; return () => {}; }, image: () => -1,
    openStream: file => { calls.push(file); return true; }, dispose() {},
  };
  const player = createMediaService(service); cleanups.push(player.dispose);
  const playing = { t: "playing", stream: "media/one.pkst", fps: 12, position: 0 };
  return { player, service, requests, calls, playing, push: (event: ServiceMessage) => push(event),
    step: (count: number) => { for (let i = 0; i < count; i++) runServicePumps(); } };
}
test("the ring provider owns open, clock, pause, seek and stop", () => {
  const r = rig(), delivered: ServiceMessage[] = [];
  r.player.send({ t: "play", videoId: "domain-key" }, message => delivered.push(message));
  r.requests.shift()!.reply(r.playing); r.step(1);
  expect(r.calls).toContain("media/one.pkst");
  expect(r.player.texture()).toBe(7);
  expect(r.player.status()).toMatchObject({ phase: "playing", presentedFrames: 1 });
  r.player.send({ t: "pause" }, message => delivered.push(message));
  expect(r.requests[0].message.t).toBe("pause"); r.requests.shift()!.reply({ t: "state", playing: false, position: 0 });
  expect(r.player.status().phase).toBe("paused");
  r.player.send({ t: "resume" }, () => {});
  r.requests.shift()!.reply({ t: "state", playing: true, position: 0 });
  r.player.send({ t: "seek", to: 30 }, () => {});
  expect(r.requests[0].message).toEqual({ t: "seek", to: 30 });
  r.requests.shift()!.reply({ t: "state", playing: true, position: 30 });
  expect(r.player.status().positionMs).toBe(30000);
  r.player.send({ t: "stop" }, () => {});
  expect(r.player.status().phase).toBe("idle");
  expect(r.calls).toContain("close-ring");
});
test("companion ring providers poll for end and ignore an obsolete end reply", () => {
  const r = rig(), events: ServiceMessage[] = [];
  r.player.subscribe(event => events.push(event));
  r.player.send({ t: "play" }, () => {}); r.requests.shift()!.reply(r.playing); r.step(120);
  const old = r.requests.shift()!; expect(old.message.t).toBe("status");
  r.player.send({ t: "play" }, () => {}); r.requests.shift()!.reply(r.playing);
  old.reply({ t: "status", ended: true }); expect(events).toHaveLength(0);
  r.step(120); r.requests.shift()!.reply({ t: "status", ended: true });
  expect(events).toEqual([{ t: "ended" }]); expect(r.player.status().phase).toBe("ended");
});
test("disconnect invalidates pending opens", () => {
  const r = rig();
  r.player.send({ t: "play" }, () => {}); r.requests.shift()!.reply(r.playing);
  let delivered = false;
  r.player.send({ t: "seek", to: 10 }, () => { delivered = true; });
  const old = r.requests.shift()!; r.push({ t: "offline" }); old.reply(r.playing);
  expect(delivered).toBe(false); expect(r.player.status().phase).toBe("idle");
  expect(r.calls).toContain("close-ring");
});
test("a new playback lifetime does not cancel unrelated service deliveries", () => {
  const r = rig(), delivered: ServiceMessage[] = [];
  r.player.send({ t: "search" }, reply => delivered.push(reply));
  const search = r.requests.shift()!;
  r.player.send({ t: "play" }, () => {}); r.requests.shift()!.reply(r.playing);
  search.reply({ t: "results", items: [] });
  expect(delivered).toEqual([{ t: "results", items: [] }]);
});
test("a refused ring open stays an error until retry", () => {
  const r = rig(), delivered: ServiceMessage[] = [];
  r.service.openStream = () => false;
  r.player.send({ t: "play", id: 42 }, reply => delivered.push(reply));
  r.requests.shift()!.reply(r.playing); r.step(120);
  expect(delivered[0]).toMatchObject({ t: "error", id: 42 });
  expect(r.player.status().phase).toBe("error");
  expect(r.requests).toHaveLength(0);
});
