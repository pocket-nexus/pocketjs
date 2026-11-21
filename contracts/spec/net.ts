// PocketJS net contract — the HTTP policy a host applies to a worker's HTTP
// resource (`io.http` in @pocketjs/framework/io, engine/worker), whether the
// host performs the request itself or a companion performs it for a console.
// No UI realm has a network namespace.
//
// platforms/linux/worker/src/http.rs and platforms/web/net.js apply these
// limits.

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
