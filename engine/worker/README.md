# Native worker runtime

`worker.c` owns bounded resources and copies between host tasks. `quickjs.c`
owns a second QuickJS runtime and invokes `__pocketWorkerTurn(context, facts)`.
The worker has no `ui` namespace. A host can mount its worker-owned `fs`, `db`
and `console` implementations through `pocket_worker_quickjs_config.mount`.

## Host integration

1. Create a core with a node table and monotonic clock. Supply `lock` and
   `unlock` when another task produces facts or uses channels. These locks are
   task-context locks; ISRs must stage records in an ISR-safe platform queue.
2. Create and evaluate the QuickJS adapter on the task that will own it.
   The `allocator` option lets a platform place the JS heap in internal RAM.
3. Call `pocket_worker_quickjs_step` after a notification or deadline. Read
   `pocket_worker_quickjs_deadline` and block until that time or a notification.
   A notification must remain pending across the check-to-wait transition.
4. On exit or fault, stop external channel publishers and call
   `pocket_worker_destroy`. `BUSY` preserves the core and its buffers. Retry
   after native activity ends. Destroy the QuickJS adapter after the core.

Source parsing and top-level initialization have a separate **250 ms default
bootstrap limit**. Turn execution has a **10 ms default limit**, at most
**64 Promise jobs**, **16 facts** and **8192 payload bytes**. The default domain
allowance is **50 ms per 100 ms window**. A completed turn can consume the
remaining allowance; the next turn waits until replenishment. GC runs while
the inbox and Promise queue are empty and counts against that allowance.

The platform must supply a monotonic clock while JS runs so the interrupt
handler can enforce execution limits. The turn receives the host's latched
time and optional UTC clock identity. A timer fact uses `handle` for its timer
ID, `offset` for its scheduled deadline and `request` for the missed-period
count. The next deadline advances past the observed time.

## Drivers and ownership

Each node declares a resource kind and driver. `open`, `validate`, `start`,
`write`, `cancel` and `close` run on the worker task outside the core lock.
`validate` rejects malformed or unsupported transactions before admission.
The driver enforces device ownership and bus scheduling against its board
configuration. `submit` copies accepted descriptors and reserves a request
slot plus result storage before returning.

**Eight requests have independent terminal storage.** Event overflow cannot
overwrite their results. Cancellation before execution produces `CANCELLED`.
Cancellation after execution starts produces `UNKNOWN`; the slot remains
reserved until the driver reports native completion. IDs are never reused
within a process, including across core destruction. Exhausting the positive
32-bit ID range rejects further allocation.

`emit` copies at most **1024 bytes** into one of **eight event slots**. `BUSY`
means a controlled producer must retain the record and stop upstream reads.
An uncontrolled producer reports a `gap` with the first missing byte offset
and count. Further DATA admission remains blocked until the queued prefix and
GAP have been observed. `finish` ends an HTTP request as one atomic action;
observation orders HEADERS, DATA, END and COMPLETE across turn boundaries.
An explicit cancel can publish an `UNKNOWN` request completion before native
access ends. That completion does not close the receive stream. Consumers
that retain the received prefix wait for END and its final offset; closing the
resource can discard unread input. The request slot stays reserved until the
driver confirms native completion.

`close` must return `BUSY` while a native task, DMA engine or callback can
access the resource or core. It returns `OK` after those accesses end. The
owner retries a pending close at **1 ms intervals** when no other event wakes
it. Device deadlines and close deadlines are distinct.

Snapshot and ring channels use copied storage protected by the host lock.
Snapshots retain the newest record. Rings reject new records when full.
`receive` is UI-to-worker ingress; `publish` and `channel_take` implement
worker-to-UI exchange. Direction is fixed before use. The UI host latches
outgoing channel records at its frame boundary. Observation rotates source
groups and slot indexes so a saturated stream cannot exclude timers or
channels from every turn.

`quickjs_ui.c` supplies the UI bridge for a separate QuickJS context. After
worker bootstrap declares channels, call `pocket_worker_ui_attach` before UI
bundle evaluation. Call `pocket_worker_ui_latch` before each UI frame; it copies
records into UI-owned mirrors and advances the SDK's frame-view generation.
Call `pocket_worker_ui_detach` before freeing the UI context or worker core.
**A worker fault must preserve the core until the UI bridge detaches.** A
stopped core rejects incoming publications. Retained bridge callbacks reject
calls after detachment.

## Validation and current limits

Run the core tests through `bun test tests/worker-native.test.ts`. To test a
selected QuickJS source, set `POCKET_WORKER_QUICKJS_SOURCE` and, for Bellard,
`POCKET_WORKER_QUICKJS_ENGINE=bellard`. The standalone equivalent is:

```sh
sh engine/worker/tests/run.sh /path/to/quickjs .pocket-build/validation/worker/native ng
```

The core test uses AddressSanitizer and UndefinedBehaviorSanitizer. It covers
admission, cancellation racing native completion, terminal reservations,
generation rejection, stream ordering, discontinuities, timer catch-up,
fairness, close retry, and concurrent snapshot publication. The QuickJS test
covers realm separation, event turns, channel copying, domain throttling and
forced interruption. It also runs UI-to-worker-to-UI messages across two real
runtimes and checks frame boundaries, snapshot persistence, ring replacement,
frame-view invalidation and retained callbacks after detachment.

The adapter creates JS fact objects and typed arrays each turn. The core
does not allocate on submit, emit, observe or publish. Channels use mutex
copying rather than a lock-free triple-buffer implementation. Triggered
sampling, edge capture, native tape storage, Remote worker, command channels,
TCP, UDP and MQTT are outside this first native implementation. Board timing,
heap peaks and bus electrical behavior require device measurements.
