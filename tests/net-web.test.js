import { expect, test } from "bun:test";

import { fetch as pocketFetch } from "../framework/src/net-api.ts";
import { runServicePumps } from "../framework/src/services.ts";
import { createNetHost } from "../platforms/web/net.js";

test("browser net adapter uses native fetch but delivers only at beginFrame", async () => {
  const calls = [];
  const host = createNetHost(async (url, options) => {
    calls.push({ url, options });
    return new Response("web transport", {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  });
  globalThis.net = host.ns;
  try {
    let settled = false;
    const promise = pocketFetch("https://example.test/web", {
      headers: { "x-test": "1" },
      maxBytes: 64,
    }).then((response) => {
      settled = true;
      return response;
    });
    await Bun.sleep(0);
    runServicePumps();
    await Promise.resolve();
    expect(settled).toBe(false);

    host.beginFrame();
    runServicePumps();
    const response = await promise;
    expect(await response.text()).toBe("web transport");
    expect(calls).toHaveLength(1);
    expect(calls[0].options.credentials).toBe("omit");
    expect(calls[0].options.redirect).toBe("manual");
  } finally {
    host.reset();
    delete globalThis.net;
  }
});

test("browser net adapter enforces response maxBytes while reading", async () => {
  const host = createNetHost(async () => new Response("12345"));
  globalThis.net = host.ns;
  try {
    const promise = pocketFetch("https://example.test/large", { maxBytes: 4 });
    await Bun.sleep(0);
    host.beginFrame();
    runServicePumps();
    await expect(promise).rejects.toMatchObject({ code: "response_too_large" });
  } finally {
    host.reset();
    delete globalThis.net;
  }
});
