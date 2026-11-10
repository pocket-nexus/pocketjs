// @pocketjs/framework/channel against a scripted host (globalThis.link.channel):
// what the applet's calls do when the channel under them closes.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ChannelError, type ChannelReader, channelState, emitStream, onEvent, onRequest, request } from "../framework/src/channel.ts";
import { runServicePumps } from "../framework/src/services.ts";
import { FakeChannel, bytes, text } from "./helpers/fake-channel.ts";

interface Host {
  status: { state: string; reason: string; generation: number };
  queue: string[];
  nextId: number;
}

let host: Host;

beforeEach(() => {
  host = { status: { state: "open", reason: "", generation: 7 }, queue: [], nextId: 1 };
  (globalThis as { link?: unknown }).link = {
    channel: {
      state: () => JSON.stringify(host.status),
      poll: () => host.queue.shift(),
      request: () => host.nextId++,
      cancel: () => 0,
      emit: () => 0,
      progress: () => 0,
      reply: () => 0,
      read: () => 0,
      write: () => 0,
      end: () => 0,
      close: () => 0,
    },
  };
});

afterEach(() => {
  delete (globalThis as { link?: unknown }).link;
  // The pump unregisters once nothing is open.
  runServicePumps();
});

const settled = async (promise: Promise<unknown>): Promise<unknown> => promise.then((value) => ({ value }), (error) => error);

describe("an applet's requests on a channel that closes", () => {
  test("a reply settles its call; the channel's state is read from the host", async () => {
    expect(channelState()).toEqual({ state: "open", reason: "", generation: 7 });
    const call = request("echo", { text: "x" });
    host.queue.push(JSON.stringify({ k: 3, id: call.id, s: 0, e: false, m: { echo: "x" } }));
    runServicePumps();
    expect(await call.reply).toEqual({ echo: "x" });
  });

  test("the link drops under a pending request: the call fails with closed, the reason in its message", async () => {
    const call = request("slow", {});
    runServicePumps();
    host.status = { state: "closed", reason: "connection", generation: 0 };
    runServicePumps();
    const error = (await settled(call.reply)) as ChannelError;
    expect(error).toBeInstanceOf(ChannelError);
    expect(error.code).toBe("closed");
    expect(error.message).toContain("connection");
  });

  test("the channel closed and opened again between two frames: a request of the old generation fails, one of the new stays", async () => {
    const old = request("slow", {});
    host.status = { state: "open", reason: "", generation: 8 };
    const fresh = request("echo", {});
    runServicePumps();
    expect(((await settled(old.reply)) as ChannelError).code).toBe("closed");
    host.queue.push(JSON.stringify({ k: 3, id: fresh.id, s: 0, e: false, m: { ok: true } }));
    runServicePumps();
    expect(await fresh.reply).toEqual({ ok: true });
  });
});

// ---- against a host whose ids start again at every connection -------------------
//
// The scenarios of the glue review (its findings 2, 3, 4 and the channel.ts
// bullets of 12). Each failed before its fix.

describe("handles across a reconnect, and requests that always end", () => {
  let fake: FakeChannel;
  const settle = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };
  const frame = async (n = 1) => { for (let i = 0; i < n; i += 1) { runServicePumps(); await settle(); } };
  const outcome = (promise: Promise<unknown>) => {
    const seen: { value?: unknown; error?: ChannelError; done: boolean } = { done: false };
    promise.then((value) => { seen.value = value; seen.done = true; }, (error) => { seen.error = error; seen.done = true; });
    return seen;
  };

  beforeEach(() => {
    fake = new FakeChannel();
    (globalThis as { link?: unknown }).link = { channel: fake.ops };
  });

  test("a reader kept across a reconnect fails with closed and reaches nothing of the next generation's stream of the same id", async () => {
    let old: ChannelReader | undefined;
    const first = request("blob", {}, { onProgress(_t, _args, stream) { if (stream) old = stream; } });
    const firstReply = outcome(first.reply);
    fake.progress(first.id, { t: "head" }, "response of generation 1");
    await frame();
    expect(old!.id).toBe(3);
    fake.drop();
    await frame();
    expect(firstReply.error!.code).toBe("closed");
    fake.reopen();
    let fresh: ChannelReader | undefined;
    const second = request("blob", {}, { onProgress(_t, _args, stream) { if (stream) fresh = stream; } });
    expect(second.id).toBe(3); // the ids started again
    fake.progress(second.id, { t: "head" }, "response of generation 2");
    await frame();
    fake.feed(second.id, "GENERATION-2-BYTES");
    const reads = fake.calls.read;
    const stale = outcome(old!.read(new Uint8Array(10)));
    await settle();
    expect(stale.error!.code).toBe("closed");
    expect(fake.calls.read).toBe(reads); // no call reached the host
    old!.close();
    expect(fake.inStreams.has(3)).toBe(true); // the new generation's stream is untouched
    const into = new Uint8Array(32);
    const count = await fresh!.read(into);
    expect(text(into.subarray(0, count!))).toBe("GENERATION-2-BYTES");
    first.cancel(); // names nothing now
    expect(fake.log.some((line) => line.startsWith("cancel"))).toBe(false);
    fake.reply(second.id, {});
    await frame(2);
  });

  test("a writer kept across a reconnect fails with closed and writes nothing into the next generation's stream", async () => {
    const log = emitStream("log", {})!;
    await log.write(bytes("old"));
    expect(log.id).toBe(3);
    fake.drop();
    await frame(2);
    fake.reopen();
    const upload = emitStream("upload", {})!;
    expect(upload.id).toBe(3);
    await upload.write(bytes("PHOTO-"));
    const stale = outcome(log.write(bytes("[log line]")));
    await frame(2);
    await upload.write(bytes("BYTES"));
    await frame(2);
    expect(stale.error!.code).toBe("closed");
    expect(text(fake.outStreams.get(3)!.bytes)).toBe("PHOTO-BYTES");
    log.close();
    expect(fake.outStreams.has(3)).toBe(true);
  });

  test("a handler that outlives a reconnect does not answer the next generation's request of the same id", async () => {
    let release: (value: unknown) => void = () => {};
    let calls = 0;
    const off = onRequest("applet.ask", () => {
      calls += 1;
      return calls === 1 ? new Promise<never>((resolve) => { release = resolve as (value: unknown) => void; }) : new Promise<never>(() => {});
    });
    const first = fake.daemonRequest({ t: "applet.ask", q: "generation 1" });
    await frame();
    fake.drop();
    await frame(2);
    fake.reopen();
    const second = fake.daemonRequest({ t: "applet.ask", q: "generation 2" });
    expect(second).toBe(first);
    await frame();
    release({ answer: "for generation 1" });
    await frame(2);
    expect(fake.replies.length).toBe(0);
    expect(fake.handed.has(second)).toBe(true); // still the new handler's to answer
    off();
    fake.drop();
    await frame(2);
  });

  test("a handler's result the host refuses, or JSON cannot carry, ends the request with an error reply", async () => {
    const offs = [
      onRequest("big", () => ({ blob: "x".repeat(9000) })),
      onRequest("bigint", () => ({ n: 1n }) as never),
      onRequest("cycle", () => { const o: Record<string, unknown> = {}; o.self = o; return o as never; }),
    ];
    const big = fake.daemonRequest({ t: "big" });
    const bigint = fake.daemonRequest({ t: "bigint" });
    const cycle = fake.daemonRequest({ t: "cycle" });
    await frame(4);
    const code = (id: number) => { const reply = fake.replies.find((entry) => entry.id === id)!; return [reply.error, JSON.parse(reply.json).code]; };
    expect(code(big)).toEqual([true, "too_large"]);
    expect(code(bigint)).toEqual([true, "internal"]);
    expect(code(cycle)).toEqual([true, "internal"]);
    expect(fake.handed.size).toBe(0);
    for (const off of offs) off();
    await frame(2);
  });

  test("a progress event on a request without onProgress gives back the response and leaves the body going out", async () => {
    fake.writeRoom = 4; // the body takes several frames
    const call = request("upload", { name: "photo" }, { body: bytes("0123456789abcdefghij") });
    const reply = outcome(call.reply);
    await frame();
    fake.progress(call.id, { t: "receiving", bytes: 8 }, "response (none will come)");
    await frame();
    expect(fake.log.at(-1)).toBe(`close in ${call.id} [response (none will come)]`);
    expect(fake.outStreams.has(call.id)).toBe(true);
    await frame(8);
    expect(text(fake.outStreams.get(call.id)!.bytes)).toBe("0123456789abcdefghij");
    expect(fake.outStreams.get(call.id)!.ended).toBe(true);
    fake.reply(call.id, { stored: 20 });
    await frame(2);
    expect(reply.value).toEqual({ stored: 20 });
  });

  test("a read into an empty array is refused and leaves the reader usable; a read after a reset fails as the first did", async () => {
    let reader: ChannelReader | undefined;
    const call = request("blob", {}, { onProgress(_t, _args, stream) { if (stream) reader = stream; } });
    fake.progress(call.id, { t: "head" }, "blob");
    await frame();
    fake.feed(call.id, "data");
    const empty = outcome(reader!.read(new Uint8Array(0)));
    await settle();
    expect(empty.error!.code).toBe("malformed");
    const into = new Uint8Array(8);
    expect(await reader!.read(into)).toBe(4);
    fake.inStreams.get(call.id)!.failed = true;
    const failed = outcome(reader!.read(into));
    await frame();
    expect(failed.error!.code).toBe("stream");
    const again = outcome(reader!.read(into));
    await settle();
    expect(again.error!.code).toBe("stream"); // not a clean end
    fake.reply(call.id, {});
    await frame(2);
  });

  test("a handler that throws does not stop the pump: its stream is given back and the frame's other messages are taken", async () => {
    const errors: unknown[][] = [];
    const console_ = globalThis.console;
    (globalThis as { console: unknown }).console = { ...console_, error: (...args: unknown[]) => errors.push(args) };
    try {
      const call = request("blob", {}, { onProgress() { throw new Error("handler bug"); } });
      const reply = outcome(call.reply);
      const off = onEvent("note", (_args, _stream) => { throw new Error("event bug"); });
      fake.progress(call.id, { t: "head" }, "blob");
      const stream = fake.event({ t: "note" }, "note bytes");
      fake.reply(call.id, { done: true });
      runServicePumps(); // must not throw
      await settle();
      expect(reply.value).toEqual({ done: true });
      expect(fake.inStreams.has(call.id)).toBe(false);
      expect(fake.inStreams.has(stream)).toBe(false);
      expect(errors.map((args) => String(args[0]))).toEqual(["channel handler: handler bug", "channel handler: event bug"]);
      off();
      await frame(2);
    } finally {
      (globalThis as { console: unknown }).console = console_;
    }
  });

  test("a message whose object is not JSON is answered or failed by its head, never left open", async () => {
    const call = request("echo", {});
    const reply = outcome(call.reply);
    fake.inbox.push({ k: 3, id: call.id, s: 0, e: false, m: null });
    const real = fake.ops.poll;
    // The host builds the entry around the daemon's own bytes: here they are not JSON.
    fake.ops.poll = () => { const raw = real(); return raw === undefined ? raw : raw.replace('"m":null', '"m":{"broken":'); };
    await frame();
    expect(reply.error!.code).toBe("malformed");
    const off = onRequest("known", () => ({})); // the applet listens, so its pump runs
    const asked = fake.daemonRequest({ t: "anything" });
    fake.ops.poll = () => { const raw = real(); return raw === undefined ? raw : raw.replace(/"m":.*$/, '"m":{oops}'); };
    await frame(2);
    expect(fake.replies.at(-1)).toMatchObject({ id: asked, error: true });
    expect(JSON.parse(fake.replies.at(-1)!.json).code).toBe("malformed");
    fake.ops.poll = real;
    off();
    await frame(2);
  });

  test("a host that refuses a stale handle itself (code -8) is reported as closed", async () => {
    const stream = emitStream("log", {})!;
    fake.ops.write = () => -8;
    const write = outcome(stream.write(bytes("x")));
    await frame();
    expect(write.error!.code).toBe("closed");
  });
});
