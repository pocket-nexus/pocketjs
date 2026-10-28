# Worker resources

**A worker has its own QuickJS runtime and owner task.** The UI continues to
receive frames. Resource completions, received bytes, channel records and timer
deadlines wake the worker. The owner waits on a notification or the next deadline
when there is no work. The build resolver refuses a package that requires
`runtime.worker` when the target profile lacks that capability.

## Application entry

The manifest's `domains.worker` declares the worker entry and its node names.
Paths have the same project root as `app.entry`.

```json
{
  "engine": {
    "capabilities": { "requires": ["runtime.worker", "io.i2c"] }
  },
  "domains": {
    "worker": {
      "entry": "apps/sensors/worker.ts",
      "nodes": [{ "name": "i2c0", "kind": "i2c" }],
      "channels": [{
        "name": "rtc",
        "kind": "snapshot",
        "direction": "worker-to-ui",
        "recordBytes": 7,
        "capacity": 1
      }]
    }
  }
}
```

This fragment extends the application's `pocket.json`; the identity, framework
and viewport fields remain required. The resource table in
`contracts/spec/worker.ts` names the capability each node kind requires:
`io.i2c`, `io.uart` and `net.http`.
**HTTP exists only as a worker resource**: no UI realm has a network module.
The current resolver requires the worker. An `enhances` declaration with a UI
fallback ownership table is not implemented.

`tools/build.ts` emits a minified `<output>.worker.js` to reduce embedded parser
memory. It is a classic script with no runtime imports, exports or outer
function wrapper. The worker owns its global namespace; omitting the wrapper
avoids a retained whole-bundle function source copy in QuickJS.
**Package section 8 contains the NUL-terminated worker bundle.** The host
evaluates this section in the worker runtime. **The scheduler module
`@pocketjs/framework/worker` evaluates before the entry**: it declares the
manifest's channels to the host and installs the turn entry the host calls.
The application entry exports nothing. Its top-level code opens resources and
starts async functions; the first `await` returns control to the host.
**Each bundle carries its execution domain as the compile-time constant
`__POCKET_DOMAIN__`**: `"ui"` from `tools/build.ts`, `"worker"` from
`tools/build-worker.ts`. The registry in `framework/compiler/subpaths.ts` lists
the domains that resolve each `@pocketjs/framework` subpath: `worker`, `io` and
`io/i2c` resolve in the worker domain, `fs` in both, every other subpath in the
UI domain. The UI compiler rejects a worker subpath, the worker bundler rejects
a UI subpath and the UI frameworks, and `pocket check` maps each entry's imports
with the same table. The host's worker mount determines whether `fs` is
available.

```ts
import { io } from "@pocketjs/framework/io";
import { bytes, read } from "@pocketjs/framework/io/i2c";

const rtc = io.i2c("i2c0").open({ address: 0x32 });
const output = io.channel("rtc");

async function main(): Promise<void> {
  for await (const _ of io.timer(1_000_000)) {
    try {
      output.publish(await rtc.run([read(0x10, [bytes(7)])]));
    } catch (error) {
      console.log(`RTC read failed: ${error}`);
    }
  }
}
main();
```

The example transports raw RTC registers. Device drivers must validate voltage
loss, oscillator state and BCD fields before publishing a date. The Tab5
RX8130CE and BMI270 drivers in `pocket-m5` perform device validation and unit
conversion in TypeScript.

## Resource protocol

`io.i2c(name).open(...)`, `io.uart(name).open(...)` and
`io.http(name).open(...)` create host-owned resources. The board host validates
the node and device ownership. Open rejects an unavailable resource; readiness
arrives as a stream fact.

**`submit` reserves a request slot and result capacity before accepting work.**
It returns a positive request ID, or `-1` when no operation was accepted.
`settle(id)` from `@pocketjs/framework/worker` resolves with the completion
record in the turn that carries it: the terminal status and a retained copy of
the result. A completion that arrives before the call waits for it. `settle`
resolves whatever the status, so a caller inspects `cancelled` and `unknown`
outcomes. `I2CDevice.run(script)` combines submit and settle and resolves with
the result bytes; **it rejects with a `ResourceError` carrying the status and
request when the host accepts nothing or the transaction ends with a status
other than ok.** An executing request cancelled without proof of rollback
completes with `ResourceStatus.unknown`; a request cancelled before execution
completes with `ResourceStatus.cancelled`. Late native completion releases
storage without delivering a second terminal.

```ts
const request = rtc.submit(script);
const outcome = await Promise.race([settle(request), sleep(2_000_000)]);
if (!outcome) {
  rtc.cancel(request);
  const late = await settle(request); // cancelled, unknown or ok
}
```

I2C scripts contain ordered register reads and writes. The native executor owns
the entire transaction, including repeated starts. Read results concatenate in
script order. Field encodings declare byte widths and endianness. The default
transaction timeout is 100 ms, with a per-submit override. The v1 descriptor
supports 8-bit register addresses and 7-bit device addresses. Results are
bytes; applications select the scalar readers and offsets through `DataView`.
Layout-derived typed result accessors are not generated.

**`observe()` on a resource is an async iterable of its stream facts**: ready,
headers, data, end, gap, error, credit and closed, in arrival order, each a
retained copy with status, offset and bytes. One loop reads a stream at a
time. A record that arrives while no loop reads the stream expires with its
turn, like the host view it was copied from. A record that arrives while the
loop is between reads is buffered; **a loop that falls 64 records behind
faults the realm**, because the host holds eight event slots and a reader that
far behind has stopped. The stream ends when the resource closes.

UART `write(bytes)` returns the accepted byte count or a negative status. The
host copies accepted bytes before returning. **Accepted bytes represent buffer
capacity, not transmission completion.** RX facts include byte offsets. A gap
fact carries the discontinuity offset and loss count; an unknown loss count
requires parser resynchronization or reopening the stream. Flow control
requires the corresponding host pins.

HTTP `open({url, method, headers, body, timeoutMs, maxBytes})` creates a request;
`submit()` starts it. The descriptor and UTF-8 request body fit within 1024
bytes. Facts deliver headers, body blocks and an end record with the final
offset through `observe()`; the completion settles the request id. The 3DS
provider uses Pocket Link `net.stream` and byte credits. It does not allocate a
complete response body. The CardputerZero provider
(`programs/cardputer-zero/src/http.rs`) reaches loopback addresses and the
companion's control API; each request runs on its own thread and queues its
facts, which the owner task emits when it waits or finishes a turn. Link socket
servicing retains the system's service-loop cadence; worker JS execution has an
independent task. Cancellation can report an unknown request outcome before
native access ends. The stream's end fact remains the boundary of the retained
prefix; a consumer that needs that prefix reads to the end fact before closing
the resource. `apps/worker-http/worker.ts` and `apps/companion-zero/worker.ts`
close the resource from the completion, which ends the stream loop whether or
not an end fact arrived.

`close()` stops admission and ends the resource's stream. Native drivers stop
production and acknowledge the end of native buffer access before storage is
freed. Worker shutdown stops resources before destroying QuickJS. A driver that
remains busy retains its storage.

## Turns and the scheduler

**A turn is one iteration of the runner loop.** The owner task waits for a
wake or the next deadline, observes the facts that arrived, calls the turn
entry once with all of them, executes the pending Promise jobs, and computes
the next deadline. `TurnContext` carries the session generation, the turn
sequence and the monotonic microseconds latched when the turn began; a host
can add a read-only UTC clock identity. `nowMicros()` and `wallClock()` from
`@pocketjs/framework/worker` expose these values; both are absent during
bootstrap, and the UI `clock` module keeps the frame clock. The latch exists
for replay: one timestamp per turn is the clock's whole contribution to the
tape. A measurement that needs the moment of a native event belongs in the
fact that reports it.

**Every Promise in the realm settles inside a turn, in fact order.** The
scheduler resolves completions, timer deadlines and stream reads from the
turn's facts and latched time; the host executes no JS between turns, so no
Promise settles there. Continuations run after the turn entry returns, in the
same iteration. **The host executes at most 64 Promise jobs per iteration**; a
longer chain continues in the next iteration, after that iteration's turn
entry and ahead of the jobs it queues. The bound is a count, never a time, so
a replay splits a chain at the same place. A record handed to a continuation
is a retained copy; nothing a continuation holds expires.

`sleep(micros)` resolves in the turn whose latched time reaches the deadline.
`io.timer(periodMicros)` is an async iterable of ticks; each tick carries its
planned deadline and the periods that passed unobserved before it, and the
deadline advances by whole periods, so the schedule does not drift with turn
latency. A tick that arrives while the loop is between reads folds into the
next tick's `missed` count. The scheduler maps every deadline onto one host
timer; the count of sleeps and timers is not limited. A deadline registered
during bootstrap counts from the first turn's latched time.

**There is no execution time limit.** A turn or continuation runs until it
returns; a missed deadline is information in the next tick, not a fault. A
turn that never returns holds the domain until the host stops the runner,
whose stop interrupts the execution in progress. The domain faults on an
uncaught exception in the turn entry, an unhandled Promise rejection once the
job queue drains, a stream reader 64 records behind, or heap and stack
exhaustion; the runner then holds the core until stop so the UI bridge can
detach, and reports the cause through `pocket_worker_runner_error`.

Channels use manifest order to assign IDs. Snapshot channels retain the newest
record; rings reject a publish when full. The v1 host copies channel records
under a lock, which prevents writes during a reader's copy. Channels have one
direction and a maximum record length. The worker side is
`io.channel(name)`: `publish(bytes)` toward the UI, `observe()` for each
arriving inbound record and `snapshot()` for the retained newest inbound
snapshot, which persists across turns until the generation changes. UI
consumers call `worker.channel(name).observe()` from
`@pocketjs/framework/worker/channels` on the mirror latched at frame entry.
UI views expire at the next frame.

## Limits and implementation status

The core reserves **8 resource slots, 8 request slots, 8 event slots, 8 timers
and 8 channels**. Each descriptor, result or event carries at most **1024
bytes**. Terminal state has reserved storage outside the data event queue.
Node pins, allowed device addresses, UART flow-control wiring, task priority
and heap limits belong to the host firmware. **A platform can give the realm a
CPU share** (`quota_micros` per `window_micros` in
`pocket_worker_quickjs_config`); the default is none. The share exists for a
host whose worker task outranks the UI task on the same core, where the
scheduler would give the UI no time. The 3DS host sets 10 ms per 20 ms.

This implementation provides local worker tasks, one-shot I2C scripts, UART
streams, streaming HTTP, snapshot/ring channels, timer ticks and resource
shutdown that waits for native access to end. The PRD's triggered sample
executor, GPIO edges, command channels, remote worker replacement for
`offload`, complete domain tape, TCP/UDP/MQTT, generated board-node accessor
types and UI fallback ownership tables remain unimplemented. UI-only hosts keep
their offload module; HTTP is the worker's `io.http` resource. The 3DS routes
it over Pocket Link; the CardputerZero routes it to its own loopback interface.

QuickJS facts and SDK records allocate objects during a turn. The current
runner disables threshold-triggered GC and runs GC while idle; it does not
provide an allocation-free hot path or a measured 1 ms control-loop guarantee.
On 3DS, a package with a worker and `data.fs` mounts the filesystem in the
worker and removes the UI mount. Other hosts must supply their `fs`
implementation through the worker mount callback before admitting that module
in that domain.

## Validation

```sh
bun test tests/worker.test.ts tests/worker-http-stream.test.ts tests/host-services-link.test.ts
sh engine/worker/tests/run.sh /path/to/quickjs-ng
bun tools/packaging/esp-idf/contracts.ts --check
```

The native suite exercises cancellation races, terminal reservation, bounded
channels and producer/consumer interleavings. QuickJS tests cover realm
isolation, event turns, the optional CPU share, the job bound and the
interrupt. The Tab5 firmware and device validation commands live in
`pocket-m5`; host tests and successful cross builds are distinct from physical
device results.
