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
**Package section 8 contains the
NUL-terminated worker bundle.** The host evaluates this section in the worker
runtime. **Each bundle carries its execution domain as the compile-time
constant `__POCKET_DOMAIN__`**: `"ui"` from `tools/build.ts`, `"worker"` from
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
import { ResourceStatus, type Inbox, type TurnContext } from "@pocketjs/framework/worker";

const rtc = io.i2c("i2c0").open({ address: 0x32 });
const output = io.channel("rtc");
let pending = -1;

export function turn(context: TurnContext, inbox: Inbox): void {
  if (context.sequence === 1) io.timer(1, context.nowMicros + 1, 1_000_000);
  const completion = inbox.completion(pending);
  if (completion) {
    pending = -1;
    const data = completion.take();
    if (completion.status === ResourceStatus.ok && data) output.publish(data);
  }
  if (pending < 0 && inbox.timer(1)) pending = rtc.submit([read(0x10, [bytes(7)])]);
}
```

The example transports raw RTC registers. Device drivers must validate voltage
loss, oscillator state and BCD fields before publishing a date. The Tab5
RX8130CE and BMI270 drivers in `pocket-m5` perform device validation and unit
conversion in TypeScript.

## Resource protocol

`io.i2c(name).open(...)`, `io.uart(name).open(...)` and
`io.http(name).open(...)` create host-owned resources. The board host validates
the node and device ownership. Open rejects an unavailable resource; readiness
arrives as a fact in a later turn.

**`submit` reserves a request slot and result capacity before accepting work.**
It returns a positive request ID, or `-1` when no operation was accepted.
`inbox.completion(id)` exposes its terminal status. `take()` copies the result
once. An executing request cancelled without proof of rollback completes with
`ResourceStatus.unknown`; a request cancelled before execution completes with
`ResourceStatus.cancelled`. Late native completion releases storage without
delivering a second terminal.

I2C scripts contain ordered register reads and writes. The native executor owns
the entire transaction, including repeated starts. Read results concatenate in
script order. Field encodings declare byte widths and endianness; the result
view provides scalar readers. The default transaction timeout is 100 ms, with
a per-submit override. The v1 descriptor supports 8-bit register addresses and
7-bit device addresses. Results are byte views; applications select the scalar
readers and offsets. Layout-derived typed result accessors are not generated.

UART `write(bytes)` returns the accepted byte count or a negative status. The
host copies accepted bytes before returning. **Accepted bytes represent buffer
capacity, not transmission completion.** RX facts include byte offsets. A gap
fact carries the discontinuity offset and loss count; an unknown loss count
requires parser resynchronization or reopening the stream. Flow control
requires the corresponding host pins.

HTTP `open({url, method, headers, body, timeoutMs, maxBytes})` creates a request;
`submit()` starts it. The descriptor and UTF-8 request body fit within 1024
bytes. Facts deliver headers, body blocks and an end record with the final
offset. The 3DS provider uses Pocket Link `net.stream` and byte credits. It
does not allocate a complete response body. The CardputerZero provider
(`programs/cardputer-zero/src/http.rs`) reaches loopback addresses and the
companion's control API; each request runs on its own thread and queues its
facts, which the owner task emits when it waits or finishes a turn. Link socket servicing retains the
system's service-loop cadence; worker JS execution has an independent task.
Cancellation can report an unknown request outcome before native access ends.
The stream's end fact remains the boundary of the retained prefix; consumers
that need that prefix wait for the end fact before closing the resource.

`close()` stops admission. Native drivers stop production and acknowledge the
end of native buffer access before storage is freed. Worker shutdown stops
resources before destroying QuickJS. A driver that remains busy retains its
storage.

## Turns and channels

`TurnContext` contains session generation, turn sequence and latched monotonic
microseconds. A host can provide a read-only UTC clock identity containing UTC
microseconds, generation, source and error bound. Absence means that the host
has no wall-clock mapping. `nowMicros()` and `wallClock()` from
`@pocketjs/framework/worker` expose these turn values; the UI `clock` module
keeps the frame clock.

`io.timer(id, deadlineMicros, periodMicros)` sets a deadline. A zero deadline
cancels it. Timer facts carry the timer id in `timer`, the planned deadline in
`deadline` and the number of missed periods in `missed`. The actual
observation time is the turn's `nowMicros`.

**Incoming views expire at the next turn.** `ByteView.copy()` and completion
`take()` create retained bytes. Turns must return before subsequent input is
dispatched; an async `turn` function is rejected. Promise jobs have a bounded
dispatch count. The runner enforces a turn time limit and a replenished domain
quota, and runs GC while idle.

Channels use manifest order to assign IDs. Snapshot channels retain the newest
record; rings reject a publish when full. The v1 host copies channel records
under a lock, which prevents writes during a reader's copy.
Channels have one direction and a maximum record length. Worker consumers read
`inbox.channel(name)` for arriving records or `inbox.snapshot(name)` for the
retained inbound snapshot; UI consumers call `worker.channel(name).observe()`
from `@pocketjs/framework/worker/channels` on the mirror latched at frame entry.
UI views expire at the next frame.

## Limits and implementation status

The core reserves **8 resource slots, 8 request slots, 8 event slots, 8 timers
and 8 channels**. Each descriptor, result or event carries at most **1024
bytes**. Terminal state has reserved storage outside the data event queue.
Node pins, allowed device addresses, UART flow-control wiring, task priority
and heap limits belong to the host firmware.

This implementation provides local worker tasks, one-shot I2C scripts, UART
streams, streaming HTTP, snapshot/ring channels, timer facts and resource
shutdown that waits for native access to end. The PRD's triggered sample executor, GPIO edges, command
channels, remote worker replacement for `offload`, complete domain tape,
TCP/UDP/MQTT, generated board-node accessor types and UI fallback ownership
tables remain unimplemented. UI-only hosts keep their offload module; HTTP is
the worker's `io.http` resource. The 3DS routes it over Pocket Link; the
CardputerZero routes it to its own loopback interface.

QuickJS facts and SDK views allocate objects during a turn. The current runner
disables threshold-triggered GC but does not provide an allocation-free hot
path or a measured 1 ms control-loop guarantee. On 3DS, a package with a worker
and `data.fs` mounts the filesystem in the worker and removes the UI mount.
Other hosts must supply their `fs` implementation through the worker mount
callback before admitting that module in that domain.

## Validation

```sh
bun test tests/worker.test.ts tests/worker-http-stream.test.ts tests/host-services-link.test.ts
sh engine/worker/tests/run.sh /path/to/quickjs-ng
bun tools/packaging/esp-idf/contracts.ts --check
```

The native suite exercises cancellation races, terminal reservation, bounded
channels and producer/consumer interleavings. QuickJS tests cover realm
isolation, event turns and budget handling. The Tab5 firmware and device
validation commands live in `pocket-m5`; host tests and successful cross builds
are distinct from physical device results.
