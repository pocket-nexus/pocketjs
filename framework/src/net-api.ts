// PocketJS net SDK — a deliberately small, bounded fetch over globalThis.net.
// The native contract lives in contracts/spec/net.ts. This file is framework
// neutral and serves ./net, ./vue-vapor/net and ./octane/net.

import {
  NET_DEFAULT_RESPONSE_BYTES,
  NET_DEFAULT_TIMEOUT_MS,
  NET_ERROR,
  NET_MAX_HEADER_BYTES,
  NET_MAX_HEADERS,
  NET_MAX_REQUEST_BYTES,
  NET_MAX_RESPONSE_BYTES,
  NET_MAX_TIMEOUT_MS,
  NET_METHODS,
  type NetErrorCode,
  type NetMethod,
} from "../../contracts/spec/net.ts";
import { stringToUtf8, utf8ToString } from "./bytes.ts";
import { registerServicePump } from "./services.ts";

export {
  NET_DEFAULT_RESPONSE_BYTES,
  NET_DEFAULT_TIMEOUT_MS,
  NET_MAX_REQUEST_BYTES,
  NET_MAX_RESPONSE_BYTES,
  NET_MAX_TIMEOUT_MS,
  NET_METHODS,
};
export type { NetErrorCode, NetMethod };

export interface NetOps {
  /** Request body is borrowed for this synchronous call. */
  start(metaJson: string, body: ArrayBuffer): number;
  /** Copy a completed body into an exactly-sized buffer, exactly once. */
  take(handle: number, into: ArrayBuffer): number;
  cancel(handle: number): void;
  /** One JSON array containing the entire event batch visible this tick. */
  poll(): string | undefined;
  lastError(): string;
}

export interface FetchOptions {
  method?: NetMethod;
  headers?: Readonly<Record<string, string>>;
  body?: string | Uint8Array | ArrayBuffer;
  /** 1..120000; defaults to 30000. Enforced by the native transport. */
  timeoutMs?: number;
  /** Whole response-body cap; defaults to 128 KiB, absolute max 256 KiB. */
  maxBytes?: number;
}

export class NetError extends Error {
  readonly code: NetErrorCode;

  constructor(code: NetErrorCode, message: string) {
    super(message);
    this.name = "NetError";
    this.code = code;
  }
}

export class PocketResponse {
  readonly status: number;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly ok: boolean;
  private readonly data: Uint8Array;

  constructor(
    status: number,
    url: string,
    headers: Readonly<Record<string, string>>,
    body: ArrayBuffer,
  ) {
    this.status = status;
    this.url = url;
    this.headers = Object.freeze({ ...headers });
    this.ok = status >= 200 && status < 300;
    this.data = new Uint8Array(body);
  }

  get byteLength(): number {
    return this.data.byteLength;
  }

  /** A copy, so response reads cannot mutate the body retained by this value. */
  async bytes(): Promise<Uint8Array> {
    return this.data.slice();
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    return this.data.slice().buffer as ArrayBuffer;
  }

  async text(): Promise<string> {
    try {
      return utf8ToString(this.data);
    } catch {
      throw new Error("net: response is not valid UTF-8");
    }
  }

  async json<T = unknown>(): Promise<T> {
    return JSON.parse(await this.text()) as T;
  }
}

interface DoneEvent {
  t: "done";
  h: number;
  status: number;
  url: string;
  headers: Record<string, string>;
  bytes: number;
}

interface ErrorEvent {
  t: "error";
  h: number;
  code: NetErrorCode;
  message: string;
}

type NetEvent = DoneEvent | ErrorEvent;

interface Pending {
  readonly ops: NetOps;
  readonly resolve: (status:number, url:string, headers:Record<string,string>, body:ArrayBuffer) => void;
  readonly reject: (error: NetError) => void;
}

const pending = new Map<number, Pending>();
let stopPump: (() => void) | null = null;
let activeOps: NetOps | null = null;

export function netHost(): NetOps | null {
  const ns = (globalThis as { net?: unknown }).net;
  if (!ns || typeof ns !== "object") return null;
  const ops = ns as Partial<NetOps>;
  return typeof ops.start === "function" &&
      typeof ops.take === "function" &&
      typeof ops.cancel === "function" &&
      typeof ops.poll === "function" &&
      typeof ops.lastError === "function"
    ? (ops as NetOps)
    : null;
}

function errorCode(value: unknown): NetErrorCode {
  const code = String(value);
  for (const known of Object.values(NET_ERROR)) {
    if (known === code) return known;
  }
  return NET_ERROR.other;
}

function settle(ev: NetEvent): void {
  const p = pending.get(ev.h);
  if (!p) return;
  pending.delete(ev.h);
  if (ev.t === "error") {
    p.reject(new NetError(errorCode(ev.code), String(ev.message || ev.code)));
  } else {
    if (
      !Number.isInteger(ev.status) ||
      ev.status < 100 ||
      ev.status > 599 ||
      typeof ev.url !== "string" ||
      typeof ev.headers !== "object" ||
      ev.headers === null ||
      !Number.isInteger(ev.bytes) ||
      ev.bytes < 0 ||
      ev.bytes > NET_MAX_RESPONSE_BYTES
    ) {
      p.ops.cancel(ev.h);
      p.reject(new NetError(NET_ERROR.protocol, "net: malformed done event"));
    } else {
      const body = new ArrayBuffer(ev.bytes);
      const copied = p.ops.take(ev.h, body);
      if (copied !== ev.bytes) {
        p.ops.cancel(ev.h);
        p.reject(new NetError(NET_ERROR.protocol, "net: response body transfer failed"));
      } else {
        p.resolve(ev.status, ev.url, ev.headers, body);
      }
    }
  }
  if (pending.size === 0 && stopPump) {
    stopPump();
    stopPump = null;
    activeOps = null;
  }
}

/** Internal module service hook. It performs exactly one native poll call and
 * only exists in the frame pump while at least one fetch is pending. */
export function __pumpNet(): void {
  if (pending.size === 0) return;
  const ops = activeOps;
  if (!ops) return;
  const batch = ops.poll();
  if (batch !== undefined) {
    let events: unknown = null;
    try {
      events = JSON.parse(batch);
    } catch {
      // handled as a protocol failure below
    }
    if (!Array.isArray(events)) {
      for (const [handle, p] of pending) {
        ops.cancel(handle);
        pending.delete(handle);
        p.reject(new NetError(NET_ERROR.protocol, "net: malformed event batch"));
      }
    } else {
      for (const event of events) {
        if (!event || typeof event !== "object") continue;
        const ev = event as Partial<NetEvent>;
        if (!Number.isInteger(ev.h) || (ev.t !== "done" && ev.t !== "error")) continue;
        settle(ev as NetEvent);
      }
    }
  }
  if (pending.size === 0 && stopPump) {
    stopPump();
    stopPump = null;
    activeOps = null;
  }
}

function integerInRange(value: number, min: number, max: number, label: string): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new NetError(NET_ERROR.invalidRequest, `net: ${label} must be ${min}..${max}`);
  }
  return value;
}

function normalizeHeaders(input: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const out = Object.create(null) as Record<string, string>;
  let count = 0;
  let bytes = 0;
  for (const rawName of Object.keys(input ?? {})) {
    const name = rawName.toLowerCase();
    const value = String(input![rawName]);
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name) || /[\r\n]/.test(value)) {
      throw new NetError(NET_ERROR.invalidRequest, `net: invalid header ${rawName}`);
    }
    count++;
    bytes += stringToUtf8(name).byteLength + stringToUtf8(value).byteLength + 4;
    if (count > NET_MAX_HEADERS || bytes > NET_MAX_HEADER_BYTES) {
      throw new NetError(NET_ERROR.invalidRequest, "net: request headers exceed limits");
    }
    out[name] = value;
  }
  return out;
}

function requestBody(body: FetchOptions["body"]): Uint8Array {
  if (body === undefined) return new Uint8Array(0);
  if (typeof body === "string") return stringToUtf8(body);
  if (body instanceof Uint8Array) return body.slice();
  if (body instanceof ArrayBuffer) return new Uint8Array(body.slice(0));
  throw new NetError(NET_ERROR.invalidRequest, "net: body must be string or bytes");
}

/** The PocketJS HTTP client. It is fetch-shaped but intentionally not the
 * complete browser Fetch API: no streams, cookies, cache, Request, Signal or
 * implicit ambient authority. */
export function fetch(url: string, options: FetchOptions = {}): Promise<PocketResponse> {
  return new Promise((resolve,reject) => {
    __requestNet(url,options,(status,url,headers,body)=>resolve(new PocketResponse(status,url,headers,body)),reject);
  });
}

/** Internal callback transport: completion runs inside the existing service pump.
 * Model awaitables enqueue their typed result before the same boundary's resume phase. */
export function __requestNet(url:string, options:FetchOptions,
  complete:(status:number,url:string,headers:Record<string,string>,body:ArrayBuffer)=>void,
  failure:(error:NetError)=>void):()=>void {
  const idle=()=>{if(pending.size===0&&stopPump){stopPump();stopPump=null;activeOps=null;}};
  const refuse=(error:NetError)=>{failure(error);return ()=>{};};
  const ops = netHost();
  if (!ops) return refuse(new NetError(NET_ERROR.unavailable, "net: host did not mount the net module"));

  try {
    if (typeof url !== "string" || !/^https?:\/\/[^\s/]+(?:\/|$)/.test(url)) {
      throw new NetError(NET_ERROR.invalidRequest, "net: url must be absolute http:// or https://");
    }
    const method = options.method ?? "GET";
    if (!(NET_METHODS as readonly string[]).includes(method)) {
      throw new NetError(NET_ERROR.invalidRequest, `net: unsupported method ${String(method)}`);
    }
    const body = requestBody(options.body);
    if ((method === "GET" || method === "HEAD") && body.byteLength > 0) {
      throw new NetError(NET_ERROR.invalidRequest, `net: ${method} cannot have a body`);
    }
    if (body.byteLength > NET_MAX_REQUEST_BYTES) {
      throw new NetError(NET_ERROR.invalidRequest, "net: request body exceeds 64 KiB");
    }
    const timeoutMs = integerInRange(
      options.timeoutMs ?? NET_DEFAULT_TIMEOUT_MS,
      1,
      NET_MAX_TIMEOUT_MS,
      "timeoutMs",
    );
    const maxBytes = integerInRange(
      options.maxBytes ?? NET_DEFAULT_RESPONSE_BYTES,
      1,
      NET_MAX_RESPONSE_BYTES,
      "maxBytes",
    );
    const meta = JSON.stringify({
      url,
      method,
      headers: normalizeHeaders(options.headers),
      timeoutMs,
      maxBytes,
    });
    if (activeOps && activeOps !== ops) {
      throw new NetError(NET_ERROR.unavailable, "net: mounted host changed while requests are pending");
    }
    const handle = ops.start(meta, body.buffer as ArrayBuffer);
    if (!Number.isInteger(handle) || handle < 0) {
      const detail = ops.lastError() || "unavailable: request refused";
      const split = detail.indexOf(":");
      const code = errorCode(split < 0 ? NET_ERROR.other : detail.slice(0, split));
      const message = split < 0 ? detail : detail.slice(split + 1).trim();
      return refuse(new NetError(code, message));
    }
    const request:Pending={ops,resolve:complete,reject:failure};
    pending.set(handle,request);
    activeOps=ops;
    if(!stopPump)stopPump=registerServicePump(__pumpNet);
    return ()=>{
      if(pending.get(handle)!==request)return;
      pending.delete(handle);ops.cancel(handle);idle();
    };
  } catch (error) {
    return refuse(error instanceof NetError?error:new NetError(NET_ERROR.invalidRequest,String(error)));
  }
}
