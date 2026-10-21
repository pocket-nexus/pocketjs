// PocketJS net spec — the boundary of the NET module (`globalThis.net`).
//
// This module deliberately exposes one bounded HTTP client primitive, not a
// browser networking stack. The public SDK is `fetch()`; the native boundary
// below stays smaller so embedded transports (ESP-IDF, ureq, platform HTTP)
// can implement it without reproducing WHATWG Request/Response/Streams.
//
// The four parts of the boundary:
//
//   ops            guest -> core intent (numeric codes below, append-only)
//   events         core -> guest facts (one JSON batch per tick)
//   data contract  request metadata JSON + borrowed request body + taken body
//   frame contract transport never enters QuickJS; completions become visible
//                  only at a host tick boundary and Promise reactions run in
//                  that guest turn's normal microtask drain
//
// Ownership:
//   start() BORROWS the request ArrayBuffer for the synchronous call. The host
//   copies it before returning. take() BORROWS an exactly-sized destination,
//   copies one completed response body into it, and succeeds at most once.
//
// If you change ANY value here: run `bun contracts/spec/gen-rust.ts`, commit
// the regenerated engine/spec/src/lib.rs (tests/contract.ts byte-compares).

// ---------------------------------------------------------------------------
// Net ops (the `net.*` native contract)
// ---------------------------------------------------------------------------
//
// Signatures (authoritative; hosts marshal them however they like):
//   start(metaJson:string, body:ArrayBuffer) -> handle | -1
//      metaJson = {url, method, headers, timeoutMs, maxBytes}
//      The request is accepted or refused synchronously. Read lastError() on
//      -1. A successful request completes asynchronously through poll().
//   take(handle, into:ArrayBuffer) -> bytesCopied | -1
//      Copy the completed response body exactly once. `into.byteLength` must
//      equal the `bytes` field of the handle's done event.
//   cancel(handle)
//      Best-effort transport cancellation and unconditional core cleanup.
//   poll() -> string | undefined
//      Drain the ENTIRE event batch visible at this tick as one JSON array.
//      The SDK calls this once per tick only while requests are pending.
//   lastError() -> string
//      Portable `code: message` for the most recent synchronous refusal.

export const NET_OP = {
  start: 1,
  take: 2,
  cancel: 3,
  poll: 4,
  lastError: 5,
} as const;

// ---------------------------------------------------------------------------
// Events (core -> guest facts; all events for a tick in one JSON array)
// ---------------------------------------------------------------------------
//
//   {"t":"done","h":n,"status":200,"url":"https://…","headers":{…},"bytes":5}
//   {"t":"error","h":n,"code":"timeout","message":"…"}
//
// A done event guarantees take(h, exactlySizedBuffer) is available. An error
// event guarantees no response body remains. Every accepted handle produces
// at most one terminal event unless the guest cancels it first.

export const NET_EVENT = {
  done: "done",
  error: "error",
} as const;

/** Common application HTTP methods. CONNECT and TRACE are intentionally not
 * client-app operations; custom methods are outside the portable v1 surface. */
export const NET_METHODS = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
] as const;

export type NetMethod = (typeof NET_METHODS)[number];

// ---------------------------------------------------------------------------
// Bounded whole-response contract
// ---------------------------------------------------------------------------

/** Two concurrent requests cover the common app pattern while bounding
 * transport state, TLS buffers and completed bodies on small hosts. */
export const NET_MAX_INFLIGHT = 2;

/** Request bodies are copied out of the guest during start(). */
export const NET_MAX_REQUEST_BYTES = 64 * 1024;

/** Default and absolute response-body limits. Transports should stop reading
 * as soon as the selected limit is exceeded; the core checks again before a
 * body becomes visible to the guest. */
export const NET_DEFAULT_RESPONSE_BYTES = 128 * 1024;
export const NET_MAX_RESPONSE_BYTES = 256 * 1024;

export const NET_MAX_HEADERS = 32;
export const NET_MAX_HEADER_BYTES = 8 * 1024;
export const NET_DEFAULT_TIMEOUT_MS = 30_000;
export const NET_MAX_TIMEOUT_MS = 120_000;
export const NET_MAX_REDIRECTS = 3;

/** Portable errors. A transport maps platform/library failures into these
 * codes before crossing the module boundary. */
export const NET_ERROR = {
  unavailable: "unavailable",
  invalidRequest: "invalid_request",
  busy: "busy",
  dns: "dns",
  connect: "connect",
  tls: "tls",
  timeout: "timeout",
  redirect: "redirect",
  responseTooLarge: "response_too_large",
  protocol: "protocol",
  cancelled: "cancelled",
  other: "other",
} as const;

export type NetErrorCode = (typeof NET_ERROR)[keyof typeof NET_ERROR];
