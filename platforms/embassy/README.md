# Embassy adapters

**The program owns the Runtime, guest, package, renderer and peripherals.** This
crate provides a CPU `DisplayOutput` adapter and Embassy deadline waits. It does
not load JavaScript, select an engine, draw a UI tree or compile C code.

The boundary matches the other platforms: ESP-IDF's runner drives the canonical
runtime, Zephyr registers display/input drivers, and the program selects its guest
and memory policy. `pocket-embassy` uses `no_std` and `alloc`; the program installs
the allocator and Embassy time driver.

## Components

| Component | Responsibility |
| --- | --- |
| `display::BufferedDisplay` | Register a CPU-visible output with the existing presentation coordinator |
| `display::Presenter` | Submit its completed buffer to an asynchronous transport |
| `display::Transport` | Board-owned DMA, wire format and peripheral access |
| `runner::Ticker` | Wait for deadlines from the runtime's selected `Timing` |

The default `runner` feature adds `pocket-runtime` and `embassy-time`. A display-only
consumer uses `default-features = false`; the display adapter depends on
`pocket-drivers` and has no UI-core, rasterizer or executor dependency.

## Compose an application

Create the runtime from the program's exported host contract. Register a package
source, a guest and input sources through the existing Runtime API. Register
`pocket_raster::RasterRenderer` as the software renderer, then add the output:

```rust
let (output, mut presenter) = BufferedDisplay::new(
    DisplayRole::Primary, width, height, PixelFormat::Rgb565, framebuffer_budget,
)?;
runtime.add_display(output, RendererId::SOFTWARE)?;
runtime.boot()?;
presenter.present(&mut panel).await?;
let mut ticker = Ticker::new(runtime.timing().unwrap(), max_lag_us)?;
loop {
    ticker.next().await?;
    runtime.tick()?;
    presenter.present(&mut panel).await?;
}
```

The program imports `BufferedDisplay` from `pocket_embassy::display` and `Ticker`
from `pocket_embassy::runner`. Register `RquickjsGuest::default()` through
`Runtime::set_guest`. The complete executable composition is in
[`tests/fixtures/embassy-host`](../../tests/fixtures/embassy-host).

**Package admission and cadence selection remain in Runtime.** Pass its `Timing`
to `Ticker`; an admitted 30 Hz application can select 30 Hz from a host that also
advertises 60 Hz. `Ticker` uses `TickSchedule`'s lag policy and returns one due tick.
The program retains control of cancellation, retries, shutdown and extra work.
Drop or join its transfer future before shutting down the runtime and peripherals.

## Display ownership

`BufferedDisplay` supports RGB565, RGBA8888 and ARGB8888 full-frame CPU storage.
The constructor checks the supplied byte budget. The normal coordinator performs
layout-independent damage tracking, software rendering and resource retirement.
Pixel format, dimensions and scale follow the registered output and package.

The coordinator's `flush`/`wait` publishes the completed CPU buffer; it starts no
peripheral I/O. `Presenter` moves that allocation into the async transfer and
returns it after completion. **No full-frame copy occurs between those stages.**
The transport receives the descriptor, native pixel bytes and physical damage
rectangles. It owns any byte-order conversion, alignment and DMA staging.

Drain each presenter after boot/present/tick and before the next runtime turn.
An undrained or in-flight output rejects acquisition. A transport must stop
borrowing bytes when its future returns or is dropped. Cancellation and errors
return the buffer and change its generation, so a later `Runtime::present` repaints
it without another guest turn. `Presenter::invalidate` handles panel resets.

The output and presenter stay on one task. They create no task, thread or second
core. JS evaluation and CPU rendering remain synchronous; async waits apply to
pacing and peripheral I/O. The crate does not impose a frame-time guarantee.

## Guest and build ownership

Use any implementation of `pocket_runtime::Guest`. The host and bare-metal fixtures
use the existing [`pocket-guest-rquickjs`](../../engine/guest-rquickjs) with
`default-features = false` and `rust-alloc`. The platform has no engine dependency.

`rquickjs-sys` compiles its bundled QuickJS-NG sources. For targets without shipped
bindings, enable `bindgen` and provide libclang, a target C compiler, newlib headers
and libraries. The program supplies the global allocator and clock hooks, and with
GCC 14 or later adds `-Wno-error=incompatible-pointer-types` to the target `CFLAGS`
(see the [guest's compatibility notes](../../engine/guest-rquickjs/README.md#environment-and-compatibility)).
None of these belong in `pocket-embassy`; no rquickjs source patch is required.

```sh
cargo test -p pocket-embassy --locked
cargo test -p pocket-embassy --no-default-features --locked
cargo test --manifest-path tests/fixtures/embassy-host/Cargo.toml --release --locked
cargo run --manifest-path tests/fixtures/embassy-host/Cargo.toml --release --locked
python3 tests/fixtures/embassy-link/build.py thumbv7em-none-eabihf --cc arm-none-eabi-gcc
python3 tests/fixtures/embassy-link/build.py riscv32imafc-unknown-none-elf --cc riscv32-esp-elf-gcc
```

The crate's `ticker` test steps a 32,768 Hz clock, the rate of embassy-nrf's RTC
driver. `Ticker` rounds each deadline up to an Embassy tick, so a deadline between
two ticks wakes once, at the later tick. The fixture tests execute canonical package
admission, input sampling and rendering. They
check pixel changes, display token/region contracts, transfer cancellation/failure,
and interpreter errors. The executable checks 30 Hz cadence selection and progress
of another Embassy task during display waits. The separate
[`embassy-link`](../../tests/fixtures/embassy-link) fixture links for ARM/RISC-V;
its inert clock and arena do not establish board support or DMA timing.

The link fixture enables newlib's clock and pthread declarations because QuickJS's
shared utility header parses them. It disables JS Atomics; unused thread helpers
are discarded, and no pthread implementation is supplied. The build rejects a
remaining pthread dependency and passes the GCC 14 flag above. A board port must
select the matching ABI, provide working clocks, size its heap and stack, and
configure its renderer and display.
Embassy support does not imply that every Embassy chip can fit or link this engine.
