# Runtime font optimization investigation

**Cold visibility, resident rendering and diagnostic overhead have different causes.** This investigation uses revision `e9e8fcc`, Apple M4/macOS, Bun 1.3.14 and Rust 1.93.0. It adds profiling tools and isolated prototypes. Production scheduling, filtering and memory budgets retain their current behavior.

Raw reports, isolated sources, binaries and build identities remain under ignored `.pocket-build/validation/font-optimization/`. These measurements do not establish physical PSP performance.

## Processing time and delivery delay

The native service benchmark runs 60 cold samples per case and 660 edits. The WASM benchmark uses 20 fresh workers per cold case and 200 edits. Worker startup, UI frames and GPU work are excluded from the service measurements.

| Work | Native median | WASM worker median / p95 |
| --- | ---: | ---: |
| Shape 256 new Han, 16 px | 0.129 ms | 3.12 ms median |
| Lay out those glyphs | 0.010 ms | 0.78 ms median |
| Glyphs, cache and encoding, 256 Han | 1.991 ms | 12.95 ms median, including 256 sequential requests |
| Complete 256-Han service exchange | — | 19.18 / 20.11 ms |
| Four glyphs, 128 px | 0.351 ms glyph work | 6.91 / 7.30 ms complete exchange |
| Resident edit service exchange | 0.026 ms | 0.948 / 1.970 ms |

**The current 60 Hz controller takes 130 frames to reveal 256 Han glyphs.** A three-run repeat gives 2,339 ms median first-visible latency. It makes 82 requests: one font instance, one prepare, 29 layout pages and 51 glyph batches. Worker processing intervals total about 43 ms; the median glyph-batch round trip is below 1 ms. Geometry alone takes about 1,128 ms to reach the client despite a single worker layout computation.

`offload.step()` receives replies and submits queued requests before the text controller plans its next work. A request created by that controller waits until the next frame to be submitted. Replies then wait for a frame-boundary delivery. Layout pages have fixed limits of 16 glyphs or 24 carets even when the record has spare space. Glyph coverage uses 1,024-byte pages inside JSON/base64. These mechanisms account for most of the visibility delay in this workload.

The following isolated controller experiments preserve the text, pixels, whole-batch readiness, stable IDs, eight-ticket queue, two-submission ceiling and 4,096-byte record bound. Each scenario has three runs; all final pixels and every edit's pixels match the production path.

| Controller | 256 Han first visible / frames | Four 128 px glyphs | Resident edit median |
| --- | ---: | ---: | ---: |
| Production | 2,339 ms / 130 | 1,013 ms | 37.7 ms |
| Receive, plan, then submit in the same frame; one reply/frame | 1,760 ms / 98 | 939 ms | 18.6 ms |
| Same phases; two replies/frame | 1,336 ms / 74 | 532 ms | 19.1 ms |
| Same phases and two replies; fill layout pages to their byte limit | 980 ms / 55 | 537 ms | 19.0 ms |

The last prototype reduces requests from 82 to 63 and geometry delivery to 217 ms. It adds worker-side aggregation overhead, yet lowers first-visible latency by **58%**. It retains 59,936 bytes of client gray8, 255,488 core texture bytes and 256 glyph uploads. The gains come from scheduling and packet count, without reducing coverage quality or dropping lease guarantees.

Two replies per frame require a matching host contract: the PSP and web adapters have their own delivery limits. A production implementation must cap both bytes and work per frame, preserve session fencing, and increment deadlines once per frame. Calling the existing `step()` twice is not an equivalent fix.

The 16 KiB/frame upload phase adds about sixteen frames after the 256-Han bitmap batch is complete. Uploading admitted resources while further bitmaps arrive can overlap this work, while withholding the ready state until the whole batch is resident. That overlap has not been implemented or timed here. A worker-side glyph-size/admission response could also reject a small client budget before transferring all layout pages.

## Resident rendering

**There is a real renderer regression after all fonts and glyphs are resident.** The renderer benchmark constructs a baked atlas from the same FreeType gray8 bytes used by runtime textures and uses identical positions. Both paths produce identical pixels. It forces a complete redraw, removing font loading, shaping, network and scheduling from the timed interval.

| Resident 16 px glyphs | Baked coverage path | Current runtime path | Isolated zero-weight sampling path |
| --- | ---: | ---: | ---: |
| 128 Han | 0.106 ms | 0.556 ms | 0.307–0.311 ms |
| 256 Han | 0.186–0.189 ms | 1.131 ms | 0.604–0.615 ms |

The runtime path emits an RGBA `TEX_QUAD` for each glyph. Software `sample_linear` fetches four neighbors and blends four channels even when both interpolation weights are zero. The prototype returns the first texel for that case and preserves the filtering path for other coordinates. It reduces this workload's resident draw time by **44–46%**, passes 147 core tests, and has zero byte differences across 24 comparisons covering fractional translation, clipping, tint/alpha, scales 0.75/1/1.25/2 and rotations 0/13/45 degrees.

A global nearest-filter variant is faster but changes 1,203 bytes in the first fractional-position control. **Disabling filtering for every runtime glyph is not an acceptable substitute.** The zero-weight branch is the lower-risk implementation candidate. A dedicated coverage/mask draw path could remove further RGBA sampling and conversion work; that path needs its own cross-renderer conformance tests.

The measured sampling gain applies to the shared software rasterizer. PSP's GE and native WGPU do not execute that software sampling function. Their relevant renderer work is texture representation, binding count and upload behavior.

## Texture storage and page allocation

The 256-Han workload has 59,936 bytes of gray8 coverage. Separate power-of-two RGBA textures occupy 255,488 bytes. Their total core upload time without pacing is about 0.346 ms on this host, but PSP rendering binds and flushes a texture for each distinct consecutive glyph.

Packing estimates below include a one-texel gutter. They are allocation/binding estimates, not measured GPU speedups.

| Representation | Storage | Consecutive binds for this glyph order |
| --- | ---: | ---: |
| Current individual RGBA textures | 255,488 B | 256 |
| Six 128×128 R8 pages, append in run order | 98,304 B | 6 |
| Six 128×128 RGBA4444 pages | 196,608 B | 6 |
| Two 256×256 RGBA4444 pages | 262,144 B | 2 |

**Page size and insertion order both matter.** Larger pages can consume more memory. Sorting glyphs by height and filling holes in earlier pages causes 102 binds for a six-page arrangement in this sample. Drawing order cannot be changed without considering overlapping glyphs and marks.

Native/WASM backends can evaluate single-channel textures. PSP can evaluate T8 indices with a shared white-RGB/alpha CLUT to retain 256 gray levels; RGBA4444 quantizes alpha and requires a quality decision. Page updates should upload changed regions or pages. Layouts must keep stable glyph IDs, with page locations resolved during drawing. Slot reuse must wait for the GPU frame that references the old contents to retire.

## Cache lookup cost

`Cache::find` scans entries by their string key. Pure bitmap hits depend on the insertion position of the glyph. Requesting the latest 256 resident glyphs, with no rasterization or eviction, gives the following native medians over 60 samples:

| Resident entries | Latest 256 hits |
| ---: | ---: |
| 256 | 0.226 ms |
| 1,024 | 0.975 ms |
| 4,096 | 3.028 ms |
| 8,192 | 6.098 ms |

The oldest 256 remain near 0.23 ms. The 4,096-entry case fits the default 2 MiB bitmap budget; the 8,192-entry case uses an 8 MiB configured budget and occupies 3.34 MiB. These cardinalities do not describe the PSP's 128 KiB cache.

Use stable glyph IDs as bitmap-cache keys, add keyed lookup for shape/layout entries, and maintain pinned-byte and eviction state instead of scanning every entry during reservation. Index storage must count toward the corresponding budget. The current glyph path reserves before insertion and inside insertion; one admission operation can avoid duplicated work.

Native and PSP workers retain a Rust font source and a second copy owned by the C bridge. Sharing immutable source bytes could remove that duplicate storage. [FreeType memory faces](https://freetype.org/freetype2/docs/reference/ft2-face_creation.html#ft_new_memory_face) require the source to remain alive until face destruction, so this needs an ownership change with drop-order tests. The current two-module WASM implementation has separate linear memories; it cannot share the Rust pointer through the same technique. This memory optimization has not been implemented or measured here.

## PSP measurement controls

The same saved EBOOT was run three times with and without its DevTools mailbox. A second build disables frame dumps and uses a 120-frame warm window; each condition also has three runs. Runtime fonts remain enabled in every case.

| Condition | Average / maximum UI work | Maximum frame interval |
| --- | ---: | ---: |
| Frame dumps and DevTools | 1.995 / 21.893 ms | 50.050 ms |
| Same EBOOT, DevTools disabled | 0.680 / 0.693 ms | 33.422 ms |
| Frame dumps disabled, DevTools enabled | 2.086 / 21.893 ms | 33.367 ms |
| Both disabled | 0.684 / 0.693 ms | 16.690 ms |

**The previous 22 ms warm peak came from diagnostic work in this scene.** DevTools performs synchronous file polling and telemetry; frame dumps affect pacing outside the measured UI-work interval. Draw plus render remains about 0.54 ms. These controls cover PPSSPP JIT/software GE, 38 resident glyphs and a static editor. They do not establish physical PSP performance or eliminate the cold-loading and editing delays above.

The local worker runs at lower priority than the UI (48 versus 32). Rust/C allocations query thread identity after the worker starts; ordinary QuickJS allocations use its direct UI-arena allocator. The allocator and 1 ms idle polling are later profiling candidates, rather than the first targets for this regression.

## Recommended implementation order

1. **Separate receive/plan/submit phases** without increasing the current one-reply budget. Add cancellation, reconnect, deadline and per-frame credit tests. The prototype halves resident edit delay.
2. **Add the zero-weight sampling fast path.** Keep filtered rendering for fractional and transformed samples; retain pixel conformance coverage.
3. **Index caches by key and maintain reservation accounting.** Guard memory budgets and stable IDs with pressure/lease tests.
4. **Fill bounded metadata pages, negotiate local transfer budgets, and overlap admitted upload with receipt.** Keep the companion's transport limits separate from local-worker capabilities. Explore binary/transferable local payloads to remove JSON/base64 and 1 KiB continuation overhead; this is an unmeasured architectural candidate.
5. **Introduce gray-mask pages and incremental subregion upload.** Validate page residency, frame retirement, padding, binding order and scaled/rotated glyph quality on each renderer.

For a PSP-focused implementation, prioritize the shared scheduling work and the T8/page/binding work; the software sampling branch belongs to the software-renderer track. The two-reply experiment must not be used as a PSP speedup estimate until its UI copy/decode budget is measured on that host.

Caching `FT_Set_Char_Size` alone has little benefit here: 60×20 C-level batches of 256 Han improve from 1.58155 to 1.57860 ms, about 0.19%. Large-glyph and interleaved-size results are unchanged. The variants match 4,888 bitmap/metric checks. [FreeType's size documentation](https://freetype.org/freetype2/docs/reference/ft2-sizing_and_scaling.html) describes active size state; the measured gain does not justify prioritizing this call over scheduling, rendering and indexing.

Reproduce the maintained profiling tools after building the normal core/text WASM artifacts:

```sh
cargo run --release --manifest-path engine/crates/pocket-text/Cargo.toml --example runtime_cost -- 60
bun tools/runtime-pipeline-profile.ts --repeats=3
bun tools/runtime-render-profile.ts
```

The pipeline tool is a profiling prototype and is not a replacement for `createOffloadClient`. The render tool accepts `--wasm=...` and `--reference=...` to compare isolated builds; its reports identify whether filtering controls match. Raw isolated C, PSP and sampling experiments are retained in the ignored investigation directory. Future before/after claims must use the same font bytes, coverage, size, positions, residency state, renderer and diagnostic settings.
