// tests/companion-services.test.ts — the companion's service host
// (tools/companion/services.ts): an app reaches only the services its
// manifest declares, and a service answers within the request's timeoutMs
// and maxBytes as a fetched URL does.

import { afterAll, describe, expect, test } from "bun:test";
import { NET_ERROR } from "../contracts/spec/net.ts";
import { NetFailure } from "../tools/companion/fetch.ts";
import { bytesResponse, SERVICE_FACTORIES, ServiceHost, type ServiceProvider } from "../tools/companion/services.ts";
import { serviceContext, TEST_CONSOLE } from "./helpers/companion-service.ts";

const logs: string[] = [];
const host = new ServiceHost(serviceContext("/nonexistent", (line) => logs.push(line)));

/** A test service: /bytes?n= answers n bytes, /hang never answers. */
SERVICE_FACTORIES.probe = (): ServiceProvider => ({
  name: "probe",
  async handle(request) {
    if (request.path === "/hang") return await new Promise(() => {});
    return bytesResponse(new Uint8Array(Number(request.query.get("n") ?? 0)), "application/octet-stream");
  },
});

afterAll(() => {
  host.close();
  delete SERVICE_FACTORIES.probe;
});

const call = (path: string, services: readonly string[], options: { timeoutMs?: number; maxBytes?: number; signal?: AbortSignal } = {}) =>
  host.handle(
    { url: `https://companion.pocket/probe${path}`, method: "GET", body: new Uint8Array(), timeoutMs: options.timeoutMs ?? 5_000, maxBytes: options.maxBytes ?? 1_000 },
    TEST_CONSOLE,
    { app: "dev.pocket-nexus.probe", services },
    options.signal ?? new AbortController().signal,
  );

describe("the service host", () => {
  test("another host is not a service", async () => {
    const response = await host.handle(
      { url: "https://example.com/probe", method: "GET", body: new Uint8Array(), timeoutMs: 5_000, maxBytes: 1_000 },
      TEST_CONSOLE,
      { app: "a", services: ["probe"] },
      new AbortController().signal,
    );
    expect(response).toBeNull();
  });

  test("an app that does not declare the service gets 403", async () => {
    const response = await call("/bytes?n=10", ["youtube"]);
    expect(response?.status).toBe(403);
    expect(JSON.parse(new TextDecoder().decode(response!.body)).error).toContain("dev.pocket-nexus.probe");
    expect(logs.at(-1)).toContain("refused dev.pocket-nexus.probe");
  });

  test("a declared service answers", async () => {
    const response = await call("/bytes?n=10", ["probe"]);
    expect(response?.status).toBe(200);
    expect(response?.body.length).toBe(10);
  });

  test("a response past maxBytes fails with response_too_large", async () => {
    const failure = await call("/bytes?n=1001", ["probe"]).catch((error) => error);
    expect(failure).toBeInstanceOf(NetFailure);
    expect(failure.code).toBe(NET_ERROR.responseTooLarge);
  });

  test("a service past timeoutMs fails with timeout", async () => {
    const failure = await call("/hang", ["probe"], { timeoutMs: 50 }).catch((error) => error);
    expect(failure).toBeInstanceOf(NetFailure);
    expect(failure.code).toBe(NET_ERROR.timeout);
  });

  test("a cancelled request fails with cancelled", async () => {
    const abort = new AbortController();
    const pending = call("/hang", ["probe"], { signal: abort.signal }).catch((error) => error);
    abort.abort();
    expect((await pending).code).toBe(NET_ERROR.cancelled);
  });
});

describe("the images service", () => {
  test("cuts a circle with a soft edge, opaque at the middle and clear at the corners", async () => {
    const { cutCircle } = await import("../tools/companion/services/images.ts");
    const rgba = new Uint8Array(32 * 32 * 4).fill(255);
    cutCircle(rgba, 32);
    expect(rgba[(16 * 32 + 16) * 4 + 3]).toBe(255);
    expect(rgba[3]).toBe(0);
  });
});
