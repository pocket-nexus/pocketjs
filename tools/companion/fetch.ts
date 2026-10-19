// The companion side of the NET module (contracts/spec/net.ts): one bounded
// whole-response HTTP request on behalf of a paired console.
//
// Every hop is checked before it is fetched: the host is resolved and the
// request is refused when any address is loopback, link-local, private, CGNAT,
// multicast or otherwise not globally routable — unless the owner started the
// companion with allowPrivate. Redirects are followed by hand (at most
// NET_MAX_REDIRECTS) so each hop passes the same check. The body is read until
// maxBytes and the request fails with response_too_large past it.
//
// Outbound requests honour HTTPS_PROXY / HTTP_PROXY / NO_PROXY (Bun's fetch
// reads them); `adoptSystemProxy()` fills them from macOS network settings
// when the environment has none, which is the case for a menu-bar app.

import { spawnSync } from "node:child_process";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import {
  NET_DEFAULT_RESPONSE_BYTES,
  NET_DEFAULT_TIMEOUT_MS,
  NET_ERROR,
  NET_MAX_HEADER_BYTES,
  NET_MAX_HEADERS,
  NET_MAX_REDIRECTS,
  NET_MAX_REQUEST_BYTES,
  NET_MAX_RESPONSE_BYTES,
  NET_MAX_TIMEOUT_MS,
  NET_METHODS,
  type NetErrorCode,
  type NetMethod,
} from "../../contracts/spec/net.ts";

export class NetFailure extends Error {
  constructor(readonly code: NetErrorCode, message: string) {
    super(message);
  }
}

export interface NetRequest {
  url: string;
  method: NetMethod;
  headers: Record<string, string>;
  timeoutMs: number;
  maxBytes: number;
  body: Uint8Array;
}

export interface NetResponse {
  status: number;
  url: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

export interface NetOptions {
  allowPrivate?: boolean;
  signal?: AbortSignal;
  /** Test seam: resolve a host name to its addresses. */
  resolve?: (host: string) => Promise<string[]>;
}

/** Validate and normalize a console's `net` ctrl message (minus the body). */
export function normalizeNetRequest(message: Record<string, unknown>): Omit<NetRequest, "body"> & { bytes: number } {
  const url = message.url;
  if (typeof url !== "string" || url.length > 8192) throw new NetFailure(NET_ERROR.invalidRequest, "url must be a string");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new NetFailure(NET_ERROR.invalidRequest, "url does not parse");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new NetFailure(NET_ERROR.invalidRequest, "only http and https URLs");
  }
  const method = (typeof message.method === "string" ? message.method : "GET").toUpperCase();
  if (!(NET_METHODS as readonly string[]).includes(method)) throw new NetFailure(NET_ERROR.invalidRequest, `method ${method} is not allowed`);
  const headers: Record<string, string> = {};
  const rawHeaders = message.headers ?? {};
  if (typeof rawHeaders !== "object" || rawHeaders === null || Array.isArray(rawHeaders)) {
    throw new NetFailure(NET_ERROR.invalidRequest, "headers must be an object");
  }
  let headerBytes = 0;
  for (const [name, value] of Object.entries(rawHeaders)) {
    if (typeof value !== "string" || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\r\n\0]/.test(value)) {
      throw new NetFailure(NET_ERROR.invalidRequest, `invalid header ${name}`);
    }
    headerBytes += name.length + value.length + 4;
    headers[name.toLowerCase()] = value;
  }
  if (Object.keys(headers).length > NET_MAX_HEADERS || headerBytes > NET_MAX_HEADER_BYTES) {
    throw new NetFailure(NET_ERROR.invalidRequest, "too many request headers");
  }
  const timeoutMs = message.timeoutMs === undefined ? NET_DEFAULT_TIMEOUT_MS : Number(message.timeoutMs);
  const maxBytes = message.maxBytes === undefined ? NET_DEFAULT_RESPONSE_BYTES : Number(message.maxBytes);
  const bytes = message.bytes === undefined ? 0 : Number(message.bytes);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > NET_MAX_TIMEOUT_MS) {
    throw new NetFailure(NET_ERROR.invalidRequest, `timeoutMs must be 1..${NET_MAX_TIMEOUT_MS}`);
  }
  if (!Number.isInteger(maxBytes) || maxBytes < 0 || maxBytes > NET_MAX_RESPONSE_BYTES) {
    throw new NetFailure(NET_ERROR.invalidRequest, `maxBytes must be 0..${NET_MAX_RESPONSE_BYTES}`);
  }
  if (!Number.isInteger(bytes) || bytes < 0 || bytes > NET_MAX_REQUEST_BYTES) {
    throw new NetFailure(NET_ERROR.invalidRequest, `request body must be 0..${NET_MAX_REQUEST_BYTES} bytes`);
  }
  if (bytes > 0 && (method === "GET" || method === "HEAD")) {
    throw new NetFailure(NET_ERROR.invalidRequest, `${method} carries no body`);
  }
  return { url: parsed.href, method: method as NetMethod, headers, timeoutMs, maxBytes, bytes };
}

// ---------------------------------------------------------------------------
// Destination policy
// ---------------------------------------------------------------------------

function ipv4Value(address: string): number {
  return address.split(".").reduce((n, part) => n * 256 + Number(part), 0);
}

const V4_BLOCKED: [string, number][] = [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.168.0.0", 16], // private
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
];

function v4Blocked(address: string): boolean {
  const value = ipv4Value(address);
  return V4_BLOCKED.some(([base, bits]) => {
    const size = 2 ** (32 - bits);
    const start = ipv4Value(base);
    return value >= start && value < start + size;
  });
}

function expandV6(address: string): number[] | null {
  let text = address.toLowerCase().split("%")[0];
  const v4 = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const n = ipv4Value(v4[1]);
    text = `${text.slice(0, -v4[1].length)}${Math.floor(n / 65536).toString(16)}:${(n % 65536).toString(16)}`;
  }
  const [head, rest] = text.split("::");
  const parse = (part: string | undefined) => (part ? part.split(":").map((h) => (/^[0-9a-f]{1,4}$/.test(h) ? parseInt(h, 16) : -1)) : []);
  const a = parse(head);
  const b = parse(rest);
  if (rest === undefined && a.length !== 8) return null;
  const middle = rest === undefined ? [] : Array(Math.max(0, 8 - a.length - b.length)).fill(0);
  const groups = [...a, ...middle, ...b];
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

function v6Blocked(address: string): boolean {
  const g = expandV6(address);
  if (!g) return true;
  if (g.every((x) => x === 0)) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return v4Blocked(`${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`); // ::ffff:a.b.c.d
  }
  if ((g[0] & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((g[0] & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast ff00::/8
  if (g[0] === 0x0064 && g[1] === 0xff9b) return true; // NAT64 64:ff9b::/96 (maps to v4)
  return false;
}

/** True when an address is not a public unicast destination. */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return v4Blocked(address);
  if (family === 6) return v6Blocked(address);
  return true;
}

async function defaultResolve(host: string): Promise<string[]> {
  const found = await lookup(host, { all: true, verbatim: true });
  return found.map((entry) => entry.address);
}

async function checkDestination(url: URL, options: NetOptions) {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: string[];
  if (isIP(host)) addresses = [host];
  else {
    try {
      addresses = await (options.resolve ?? defaultResolve)(host);
    } catch (error) {
      throw new NetFailure(NET_ERROR.dns, `cannot resolve ${host}: ${(error as NodeJS.ErrnoException).code ?? error}`);
    }
    if (addresses.length === 0) throw new NetFailure(NET_ERROR.dns, `no address for ${host}`);
  }
  if (!options.allowPrivate) {
    const blocked = addresses.find(isPrivateAddress);
    if (blocked) {
      throw new NetFailure(NET_ERROR.invalidRequest, `${host} resolves to ${blocked}; the companion refuses local and private destinations`);
    }
  }
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const REQUEST_DROP = new Set([...HOP_BY_HOP, "host", "content-length", "expect"]);
/** Response headers kept first when a response carries more than the limit. */
const RESPONSE_PRIORITY = ["content-type", "location", "etag", "last-modified", "cache-control", "expires", "date", "retry-after"];

function responseHeaders(headers: Headers, decoded: boolean): Record<string, string> {
  const all: [string, string][] = [];
  headers.forEach((value, name) => {
    if (HOP_BY_HOP.has(name) || name === "set-cookie") return;
    // fetch() already decoded the body: the encoding and the wire length no longer describe it.
    if (decoded && (name === "content-encoding" || name === "content-length")) return;
    all.push([name, value]);
  });
  const cookies = headers.getSetCookie();
  if (cookies.length) all.push(["set-cookie", cookies.join("\n")]);
  all.sort((a, b) => rank(a[0]) - rank(b[0]));
  const out: Record<string, string> = {};
  let bytes = 0;
  let count = 0;
  for (const [name, value] of all) {
    const size = name.length + value.length + 4;
    if (count >= NET_MAX_HEADERS || bytes + size > NET_MAX_HEADER_BYTES) continue;
    out[name] = value;
    bytes += size;
    count++;
  }
  return out;
}

function rank(name: string): number {
  const index = RESPONSE_PRIORITY.indexOf(name);
  return index < 0 ? RESPONSE_PRIORITY.length : index;
}

function mapFetchError(error: unknown): NetFailure {
  if (error instanceof NetFailure) return error;
  const e = error as { code?: string; name?: string; message?: string };
  const text = `${e.code ?? ""} ${e.name ?? ""} ${e.message ?? ""}`;
  if (/TimeoutError|timed out|ETIMEDOUT/i.test(text)) return new NetFailure(NET_ERROR.timeout, "request timed out");
  if (/AbortError|aborted/i.test(text)) return new NetFailure(NET_ERROR.cancelled, "request cancelled");
  if (/CERT|SSL|TLS|certificate|handshake|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(text)) return new NetFailure(NET_ERROR.tls, e.message ?? "TLS failure");
  if (/ENOTFOUND|EAI_|DNS|getaddrinfo/i.test(text)) return new NetFailure(NET_ERROR.dns, e.message ?? "DNS failure");
  if (/ECONNREFUSED|ConnectionRefused|ECONNRESET|ConnectionClosed|EHOSTUNREACH|ENETUNREACH|FailedToOpenSocket|socket/i.test(text)) {
    return new NetFailure(NET_ERROR.connect, e.message ?? "connection failed");
  }
  if (/Malformed|protocol|HTTP|parse/i.test(text)) return new NetFailure(NET_ERROR.protocol, e.message ?? "protocol error");
  return new NetFailure(NET_ERROR.other, e.message ?? String(error));
}

export async function performNet(request: NetRequest, options: NetOptions = {}): Promise<NetResponse> {
  const timeout = AbortSignal.timeout(request.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const fail = (error: unknown): never => {
    if (timeout.aborted) throw new NetFailure(NET_ERROR.timeout, `no response within ${request.timeoutMs} ms`);
    if (options.signal?.aborted) throw new NetFailure(NET_ERROR.cancelled, "request cancelled");
    throw mapFetchError(error);
  };

  let url = new URL(request.url);
  let method: string = request.method;
  let body: Uint8Array | undefined = request.body.length ? request.body : undefined;
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (!REQUEST_DROP.has(name)) headers[name] = value;
  }
  headers["user-agent"] ??= "PocketLink/1";

  for (let hop = 0; ; hop++) {
    try {
      await checkDestination(url, options);
    } catch (error) {
      fail(error);
    }
    let response: Response;
    try {
      response = await fetch(url, { method, headers, body: body as BodyInit | undefined, redirect: "manual", signal });
    } catch (error) {
      return fail(error);
    }
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && response.status !== 304 && location) {
      await response.body?.cancel().catch(() => {});
      if (hop >= NET_MAX_REDIRECTS) throw new NetFailure(NET_ERROR.redirect, `more than ${NET_MAX_REDIRECTS} redirects`);
      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        throw new NetFailure(NET_ERROR.redirect, `bad redirect location ${location}`);
      }
      if (next.protocol !== "https:" && next.protocol !== "http:") throw new NetFailure(NET_ERROR.redirect, `redirect to ${next.protocol}`);
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
        if (method !== "HEAD") method = "GET";
        body = undefined;
        delete headers["content-type"];
      }
      if (next.origin !== url.origin) {
        delete headers.authorization;
        delete headers.cookie;
      }
      url = next;
      continue;
    }

    const decoded = response.headers.has("content-encoding");
    const declared = Number(response.headers.get("content-length"));
    if (!decoded && Number.isFinite(declared) && declared > request.maxBytes) {
      await response.body?.cancel().catch(() => {});
      throw new NetFailure(NET_ERROR.responseTooLarge, `response is ${declared} bytes, limit ${request.maxBytes}`);
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (method !== "HEAD" && response.body) {
      const reader = response.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.length;
          if (total > request.maxBytes) {
            await reader.cancel().catch(() => {});
            throw new NetFailure(NET_ERROR.responseTooLarge, `response exceeds ${request.maxBytes} bytes`);
          }
          chunks.push(value);
        }
      } catch (error) {
        fail(error);
      }
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const chunk of chunks) {
      out.set(chunk, off);
      off += chunk.length;
    }
    return { status: response.status, url: url.href, headers: responseHeaders(response.headers, decoded), body: out };
  }
}

// ---------------------------------------------------------------------------
// System proxy (macOS)
// ---------------------------------------------------------------------------

/** When no proxy variable is set, copy the macOS HTTP(S) proxy and its
 *  exception list into HTTPS_PROXY / HTTP_PROXY / NO_PROXY. Returns the proxy
 *  URL adopted, or "" when none. */
export function adoptSystemProxy(env: NodeJS.ProcessEnv = process.env): string {
  const names = ["https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY"];
  if (names.some((name) => env[name])) return env.https_proxy || env.HTTPS_PROXY || env.http_proxy || env.HTTP_PROXY || "";
  if (process.platform !== "darwin") return "";
  const result = spawnSync("scutil", ["--proxy"], { encoding: "utf8" });
  if (result.status !== 0) return "";
  const field = (key: string) => result.stdout.match(new RegExp(`\\b${key} : (\\S+)`))?.[1];
  const exceptions = [...result.stdout.matchAll(/^\s+\d+ : (\S+)$/gm)].map((m) => m[1]).filter((e) => !e.startsWith("<"));
  let adopted = "";
  if (field("HTTPSEnable") === "1" && field("HTTPSProxy")) {
    adopted = `http://${field("HTTPSProxy")}:${field("HTTPSPort") ?? "443"}`;
    env.HTTPS_PROXY = adopted;
  }
  if (field("HTTPEnable") === "1" && field("HTTPProxy")) {
    env.HTTP_PROXY = `http://${field("HTTPProxy")}:${field("HTTPPort") ?? "80"}`;
    adopted ||= env.HTTP_PROXY;
  }
  if (adopted) env.NO_PROXY = ["localhost", "127.0.0.1", "::1", ...exceptions].join(",");
  return adopted;
}
