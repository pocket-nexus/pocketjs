# ESP-IDF data-smoke

On-device conformance smoke for the data modules — `pocket-db` and
`pocket-fs` driven directly (no `mount` feature, the way a device host
with its own guest wiring consumes them) against a LittleFS partition on
an ESP32-P4.

This is a platform hardware test, not an optional dependency of the PocketJS
UI components.

The contract semantics are verified host-side (`tests/{db,fs}.test.ts`,
the crates' unit tests). This binary asks only the questions hardware can
answer: does everything compile and link here, does LittleFS behave
(atomic rename, persistence), and what does it cost (heap, timings).

## Run

```sh
cargo build --release
espflash flash --port <PORT> --partition-table partitions.csv --monitor \
    target/riscv32imafc-esp-espidf/release/data-smoke
```

The first build bootstraps ESP-IDF v5.5.3 into `.embuild/` (set
`IDF_TOOLS_PATH` to reuse an existing espressif tools directory — the
`tools/data-smoke-cc` wrapper honors it). The SQLite build recipe this
directory pins (`LIBSQLITE3_FLAGS`, the empty `sys/ioctl.h` shim) is
documented in docs/DB.md "ESP32 / ESP-IDF".

Watch UART for:

```
DATA-SMOKE: fs ok in ...; boot N; usedBytes ...
DATA-SMOKE: db ok in ... (288-row tx ...)
DATA-SMOKE: PASS boot=N
```

A boot counter (an fs truncate-write) and a per-boot 288-row transaction
persist across runs; power-cycle the board and `boot` increments while the
row count is verified as `boots × 288` — flash persistence proven through
both modules, not just asserted.

Measured on a Waveshare ESP32-P4 (rev 1.3, LittleFS on 8 MB partition):
fs contract pass ~0.5 s, 288-row insert transaction ~0.5–0.7 s, steady
heap delta ~1 KB across the whole run.
