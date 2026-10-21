// Deterministic virtual-clock NET module for conformance tests. It never uses
// ambient host networking: routes are fixtures, and completions become visible
// only after tick(), exactly like a native transport crossing a tick boundary.

import {
  NET_ERROR,
  NET_MAX_INFLIGHT,
  NET_MAX_RESPONSE_BYTES,
} from "../../contracts/spec/net.ts";
import { stringToUtf8 } from "../../framework/src/bytes.ts";
import type { NetOps } from "../../framework/src/net-api.ts";

export interface SimNetRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  readonly timeoutMs: number;
  readonly maxBytes: number;
}

export interface SimNetResponse {
  readonly status?: number;
  readonly url?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | Uint8Array;
  /** Virtual ticks after start before the completion is visible. Default 1. */
  readonly delayTicks?: number;
  readonly error?: { readonly code: string; readonly message: string };
}

export type SimNetRoute = SimNetResponse | ((request: SimNetRequest) => SimNetResponse);

interface PendingRequest {
  readonly handle: number;
  readonly readyTick: number;
  readonly request: SimNetRequest;
  readonly response: SimNetResponse;
}

export interface SimNetHost {
  readonly ns: NetOps;
  tick(): void;
  readonly log: string[];
  readonly pollCalls: () => number;
}

function bytes(value: string | Uint8Array | undefined): Uint8Array {
  if (value instanceof Uint8Array) return value.slice();
  return stringToUtf8(value ?? "");
}

export function createSimNetHost(routes: Readonly<Record<string, SimNetRoute>>): SimNetHost {
  const pending = new Map<number, PendingRequest>();
  const bodies = new Map<number, Uint8Array>();
  const visible: object[] = [];
  const log: string[] = [];
  let nextHandle = 1;
  let now = 0;
  let lastError = "";
  let polls = 0;

  const ns: NetOps = {
    start(metaJson: string, bodyBuffer: ArrayBuffer): number {
      let meta: Omit<SimNetRequest, "body">;
      try {
        meta = JSON.parse(metaJson) as typeof meta;
      } catch {
        lastError = `${NET_ERROR.invalidRequest}: malformed metadata`;
        return -1;
      }
      if (pending.size >= NET_MAX_INFLIGHT) {
        lastError = `${NET_ERROR.busy}: at most ${NET_MAX_INFLIGHT} requests may be in flight`;
        return -1;
      }
      const route = routes[meta.url];
      if (!route) {
        lastError = `${NET_ERROR.invalidRequest}: no deterministic route for ${meta.url}`;
        return -1;
      }
      const request: SimNetRequest = { ...meta, body: new Uint8Array(bodyBuffer).slice() };
      const response = typeof route === "function" ? route(request) : route;
      const handle = nextHandle++;
      const delay = Math.max(1, Math.floor(response.delayTicks ?? 1));
      pending.set(handle, { handle, request, response, readyTick: now + delay });
      log.push(`start ${handle} ${request.method} ${request.url} ${request.body.byteLength}`);
      return handle;
    },
    take(handle: number, into: ArrayBuffer): number {
      const body = bodies.get(handle);
      if (!body || into.byteLength !== body.byteLength) return -1;
      bodies.delete(handle);
      log.push(`take ${handle} ${body.byteLength}`);
      new Uint8Array(into).set(body);
      return body.byteLength;
    },
    cancel(handle: number): void {
      pending.delete(handle);
      bodies.delete(handle);
      for (let i = visible.length - 1; i >= 0; i--) {
        if ((visible[i] as { h?: number }).h === handle) visible.splice(i, 1);
      }
      log.push(`cancel ${handle}`);
    },
    poll(): string | undefined {
      polls++;
      if (visible.length === 0) return undefined;
      const batch = JSON.stringify(visible.splice(0));
      log.push(`poll ${batch}`);
      return batch;
    },
    lastError(): string {
      return lastError;
    },
  };

  return {
    ns,
    tick(): void {
      now++;
      for (const [handle, item] of [...pending]) {
        if (item.readyTick > now) continue;
        pending.delete(handle);
        const response = item.response;
        if (response.error) {
          visible.push({
            t: "error",
            h: handle,
            code: response.error.code,
            message: response.error.message,
          });
          continue;
        }
        const body = bytes(response.body);
        const limit = Math.min(item.request.maxBytes, NET_MAX_RESPONSE_BYTES);
        if (body.byteLength > limit) {
          visible.push({
            t: "error",
            h: handle,
            code: NET_ERROR.responseTooLarge,
            message: `response exceeded ${limit} bytes`,
          });
          continue;
        }
        bodies.set(handle, body);
        visible.push({
          t: "done",
          h: handle,
          status: response.status ?? 200,
          url: response.url ?? item.request.url,
          headers: response.headers ?? {},
          bytes: body.byteLength,
        });
      }
    },
    log,
    pollCalls: () => polls,
  };
}
