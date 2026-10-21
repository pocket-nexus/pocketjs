# NET module

The NET module gives a guest one bounded HTTP client API:

```ts
import { fetch } from "@pocketjs/framework/net";

const response = await fetch("https://api.example.com/items", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: "Pocket" }),
  timeoutMs: 5_000,
  maxBytes: 64 * 1024,
});

if (!response.ok) throw new Error(`HTTP ${response.status}`);
const value = await response.json();
```

This is fetch-shaped, not the complete browser Fetch standard. V1 includes
`fetch`, common application methods, string/byte request bodies, headers,
timeouts, a response-size limit, and buffered `text()`, `json()`, `bytes()`
and `arrayBuffer()` reads. It does not include `Request`, `Headers`, streams,
cookies, cache, proxy configuration, `AbortSignal`, WebSocket, servers, or raw
sockets.

## Module ownership

| Layer | Upstream artifact | Owns |
| --- | --- | --- |
| SDK | `framework/src/net-api.ts` | `fetch`, `PocketResponse`, validation, lazy Promise delivery |
| Spec | `contracts/spec/net.ts` | five ops, two event shapes, buffer ownership, limits, portable errors, tick timing |
| Core | `engine/crates/pocket-net` | handles, request lifecycle, limits, event batches, completed bodies, transport interface |
| Deterministic host | `platforms/sim/net.ts` | fixture routes and virtual-tick completions for conformance tests |
| Browser host | `platforms/web/net.js` | browser `fetch` transport, bounded streaming read, redirects, tick staging |

The physical HTTP implementation belongs to the host that owns the network
resource. PocketJS does not choose one transport library for every runtime.
A desktop runtime can adapt `ureq`, an ESP runtime can adapt
`esp_http_client`, and an Apple host can adapt `URLSession`; none of those
libraries become part of the guest contract or the transport-neutral core.

A product runtime outside this repository keeps its adapter in that runtime's
repository. An adapter belongs under `hosts/<host>/` here only when PocketJS
itself owns and tests that host. The framework SDK, canonical spec, reference
core, and deterministic sim stay upstream because every host must agree on
them.

## Native transport boundary

`pocket-net` asks the host for only three operations:

```rust
pub trait HttpTransport {
    fn start(&mut self, request: HttpRequest) -> Result<(), NetFailure>;
    fn cancel(&mut self, handle: i32);
    fn drain(&mut self, completions: &mut Vec<TransportCompletion>);
}
```

`start` hands an owned request to a worker or native async facility and must
return promptly. `drain` is non-blocking and is called by the host once at a
tick boundary. Network threads never call QuickJS. The reference core turns
drained completions into one JSON event batch; the guest consumes that batch
during its next normal turn.

`NetSurface` — the one-line `globalThis.net` install on `pocket-mod` hosts —
is the crate's `mount` feature (default). A host with its own QuickJS wiring
depends with `default-features = false` and drives `NetCore` directly, so the
MCU build never compiles an engine it doesn't use (the `pocket-fs` pattern).

For a runtime using `NetSurface<T>`, the host loop is:

```text
transport threads work independently
        ↓
net.begin_tick()       drain completed transport work
        ↓
guest.frame(...)       framework service pump calls net.poll() if needed
        ↓
guest job drain        fetch Promise reactions run
```

There is no idle native polling. The framework service-pump set is normally
empty. The first pending `fetch` registers the NET pump; the final completion
removes it. While requests are pending there is one `poll()` FFI call per
guest tick, and that call drains the whole visible batch rather than one event
per crossing.

## Bounded whole responses

V1 resolves `fetch` only after the response body is complete. The transport
still reads incrementally and must stop as soon as `maxBytes` is exceeded;
the reference core checks the final size again before making it visible.
Consequently a slow or large response does not block the guest and cannot
grow without bound, but V1 is not suitable for media downloads or other
payloads that fundamentally require streaming.

| Limit | V1 value |
| --- | ---: |
| Concurrent requests | 2 |
| Request body | 64 KiB |
| Response body default | 128 KiB |
| Response body absolute maximum | 256 KiB |
| Headers | 32 fields / 8 KiB |
| Timeout | 30 s default / 120 s maximum |
| Redirects | 3 |

Two concurrent requests bound TLS buffers, worker state, and completed-body
memory while covering the usual foreground request plus asset/config request.
The response cap is selected per call so a small JSON endpoint can use a much
tighter budget than the global ceiling.

## Method set

V1 accepts `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE`, and `OPTIONS`.
These are the common application methods that portable embedded HTTP clients
can express. `CONNECT` creates a tunnel and `TRACE` has distinct security and
proxy semantics, so neither belongs in an app-level fetch module. Arbitrary
extension methods can be added later only when more than one real host needs
them; keeping a closed set today lets every target make the same promise.

## Body ownership

The request body is borrowed only for the synchronous `net.start` call and is
copied into host-owned memory before that call returns. A done event includes
the exact response byte count. The guest allocates one exactly-sized
`ArrayBuffer`, then `net.take(handle, buffer)` copies into it and deletes the
core's copy. This makes ownership explicit and keeps the ABI independent of a
specific QuickJS wrapper's object-lifetime rules.

## Errors and HTTP status

Transport failures reject with `NetError` and a portable `code` such as
`dns`, `connect`, `tls`, `timeout`, `redirect`, or `response_too_large`.
An HTTP 404 or 500 is a successful HTTP exchange: `fetch` resolves,
`response.status` carries the code, and `response.ok` is false. This preserves
the useful part of browser fetch behavior without importing its larger object
model.
