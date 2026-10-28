// PocketJS net contract — the HTTP policy a companion applies to requests it
// performs for a console. The Pocket Link `net.stream` protocol
// (contracts/spec/link.ts) carries a worker's HTTP resource (`io.http` in
// @pocketjs/framework/io, engine/worker) under this policy; the companion's
// own services answer the same requests. No UI realm has a network namespace.
//
// tools/companion/fetch.ts applies these limits; engine/host-services/link_http.c
// repeats the descriptor bounds it admits before a request leaves the console.

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
// Bounded request and response contract
// ---------------------------------------------------------------------------

/** Request bodies are copied out of the requester before the request starts. */
export const NET_MAX_REQUEST_BYTES = 64 * 1024;

/** Default and absolute response-body limits. Transports stop reading as
 * soon as the selected limit is exceeded. */
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
