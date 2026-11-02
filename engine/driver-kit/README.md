# pocket-driver-kit

Reusable PocketJS driver conformance checks for package sources, input, CPU pixels, and deferred-device lifecycle traces.

## Install

```toml
[dev-dependencies]
pocket-driver-kit = "0.16.0"
pocket-package = "0.16.0"
```

## Example

```rust
use pocket_driver_kit::check_package_source;
use pocket_package::source::MemorySource;

let expected = b"driver source bytes";
let mut source = MemorySource(expected.as_slice());
check_package_source(&mut source, expected).unwrap();
// Replace MemorySource with the driver's real source in its conformance suite.
```

Run from the PocketJS checkout with `cargo run -p pocket-driver-kit --example package_source`.

## Environment and compatibility

Rust 1.93 or later. `no_std` with `alloc`; use it as a development dependency of a driver project.

Supply real driver implementations and independent device completion observations. Model checks do not establish physical GPU completion or device pixels. Rust conformance helpers and the C SDK are separate distributions.

Use matching PocketJS crate releases and compiler contracts. Application package
format, binding generation, and DrawList version are checked at their respective
boundaries; a Cargo version alone does not replace those checks.

## Detailed contract

`check_package_source` compares `all` and range reads against trusted bytes,
including short reads, EOF, empty output and an offset past EOF.
`check_package_admission` then compares source admission with the canonical
parser. Run it for each item in the application's package corpus, including
rejected packages and a mismatched expected profile hash.

Admission also exercises optional Rust `PackageSource::take_bytes` transfer.
Use a fresh owned source for each corpus item: transfer consumes it before
admission, including rejected packages. Static sources remain reusable. The
package crate's README documents ownership and the unchanged C copying path.

`check_input` polls a prepared replay source and passes each resulting frame
to a callback. Compare the facts with the recording there, including axis
units, surface/contact IDs, cancellation, text and motion metadata. The helper
seeds previous contributions before each poll and rejects destructive writes
or facts outside the source's advertised classes. Bit 31 is reserved as the
button append sentinel; test input must not use that bit.

`check_cpu_frame` calls a supplied CPU renderer on an unaligned allocation
with stride padding and compares the acquired region with caller-provided
packed golden pixels. Padding must remain unchanged. The oracle is independent
of the implementation under test.

`Lifecycle` checks an instrumented sequence of acquisitions, submissions,
resource references, device stop observations, waits, retirement and release.
Assign distinct IDs to physical buffers, submissions, transfers and resource
versions. Use the same resource ID for a shared texture version. Emit
`RenderStopped`/`DisplayStopped` from an independent completion probe, then
emit `RenderWaited`/`DisplayWaited` at the API boundary. Returning from `wait`
is not evidence that a real device stopped. Failure returns remain terminal.

Flush requires a successful render wait. A render must stop before retirement;
display transfers must also finish their waits. Every referencing submission
must retire before a texture version is released. A failed frame must drain,
invalidate failed buffers, and report failure at `FrameEnd`. `Destroy` requires
all work drained and discards damage history. Call `finish` to detect missing
frame-end and teardown events. The first violation is sticky. Continue real
hardware cleanup after an audit error.

The capacity supplied to `Lifecycle::new` bounds each work/resource table.
Overflow fails the test instead of dropping observations. A runtime can reuse
the object across frames after successful `FrameEnd` observations.

`test_device` is the delayed `DeviceOwned` model extracted from the independent
Rust consumer. It maintains versioned texture storage, permits two displays
with concurrent submissions, and injects render-wait, partial-flush and
terminal-display-wait failures. It can test another runtime/coordinator through
public traits. It is a model, not a physical GPU driver or hardware evidence.

## C consumers

The SDK includes `pocket/pocket_driver_kit.h` and `src/driver-kit/pocket_driver_kit.c`.
Link the CMake target `Pocket::driver_kit`, or compile the source into the test
executable alongside the driver's C vtables. See
`tests/fixtures/sdk/driver-kit.c` for a standalone consumer.
The harness uses caller-provided bounded storage and needs no host allocator.
Its event IDs and terminal-wait rules match the Rust checker. See the header
for initialization, source checks and the error returned at each boundary.

## Validation scope

Positive and deliberately broken traces exercise the checker itself. The
crate also runs the extracted delayed driver through the real presenter,
including failure drain and destruction. The repository integration fixture imports
this crate at a fixed revision. SDK tests compile an independent C consumer
and exercise both accepted and rejected implementations.

These checks do not prove the physical stop probe, cache coherency or device
pixels. Keep software pixel fixtures and device receipts with the driver's CI.

## Documentation and license

- [API reference](https://docs.rs/pocket-driver-kit)
- [Source](https://github.com/pocket-nexus/pocketjs/tree/main/engine/driver-kit)
- [PocketJS documentation](https://pocketjs.pocket.nexus/docs/)

MIT. The published crate includes the copyright notice and full license in `LICENSE`.
