// The companion services' test fixtures: a service context, the console a
// request comes from, a request builder, the call a ServiceHost makes, and
// the IMG entry header check. Shared by tests/companion-{services,youtube,x,
// glyphs,discord}.test.ts.

import { expect } from "bun:test";
import { serve, type ServiceConsole, type ServiceContext, type ServiceProvider, type ServiceRequest } from "../../tools/companion/services.ts";

export const TEST_CONSOLE: ServiceConsole = { name: "3DS", address: "127.0.0.1", localAddress: "127.0.0.1" };

export function serviceContext(storeDir = "/nonexistent", log: (line: string) => void = () => {}): ServiceContext {
  return { storeDir, log };
}

/** A request for `path`, a GET with no body unless `options` say otherwise. */
export function serviceRequest(
  path: string,
  options: { query?: string | Record<string, string>; method?: string; body?: string; maxBytes?: number; signal?: AbortSignal } = {},
): ServiceRequest {
  return {
    method: options.method ?? "GET",
    path,
    query: new URLSearchParams(options.query),
    body: new TextEncoder().encode(options.body ?? ""),
    maxBytes: options.maxBytes ?? 256 * 1024,
    console: TEST_CONSOLE,
    signal: options.signal ?? AbortSignal.timeout(10_000),
  };
}

/** `provider`'s answer to `path` as a ServiceHost gives it (a ServiceError
 *  as its JSON), with the body read as JSON. */
export async function call(provider: ServiceProvider, path: string, options: Parameters<typeof serviceRequest>[1] = {}) {
  const response = await serve(provider, serviceRequest(path, options));
  return { ...response, json: () => JSON.parse(new TextDecoder().decode(response.body)) };
}

/** Check an IMG entry's header and size (a 16-bit `psm`); its pixels'
 *  view, from the first one. */
export function expectImg(body: Uint8Array, width: number, height: number, psm: number): DataView {
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  expect([view.getUint16(0, true), view.getUint16(2, true), body[4]]).toEqual([width, height, psm]);
  expect(body.length).toBe(8 + width * height * 2);
  return new DataView(body.buffer, body.byteOffset + 8, body.byteLength - 8);
}
