// Browser dev host for the PocketJS NET module. Browser fetch is the physical
// transport; this adapter supplies the bounded contract and tick batching from
// contracts/spec/net.ts without exposing browser globals as the guest API.

const MAX_INFLIGHT = 2;
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_HEADERS = 32;
const MAX_HEADER_BYTES = 8 * 1024;
const MAX_TIMEOUT_MS = 120_000;
const MAX_REDIRECTS = 3;
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

function headerBytes(headers) {
  let bytes = 0;
  const encoder = new TextEncoder();
  for (const [name, value] of Object.entries(headers)) {
    bytes += name.length + encoder.encode(value).byteLength + 4;
  }
  return bytes;
}

function validHeaders(headers) {
  const entries = Object.entries(headers);
  return entries.length <= MAX_HEADERS &&
    headerBytes(headers) <= MAX_HEADER_BYTES &&
    entries.every(([name, value]) =>
      typeof value === "string" &&
      /^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name) &&
      !/[\r\n]/.test(value),
    );
}

function failure(error, timedOut) {
  if (timedOut) return { code: "timeout", message: "request timed out" };
  const message = error instanceof Error ? error.message : String(error);
  return { code: "connect", message };
}

async function readBounded(response, maxBytes) {
  if (!response.body) {
    const body = new Uint8Array(await response.arrayBuffer());
    if (body.byteLength > maxBytes) throw new Error("response_too_large");
    return body;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error("response_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function followBounded(nativeFetch, request, signal) {
  let url = request.url;
  let method = request.method;
  let body = request.body.byteLength ? request.body : undefined;
  for (let redirects = 0; ; redirects++) {
    const response = await nativeFetch(url, {
      method,
      headers: request.headers,
      body: method === "GET" || method === "HEAD" ? undefined : body,
      credentials: "omit",
      cache: "no-store",
      redirect: "manual",
      signal,
    });
    if (response.type === "opaqueredirect") throw new Error("redirect_opaque");
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    await response.body?.cancel();
    if (redirects >= MAX_REDIRECTS) throw new Error("redirect_limit");
    const location = response.headers.get("location");
    if (!location) throw new Error("redirect_location");
    url = new URL(location, url).href;
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
      method = "GET";
      body = undefined;
    }
  }
}

export function createNetHost(nativeFetch = globalThis.fetch.bind(globalThis)) {
  let nextHandle = 1;
  let lastError = "";
  const pending = new Map(); // handle -> AbortController
  const bodies = new Map(); // handle -> Uint8Array
  const completed = []; // async transport facts, not guest-visible yet
  const visible = []; // facts frozen at beginFrame()

  function refuse(code, message) {
    lastError = `${code}: ${message}`;
    return -1;
  }

  const ns = {
    start(metaJson, bodyBuffer) {
      let meta;
      try {
        meta = JSON.parse(metaJson);
      } catch {
        return refuse("invalid_request", "malformed request metadata");
      }
      if (!meta || typeof meta !== "object" || !(bodyBuffer instanceof ArrayBuffer)) {
        return refuse("invalid_request", "malformed request metadata or body");
      }
      const body = new Uint8Array(bodyBuffer).slice();
      if (pending.size >= MAX_INFLIGHT) return refuse("busy", "at most 2 requests may be in flight");
      if (typeof meta.url !== "string" || !/^https?:\/\/[^\s/]+(?:\/|$)/.test(meta.url)) {
        return refuse("invalid_request", "url must be absolute HTTP(S)");
      }
      if (!METHODS.has(meta.method)) return refuse("invalid_request", "unsupported method");
      if ((meta.method === "GET" || meta.method === "HEAD") && body.byteLength) {
        return refuse("invalid_request", `${meta.method} cannot have a body`);
      }
      if (body.byteLength > MAX_REQUEST_BYTES) return refuse("invalid_request", "request body too large");
      if (!Number.isInteger(meta.timeoutMs) || meta.timeoutMs < 1 || meta.timeoutMs > MAX_TIMEOUT_MS) {
        return refuse("invalid_request", "invalid timeoutMs");
      }
      if (!Number.isInteger(meta.maxBytes) || meta.maxBytes < 1 || meta.maxBytes > MAX_RESPONSE_BYTES) {
        return refuse("invalid_request", "invalid maxBytes");
      }
      if (!meta.headers || typeof meta.headers !== "object" || !validHeaders(meta.headers)) {
        return refuse("invalid_request", "invalid headers");
      }

      const handle = nextHandle++;
      const controller = new AbortController();
      pending.set(handle, controller);
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, meta.timeoutMs);
      const request = { ...meta, body };
      void followBounded(nativeFetch, request, controller.signal)
        .then(async (response) => {
          const headers = Object.create(null);
          response.headers.forEach((value, name) => {
            headers[name.toLowerCase()] = value;
          });
          if (!validHeaders(headers)) throw new Error("response_headers");
          const responseBody = await readBounded(response, meta.maxBytes);
          if (!pending.has(handle)) return;
          bodies.set(handle, responseBody);
          completed.push({
            t: "done",
            h: handle,
            status: response.status,
            url: response.url || meta.url,
            headers,
            bytes: responseBody.byteLength,
          });
        })
        .catch((error) => {
          if (!pending.has(handle)) return;
          const message = error instanceof Error ? error.message : String(error);
          const mapped = message === "response_too_large"
            ? { code: "response_too_large", message: `response exceeded ${meta.maxBytes} bytes` }
            : message.startsWith("redirect_")
              ? { code: "redirect", message }
              : message === "response_headers"
                ? { code: "protocol", message: "response headers exceed limits" }
                : failure(error, timedOut);
          completed.push({ t: "error", h: handle, ...mapped });
        })
        .finally(() => {
          clearTimeout(timer);
          pending.delete(handle);
        });
      return handle;
    },
    take(handle, into) {
      const body = bodies.get(handle);
      if (!body || into.byteLength !== body.byteLength) return -1;
      new Uint8Array(into).set(body);
      bodies.delete(handle);
      return body.byteLength;
    },
    cancel(handle) {
      pending.get(handle)?.abort();
      pending.delete(handle);
      bodies.delete(handle);
      for (let i = completed.length - 1; i >= 0; i--) if (completed[i].h === handle) completed.splice(i, 1);
      for (let i = visible.length - 1; i >= 0; i--) if (visible[i].h === handle) visible.splice(i, 1);
    },
    poll() {
      return visible.length ? JSON.stringify(visible.splice(0)) : undefined;
    },
    lastError() {
      return lastError;
    },
  };

  return {
    ns,
    beginFrame() {
      visible.push(...completed.splice(0));
    },
    reset() {
      for (const handle of [...pending.keys()]) ns.cancel(handle);
      bodies.clear();
      completed.length = 0;
      visible.length = 0;
    },
  };
}
