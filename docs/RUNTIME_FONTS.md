# Runtime TrueType fonts

**Runtime text uses one worker-produced layout for measurement, painting, wrapping, truncation and editing positions.** The `pocket-text` Rust service uses the shaping engine shared with its existing Cosmic Text dependency and FreeType grayscale rasterization. The UI receives geometry and coverage records. It does not open fonts or run a font parser or rasterizer.

## Font sources and instances

Add immutable font assets to an application's `fonts.json`:

```json
{ "runtime": ["../../assets/fonts/Inter-Regular.ttf"] }
```

The compiler stores these files as `text:font.N` PAK entries. Desktop and web text workers load the entries during worker initialization. The compiler tracks the source files as build inputs. The `fallback` field in `fonts.json` continues to describe baked atlas coverage; runtime fallback belongs to the font instance.

```tsx
import { Text } from "@pocketjs/framework/components";
import { openRuntimeFont } from "@pocketjs/framework/fonts";

const font = openRuntimeFont({ family: "Inter", size: 24, fallback: [] });
const label = <Text font={font} textLayout={{ width: 240 }}>AV office</Text>;
```

**The first version accepts static TrueType outlines and grayscale coverage.** Font collections, CFF outlines and variation fonts have no runtime instance. Size ranges from 4 to 256 logical pixels in steps of 1/64 pixel. Raster density is 1. Font weight is selected by loading a face, rather than synthetic bold. Color is a draw property and is absent from shaping, layout and bitmap cache keys.

`runtime.fonts` returns the names of granted faces. The `family` option accepts a full face name or a family alias that resolves to one loaded face; an ambiguous family alias fails. `fallback` is a required ordered array of those names. Fallback selection covers a complete grapheme. There is no system font lookup. Missing coverage makes `prepareText()` fail. The worker's lower-level shaping response reports its missing glyph count.

**Instance and glyph IDs are immutable within a worker session.** An instance identifies the primary face, fallback order and size. A glyph ID identifies the selected face, size and shaped glyph index. An instance's IDs never name GPU slots. Reconnection replaces the client's identity namespace and fences pending replies and leases.

## Geometry and resources

The contract in `contracts/spec/runtime-text.ts` defines source ranges in UTF-16 units, glyph positions, row baselines and caret stops. Glyph records refer to shaped glyph IDs, including ligatures and combining marks. Line width changes reuse cached shaping; the worker computes new line breaks. Bitmap arrival, bitmap eviction and GPU eviction have no effect on geometry.

The service uses Unicode grapheme boundaries and bidirectional levels. Line breaking uses word, whitespace, hyphen and CJK opportunities, with a cluster boundary for overlong words. This is not a complete Unicode line-break implementation. A ligature's caret positions divide its advance between grapheme boundaries; the service does not read GDEF ligature caret tables. Cluster context is retained within a shaping request. The first version does not implement paragraph-scale incremental reshaping around an edit.

The editor selection helper emits one rectangle per row. Discontiguous selection regions within a mixed-direction row are outside the first version.

**A prepared lease becomes ready after its complete shaped glyph set is resident.** Use the existing prepared-text flow:

```tsx
const prepared = font.prepareText("AV office", { width: 240 });
// Read state() or subscribe(); render after state().status becomes "ready".
const state = prepared.state();
const label = state.status === "ready" ? <Text preparedText={state.value} /> : null;
// Dispose the lease when its consumer no longer needs the text.
prepared.dispose();
font.dispose();
```

`layout()` exposes geometry before coverage has finished. `textCaret`, `textHitTest`, `textSelection` and `textMoveCaret` read that geometry. Note's optional runtime font mode uses the same document layout for its painted text, caret, selection, composition span, click position and grapheme deletion. Geometry-dependent input waits for the current revision's layout. Its baked mode retains the existing behavior.

## Budgets and upload ownership

| Storage | Default budget | Ownership |
| --- | ---: | --- |
| Worker shaping cache | 1 MiB | Text, clusters, advances and grapheme boundaries |
| Worker line-layout cache | 1 MiB | Width-dependent rows, positioned glyphs and caret stops |
| Worker gray8 bitmap cache | 2 MiB | FreeType glyph coverage |
| Client gray8 bitmap cache | 2 MiB per font controller | Received coverage awaiting upload or reuse |
| Core texture page storage | 4 MiB per UI | Power-of-two white RGBA glyph renditions |

Worker `runtime.budget` accepts separate `shaping`, `layout` and `bitmap` byte limits. A reduction below pinned shaping or layout storage fails. Client `bitmapBytes` and `gpuBytes` control coverage admission and texture residency. Core texture limits include padding and have a 16 MiB ceiling. Font sources, FreeType working storage, the runtime heaps and JavaScript objects are additional memory; the cache counters are not a process-memory measurement.

**Texture upload is per glyph.** A glyph completion creates its own texture generation and emits `TEX_QUAD` through the existing renderer. It does not rebuild a font atlas or increment its revision. Backends retain or synchronize submitted GPU resources before texture storage can be reused. WGPU tests cover replacing a texture cache entry after encoding and before submitting the older draw. PSP's frame fence precedes the next guest update.

CPU bitmap residency and GPU texture residency have separate eviction decisions. Live leases pin their union. Released glyphs remain eligible for reuse until cache pressure. Admission failure returns an error and never publishes a partial ready batch. The controller bounds concurrent raster reads and work per frame. Text requests are limited to 2,048 UTF-16 units, and transport records remain capped at 4,096 bytes; a request can reach the byte limit before the unit limit. Glyph coverage is capped at 65,536 pixels with dimensions at most 512. These limits reject work instead of moving parsing to the UI thread.

The existing point-sampled atlas and streamed font-archive paths remain available. A Text without a runtime font or runtime prepared value uses its existing font slot.

## Builds and platform validation

Native workers require FreeType development headers and `pkg-config`. `bun tools/text-wasm.ts` requires Emscripten and builds the Rust module plus `pocket_freetype.js` and `pocket_freetype.wasm`. The Emscripten FreeType port controls its source revision. Both modules execute in the same text worker, using separate linear memories. Static web deployments must serve all three generated files and the worker adapters.

Portions of this software are copyright © 2024 The FreeType Project (https://www.freetype.org). All rights reserved. The distributed worker includes `FreeType-LICENSE.txt` under the FreeType License.

```sh
bun tools/test.ts --stage="runtime text"
cargo test --locked --manifest-path engine/crates/pocket-text/Cargo.toml
cargo test --locked --manifest-path engine/Cargo.toml -p pocket-ui-surface -p pocket-ui-wgpu
bun tools/runtime-text-bench.ts
bun tools/runtime-bitmap-bench.ts
```

The PSP companion accepts the new runtime methods through the existing paired transport:

```sh
bun tools/text-provider.ts --pak dist/APP.pak --font assets/fonts/Inter-Regular.ttf \
  --usb /path/to/host0 --app APP_ID
```

Use `provider: "companion"` on the runtime font for PSP. The local PSP offload service has no runtime TTF capability and does not fall back to parsing on the UI thread.

`bun tools/build.ts runtime-note-main` builds the proportional-font editor example. The browser playground URL is `/?demo=runtime-note-main`; it creates a text worker for each loaded app. This example opens the runtime-font edit surface. Typing and pointer selection use Note's desktop input service; hosts without that service show the document. The Note preview keeps its markdown styling and baked font slots.

**Validation distinguishes the shared renderer from a device run.** Automated coverage exercises the native Rust service, a WASM service in a real Bun Worker, the shared WASM software renderer, the native QuickJS surface, and WGPU on Apple M4 Metal. The PSP companion test uses its USB packet protocol and generation checks on the development host. No PSP hardware or PPSSPP display run was available for this change.

The FreeType C bridge cross-compiles to MIPS2/o32 against the pinned PSP SDK; its text section is 1,312 bytes. Linking the supplied `libfreetype.a` with the project's LLVM linker fails with `symbol (5) has invalid binding: 0` in several FreeType objects. The SDK's GNU linker reports that the archive uses EABI32 while the project uses O32. Device-local support needs a FreeType rebuild with the project's ABI flags, a bounded font/raster worker, and device measurements of heap usage and frame fences. The companion remains the PSP route for this version. See [performance and acceptance](RUNTIME_FONT_PERFORMANCE.md) for measured latency, memory, upload counts and remaining limits.
