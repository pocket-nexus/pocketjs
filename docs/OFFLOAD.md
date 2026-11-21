# Offload

`io.offload` lets a single-threaded PocketJS guest submit bounded work to a
paired provider. **The guest does not receive a socket, filesystem handle, SQL
connection, or synchronous provider call.** The provider owns those resources.

This implementation is independent of `feat/companion` (#360). It adds
`@pocketjs/framework/offload` and a Bun provider transport. The Nintendo 3DS
worker transport lives with the 3DS product host in pocket-nexus/pocket-shell.
Pocket Doc is a separate application using the capability.

## Frame contract

| Boundary | Enforced limit |
| --- | --- |
| Wire record | 4,096 UTF-8 bytes, 4-byte big-endian length prefix |
| Request/result payload | 2,500 UTF-16 code units, serialized string |
| Outstanding guest requests | 8 |
| Native outgoing/incoming queues | 8 records each |
| Native submissions | 2 per host frame |
| Native result copies | 1 per host frame |
| JS completion callbacks | 1 per service-pump tick, including failures |
| Coverage resource | At most 512×16 pixels, one upload per host frame |
| Request deadline | 600 guest frames; provider worker deadline 9 seconds |

`submit` and `take` only copy fixed-size memory slots. **They do not call socket
functions, wait on locks, inspect the SD card, or run provider code.** The native
queues use single producer/single consumer ownership and acquire/release
atomics. Compilation requires lock-free 32-bit atomics. A full outgoing queue
returns false; a full incoming queue stops socket reads and lets TCP exert
backpressure. A connection generation fences both queues.

The service pump sends queued requests and delivers one completion before the
UI frame hooks. Deadlines, cancellation and disconnects release guest tickets.
**Sent requests are never automatically replayed.** A disconnected save can
have an unknown outcome. A provider mutation should use a durable operation
identity and a revision check if its caller needs retry after reconnect.

These limits remove IO waits from the UI thread. They are **not a hard real-time
guarantee for arbitrary JavaScript or rendering**. Application callbacks,
reconciliation, garbage collection, native allocations, GPU submission and OS
scheduling still cost time. Applications must keep their completion handlers
and visible trees bounded and measure the resulting device frames.

## Guest API

List `io.offload` in the application's `features`, then use:

```ts
import { offload } from "@pocketjs/framework/offload";

const work = offload();
const ticket = work.request("notes.page", "[0]", result => {
  if (result.ok) applyVisiblePage(JSON.parse(result.value));
  else showStatus(result.error);
});
// ticket === 0 means the caller retains the work because capacity is full.
// work.cancel(ticket) suppresses delivery; it does not undo provider work.
```

The realm owns one client. Applications do not step it themselves. Input is a
bounded string so the API never traverses an arbitrary application object to
serialize it. Providers return equally bounded strings. Pagination and resource
chunking belong to the capability contract, not to an unbounded accumulator in
the guest.

`work.session()` exposes the authenticated generation (nonpositive when
offline). Applications can revalidate cached revisions when it changes, even
if a reconnect happens between two UI frames without an observed offline frame.

`uploadCoverage(base64, width, height, foreground)` uploads a bounded 2-bit alpha
mask when a host implements it. Width must be a multiple of four and at most
512; height is 1–64. The logical area is at most 8,192 pixels and the texture
envelope is at most 16,384 pixels. Foreground is ABGR. The texture uses the next power-of-two
envelope, with a minimum dimension of eight. A C host decodes with
`engine/modules/offload/include/offload_coverage.h` into reusable
scratch storage; a guest does not need a pixel expansion loop. Undefined means
unsupported; a negative handle means invalid input or exhausted frame credit.
The guest owns returned texture handles and releases them with `freeTexture`.

The optional fifth argument, `{ columns, palette }`, assigns a foreground color
to each pixel column. `columns` contains exactly `width` lowercase hexadecimal
indices. `palette` contains one to sixteen concatenated six-digit RGB colors.
**Palette coloring uses the same scratch buffer and one texture upload.** This
supports prearranged colored text without parsing tokens in the guest; it does
not change the queue, payload or per-frame upload limits.

`uploadIndexedImage({ width, height, pixels, palette })` expands an opaque
four-bit indexed image through the host's RGBA texture upload. Pixels are
base64 bytes with the first index in the low nibble; the palette holds one to
sixteen RGB hex colors. **Expansion is bounded to 4,096 logical pixels**, at
most 128×64, with transparent power-of-two padding. The returned object has
`handle`, `width` and `height` for `ResourceImage`. Call it from a resource
materializer to share the application's per-frame upload budget. Cache eviction
owns `freeTexture`; a row that unmounts only withdraws its demand.

## Provider

`@pocketjs/framework/offload/provider` exports `connectOffloadProvider` and
`dispatchOffload`. The former owns TCP and a dedicated Worker for a connection;
the latter dispatches only own properties of an explicit method allowlist.
Worker initialization arrives as `{ init: data }`. Subsequent messages are
versioned requests. An over-budget response or malformed frame closes the
connection. A stalled worker is terminated instead of retaining its requests
indefinitely.

`@pocketjs/framework/offload/capabilities` exports two provider-side helpers:

- `sqliteQueries(db, queries)`: named, provider-owned SQL with device-supplied
  scalar parameters. Queries must return pages of at most 32 rows within the
  result-string budget. Never accept SQL source from the device.
- `httpResources(resources)`: named, fixed URLs. Requests reject redirects,
  time out after five seconds, and stop reading at 2,000 response bytes.

Install these helpers in the provider Worker. A file service can use the same
method allowlist while resolving opaque document IDs inside its granted root.
No document, Markdown, terminal, or platform SDK concept occurs in the guest
offload client or native queue.

## Service clients

**`createServiceClient(namespace)` (`@pocketjs/framework/service-client`)
owns service transport.** An application that lists `io.offload` reaches the
provider over the offload channel; otherwise the client opens the host's
service mailbox (`svcOpen`, ops 30 to 32), and a host without the mailbox
reaches `httpBase` over HTTP. Offload commands use `<namespace>.command`; an asynchronous
`{ job }` reply is read through `<namespace>.poll`. Mailbox and HTTP
providers expose the same `send` and `subscribe` methods. **At most 16
requests are pending**, each with a frame deadline, and a session change
fails pending work before publishing an `offline` event. `image(file)` and
`openStream(file)` open the namespace's side files on the host
(`loadImgFile`, `videoOpen`).

**`createMediaService(client)` (`@pocketjs/framework/media-service`) owns one
playback lifetime over a frame-indexed stream.** A `playing` reply names the
stream file, its frame rate and its position; the service opens it on the
host's video plane and exposes `texture()` and `status()`. Applications send
`play`, `pause`, `resume`, `seek` and `stop` through the service. Pause and
seek go to the provider, the position advances with each `videoTick`, and an
offload provider is polled for completion **every 120 frames**; mailbox
providers send completion events. Stop and disconnect close the plane and
invalidate outstanding playback replies.

## TCP transport

**`tools/companion-session.ts` connects the provider to a device worker over
TCP 8741** (`OFFLOAD.port`). After the connection opens it sends a
64-character hexadecimal pairing key ahead of framed traffic; pairing is
scoped to the application. **This transport assumes a trusted LAN: records
and the pairing preface are not encrypted.** It is not an Internet-facing
transport. A worker reports its counters in an `offload.metrics` record of at
most 160 characters, which the session hands to its `metrics` callback.

The same request contract can use a provider on the device itself. That host
still needs a worker/process transport with enforced queues and resource
budgets; calling a local provider directly from JS would violate the contract.
**An iPhone-local provider backend is not implemented by this change.**

## Validation

Run `bun test tests/offload.test.ts` and compile/run
`tests/fixtures/offload-queue.c` with pthreads and address/undefined sanitizers.
The fixture exercises 100,000 full-size concurrent records, queue saturation,
counter wrap and coverage decoding. Tests also exercise fragmented UTF-8,
timeouts, cancellation, stale sessions, no mutation replay, provider grants,
SQLite result budgets, HTTP redirects and oversized bodies. These checks are
separate from device performance and interaction acceptance.

Reusable reads can use the [shared resource scheduler](RESOURCES.md#shared-read-scheduling)
for admission, priority, caching and bounded materialization. Commands retain
the direct offload path and application-owned recovery semantics.
