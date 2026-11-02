import { expect, test } from "bun:test";
import { createNetHost } from "../platforms/web/net.js";

function start(host, url, maxBytes, headers = {}) {
  const handle = host.ns.start(JSON.stringify({
    url, method: "GET", headers, maxBytes, timeoutMs: 1_000,
  }), new ArrayBuffer(0));
  expect(handle).toBeGreaterThan(0);
  return handle;
}

test("browser net adapter uses native fetch but delivers only at beginFrame", async () => {
  const calls = [];
  const host = createNetHost(async (url, options) => {
    calls.push({ url, options });
    return new Response("web transport", {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  });
  try {
    const handle = start(host, "https://example.test/web", 64, { "x-test": "1" });
    await Bun.sleep(0);
    expect(host.ns.poll()).toBeUndefined();

    host.beginFrame();
    const [response] = JSON.parse(host.ns.poll());
    expect(response).toMatchObject({ t: "done", h: handle, status: 200 });
    const body = new ArrayBuffer(response.bytes);
    expect(host.ns.take(handle, body)).toBe(response.bytes);
    expect(new TextDecoder().decode(body)).toBe("web transport");
    expect(host.ns.poll()).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0].options.credentials).toBe("omit");
    expect(calls[0].options.redirect).toBe("manual");
  } finally {
    host.reset();
  }
});

test("browser net adapter enforces response maxBytes while reading", async () => {
  const host = createNetHost(async () => new Response("12345"));
  try {
    const handle = start(host, "https://example.test/large", 4);
    await Bun.sleep(0);
    expect(host.ns.poll()).toBeUndefined();
    host.beginFrame();
    expect(JSON.parse(host.ns.poll())).toEqual([
      { t: "error", h: handle, code: "response_too_large", message: "response exceeded 4 bytes" },
    ]);
    expect(host.ns.take(handle, new ArrayBuffer(5))).toBe(-1);
  } finally {
    host.reset();
  }
});
