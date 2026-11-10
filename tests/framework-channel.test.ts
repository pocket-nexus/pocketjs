// @pocketjs/framework/channel against a scripted host (globalThis.link.channel):
// what the applet's calls do when the channel under them closes.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ChannelError, channelState, request } from "../framework/src/channel.ts";
import { runServicePumps } from "../framework/src/services.ts";

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
