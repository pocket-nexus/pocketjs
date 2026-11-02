# Native worker runtime

`worker.c` owns bounded resources and copies between host tasks. `quickjs.c`
owns a second QuickJS runtime and invokes `__pocketWorkerTurn(context, facts)`,
which the SDK's scheduler module installs before the application entry
evaluates. The worker has no `ui` namespace. A host can mount its worker-owned `fs` and
`console` implementations through `pocket_worker_quickjs_config.mount`.

## Host integration

`runner.c` holds the owner task's protocol; a platform supplies primitives.

1. Fill `pocket_worker_runner_config`: the core's node table, generation and
   task-context `lock`/`unlock`/`wake`/`now_micros`; the realm's limits,
   `mount` and optional `allocator`; the NUL-terminated bundle, or its
   package bytecode section with the engine ABI of this QuickJS build
   (`contracts/generated/pocket_quickjs_abi.h`), which is evaluated instead
   of source when its digest matches; and `wait`, which blocks the owner
   task until `wake` or an absolute deadline. ISRs
   must stage records in an ISR-safe platform queue; the locks are
   task-context operations.
2. On the owner task, `pocket_worker_runner_create` builds the core and the
   realm and evaluates the bundle. A bootstrap failure returns a runner whose
   `failed` flag is set and whose `error` names the cause.
3. `pocket_worker_runner_run` steps the realm, waits through `wait` until the
   next deadline or wake, and returns once another task called
   `pocket_worker_runner_stop`. **After a realm fault the loop holds the core
   until stop**, so the UI bridge detaches first; any task reads the fault
   through `pocket_worker_runner_failed` and `pocket_worker_runner_error`.
   `start_paused` holds turns until `pocket_worker_runner_resume`; the
   optional `after_turn` hook runs on the owner task after each turn.
4. After run returns, `pocket_worker_runner_destroy` shuts the core down,
   retries destroy through `wait` at 1 ms while native users remain, then
   destroys the realm. A platform that delivers facts from another task
   keeps servicing that task until destroy returns.

A step observes at most **16 facts** and **8192 payload bytes**, calls the
turn entry once with them and then executes at most **64 Promise jobs**; a
longer chain continues in the next step. **The bounds are counts; no
execution time limit exists.** `pocket_worker_quickjs_interrupt` ends the JS
execution in progress with a fault; the runner's stop calls it, which is how
a stop reaches a turn that never returns. A platform can set a CPU share
(`quota_micros` per `window_micros`), off by default, for a worker task that
outranks the UI task on the same core; a step that exhausted the share waits
until the window replenishes. GC runs while the inbox and Promise queue are
empty.

The platform's monotonic clock latches each turn's time and drives timer
deadlines. The turn receives the host's latched time and optional UTC clock
identity. A timer fact carries its timer id in
`timer`, its planned deadline in `deadline` and the periods missed before
observation in `missed`; a channel fact carries the channel id in `channel`.
The resource fields of both stay zero. The next deadline advances past the
observed time.

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

`quickjs_ui.c` supplies the UI bridge for a separate QuickJS context. **The
bridge calls the UI context's QuickJS, so the worker library compiles against
the QuickJS build that runs the UI realm**: the CardputerZero program
(`programs/cardputer-zero/build.rs`) compiles it against the `rquickjs-sys`
source in the workspace lock. After
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
covers realm separation, event turns, channel copying, the optional CPU
share, the job bound with its spill into the next step, and the interrupt
that ends an unbounded turn. It also runs UI-to-worker-to-UI messages across two real
runtimes and checks frame boundaries, snapshot persistence, ring replacement,
frame-view invalidation and retained callbacks after detachment.

The adapter creates JS fact objects and typed arrays each turn. The core
does not allocate on submit, emit, observe or publish. Channels use mutex
copying rather than a lock-free triple-buffer implementation. Triggered
sampling, edge capture, native tape storage, Remote worker, command channels,
TCP, UDP and MQTT are outside this first native implementation. Board timing,
heap peaks and bus electrical behavior require device measurements.
