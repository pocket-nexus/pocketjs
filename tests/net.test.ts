import { afterEach, describe, expect, test } from "bun:test";

import { NET_ERROR } from "../contracts/spec/net.ts";
import {
  fetch as pocketFetch,
  NetError,
  type NetOps,
} from "../framework/src/net-api.ts";
import { runServicePumps } from "../framework/src/services.ts";
import { createSimNetHost } from "../platforms/sim/net.ts";

function mount(ns: NetOps): void {
  (globalThis as { net?: NetOps }).net = ns;
}

afterEach(() => {
  delete (globalThis as { net?: NetOps }).net;
});

describe("net SDK + deterministic sim host", () => {
  test("fetch resolves only after a tick boundary and keeps polling lazy", async () => {
    const host = createSimNetHost({
      "https://example.test/message": {
        status: 200,
        headers: { "content-type": "application/json" },
        body: '{"message":"你好"}',
      },
    });
    mount(host.ns);

    runServicePumps();
    expect(host.pollCalls()).toBe(0); // no pending Promise: no native poll

    let settled = false;
    const promise = pocketFetch("https://example.test/message").then((response) => {
      settled = true;
      return response;
    });
    runServicePumps();
    await Promise.resolve();
    expect(settled).toBe(false); // transport has not crossed a tick boundary
    expect(host.pollCalls()).toBe(1);

    host.tick();
    runServicePumps();
    const response = await promise;
    expect(response.status).toBe(200);
    expect(response.ok).toBe(true);
    expect(response.headers["content-type"]).toBe("application/json");
    expect(await response.json<{ message: string }>()).toEqual({ message: "你好" });

    const pollsAfterSettle = host.pollCalls();
    runServicePumps();
    runServicePumps();
    expect(host.pollCalls()).toBe(pollsAfterSettle); // pump unregistered itself
  });

  test("one poll drains every completion visible in the tick", async () => {
    const host = createSimNetHost({
      "https://example.test/a": { body: "a" },
      "https://example.test/b": { body: "b" },
    });
    mount(host.ns);
    const a = pocketFetch("https://example.test/a");
    const b = pocketFetch("https://example.test/b");
    host.tick();
    runServicePumps();

    expect(host.pollCalls()).toBe(1);
    expect(await (await a).text()).toBe("a");
    expect(await (await b).text()).toBe("b");
    expect(host.log.filter((line) => line.startsWith("poll "))).toHaveLength(1);
  });

  test("request metadata and body cross as owned bounded data", async () => {
    const host = createSimNetHost({
      "https://example.test/items": (request) => {
        expect(request.method).toBe("POST");
        expect(request.headers).toEqual({ "content-type": "application/json", "x-id": "42" });
        expect(new TextDecoder().decode(request.body)).toBe('{"name":"pocket"}');
        expect(request.timeoutMs).toBe(2500);
        expect(request.maxBytes).toBe(1024);
        return { status: 201, body: "created" };
      },
    });
    mount(host.ns);
    const promise = pocketFetch("https://example.test/items", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-ID": "42" },
      body: '{"name":"pocket"}',
      timeoutMs: 2500,
      maxBytes: 1024,
    });
    host.tick();
    runServicePumps();
    const response = await promise;
    expect(response.status).toBe(201);
    expect(await response.text()).toBe("created");
    expect(await response.text()).toBe("created"); // buffered response can be reread
  });

  test("whole-response cap rejects before oversized data reaches guest", async () => {
    const host = createSimNetHost({
      "https://example.test/large": { body: new Uint8Array(5) },
    });
    mount(host.ns);
    const promise = pocketFetch("https://example.test/large", { maxBytes: 4 });
    host.tick();
    runServicePumps();
    await expect(promise).rejects.toMatchObject({ code: NET_ERROR.responseTooLarge });
    expect(host.log.some((line) => line.startsWith("take "))).toBe(false);
  });

  test("the third concurrent request is refused with busy", async () => {
    const host = createSimNetHost({
      "https://example.test/a": { body: "a", delayTicks: 2 },
      "https://example.test/b": { body: "b", delayTicks: 2 },
      "https://example.test/c": { body: "c", delayTicks: 2 },
    });
    mount(host.ns);
    const a = pocketFetch("https://example.test/a");
    const b = pocketFetch("https://example.test/b");
    await expect(pocketFetch("https://example.test/c")).rejects.toMatchObject({
      code: NET_ERROR.busy,
    });
    host.tick();
    host.tick();
    runServicePumps();
    await Promise.all([a, b]);
  });

  test("invalid portable requests fail without entering the host", async () => {
    const host = createSimNetHost({
      "https://example.test/a": { body: "unused" },
    });
    mount(host.ns);
    await expect(
      pocketFetch("https://example.test/a", { method: "GET", body: "no" }),
    ).rejects.toMatchObject({ code: NET_ERROR.invalidRequest });
    await expect(pocketFetch("file:///secret")).rejects.toBeInstanceOf(NetError);
    expect(host.log).toEqual([]);
  });

  test("an unmounted module rejects explicitly", async () => {
    delete (globalThis as { net?: NetOps }).net;
    await expect(pocketFetch("https://example.test/a")).rejects.toMatchObject({
      code: NET_ERROR.unavailable,
    });
  });
});
