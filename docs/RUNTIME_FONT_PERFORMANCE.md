# Runtime font performance and acceptance

**These measurements use a real text worker and the shared WASM software renderer at a 60 Hz delivery rate.** The host was macOS arm64 on Apple M4, using Bun 1.3.14. Glyph caches start empty in each scenario. Worker startup is measured apart from first-visible latency. Build-time baking and core instantiation are outside the measured interval. The benchmark scripts retain raw results in ignored `.pocket-build/validation/runtime-ttf/benchmark/`.

Run:

```sh
bun tools/wasm.ts
bun tools/text-wasm.ts
bun tools/runtime-text-bench.ts
bun tools/runtime-bitmap-bench.ts
```

| Runtime TTF scenario | First visible | Frame p95 / maximum | Core texture bytes installed | Shapes / layouts |
| --- | ---: | ---: | ---: | ---: |
| Cold mixed Latin, combining mark and Han, 16 px | 140 ms | 1.99 / 1.99 ms | 14,720 | 1 / 1 |
| 256 new Han glyphs, 16 px | 2,258 ms | 1.12 / 3.04 ms | 255,488 | 1 / 1 |
| 256 Han glyphs with 4 KiB texture budget | Rejected in 1,132 ms | 0.76 / 1.41 ms | 0 | 1 / 1 |
| Mixed label, 24 px | 159 ms | 1.74 / 1.74 ms | 17,920 | 1 / 1 |
| Mixed label, 48 px | 516 ms | 0.98 / 2.66 ms | 71,680 | 1 / 1 |
| Four glyphs, 128 px | 965 ms | 0.74 / 2.04 ms | 262,144 | 1 / 1 |
| Initial label plus ten edits, 16 px | Initial 141 ms; resident edits 35–38 ms | 1.43 / 1.72 ms | 8,960 total | 11 / 11 |

The first edit introduces `x` and takes 69 ms. The remaining edits reuse its bitmap. **Ten edits rasterize and upload one additional glyph.** The whole sequence has eleven unique glyphs, eleven rasterizations and eleven texture uploads. Color changes produce no shaping or layout work. Width changes produce a layout while retaining the shaping result and glyph resources; regression tests assert those counters and preserve the original layout object after bitmap eviction.

Before combining shape, layout, keyed lease and short geometry into `runtime.prepare`, resident edits took 243–300 ms because their metadata crossed several frame-delivery boundaries. The combined request reduces that interval to two delivery frames. Raster requests group glyphs within the existing record limit, and texture work has a per-frame byte limit. A source edit still runs shaping in the worker; there is no UI-thread shaping path.

## Point-sampled comparison

| Existing path | Scenario | First visible | Frame p95 / maximum | Transfer or source bytes |
| --- | --- | ---: | ---: | ---: |
| Streamed bitmap archive | 256 new Han, 16 px | 1,199 ms | 1.48 / 2.22 ms | 55,758 wire bytes |
| Streamed bitmap archive | Ten resident edits | 0.21–0.56 ms per edit | 0.68 / 0.68 ms | No new requests or commits |
| Prebaked atlas | Cold mixed label | 2.33 ms | 0.21 / 0.23 ms | 31,680 source coverage bytes |
| Prebaked atlas | 256 Han present in the PAK | 2.58 ms | 0.21 / 0.33 ms | 112,640 source coverage bytes |

The streamed comparison uses a real archive worker, the same 460-pixel container, the same Han fixture and the same 60 Hz delivery gate. Atlas baking occurs before the run. The prebaked comparison includes loading its atlas but has no worker or raster request.

**The runtime path exchanges more data than the two-bit archive path.** The 256-Han run sends 141,052 wire bytes, including gray8 coverage, clusters and editing positions, versus 55,758 archive bytes. Its first-visible latency is 1.88 times the archive measurement. This remains a first-version limit for large cold batches; prefetching through `prepareText()` moves that wait before presentation. Both paths retain whole-batch readiness. The TTF path does not overwrite ready text with a subset of the requested glyphs.

## Memory and upload accounting

The 256-Han runtime run holds 59,936 bytes of client gray8 coverage and 255,488 bytes of core RGBA texture data. Worker cache peaks are 29,598 bytes for shaping, 15,816 for line layout and 100,532 for bitmaps including cache bookkeeping. Worker source fonts occupy 860,776 shared Rust bytes plus a FreeType-owned copy. Core WASM linear memory is 2,031,616 bytes. The equivalent streamed archive reserves 327,680 bytes for its configured source-cell capacity.

Across the runtime scenarios, the benchmark process's peak RSS rises from 97.1 to 127.2 MiB. This is a cumulative process high-water mark, including Bun, worker runtimes, font parsing, allocator retention and benchmark code. It is neither live cache residency nor a PSP memory prediction. Worker creation, font reads and module initialization take 21–38 ms in this run.

“Core texture bytes installed” counts the padded RGBA glyph data accepted by the core for renderer upload. The software benchmark does not measure a GPU driver or PCI transfer. **The WGPU lifetime test runs on Apple M4 Metal** and verifies that an encoded draw retains its glyph pixels after the CPU slot and renderer cache entry are replaced. It also verifies that reloading an evicted bitmap restores pixels without changing layout. The new path creates no font-atlas rebuilds or atlas revision changes.

## Acceptance and platform limits

The tests require native/WASM equality of glyph IDs, positions and caret maps; a real `ffi` ligature; proportional advances and kerning; combining-character editing boundaries; explicit fallback; independent cache limits; whole-batch readiness; rejection under a pinned budget; and session-safe cancellation. The UI tests require color changes to avoid preparation and width changes to reuse shaping. Existing bitmap, Clear and Note tests remain part of validation.

The measured frame-work ceiling for this run is 3.04 ms. It is a result from this host, not a cross-platform frame-time guarantee. A run made during concurrent compilation showed frame outliers; the run with per-stage profiling and no concurrent compilation had no frame above 8 ms. No PSP hardware, PPSSPP display run, or browser UI session was available. PSP companion packet exchange and MIPS compilation were verified on the host; the SDK FreeType archive has an EABI32/O32 link incompatibility. See [Runtime TrueType fonts](RUNTIME_FONTS.md) for supported contracts and device-local prerequisites.
