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

Native workers require FreeType development headers and `pkg-config`. `bun tools/text-wasm.ts` requires Emscripten and builds the Rust module plus `pocket_freetype.js` and `pocket_freetype.wasm`. CI uses the official Emscripten SDK at version 5.0.5, whose FreeType port fixes its source revision. The SDK cache must permit writes for port compilation; the read-only cache in some distribution packages cannot build this port. Both modules execute in the same text worker, using separate linear memories. Static web deployments must serve all three generated files and the worker adapters.

Portions of this software are copyright © 2024 The FreeType Project (https://www.freetype.org). All rights reserved. The distributed worker includes `FreeType-LICENSE.txt` under the FreeType License.

```sh
bun tools/test.ts --stage="runtime text"
cargo test --locked --manifest-path engine/crates/pocket-text/Cargo.toml
cargo test --locked --manifest-path engine/Cargo.toml -p pocket-ui-surface -p pocket-ui-wgpu
bun tools/runtime-text-bench.ts
bun tools/runtime-bitmap-bench.ts
```

The PSP runs the shared Rust text service and FreeType in its device-local worker. **`provider: "local"` needs no companion or pairing.** The worker loads `text:font.N` entries from the app's PAK. The UI copies bounded request and reply records; it does not read or parse fonts.

```ts
const font = openRuntimeFont({ family: "Inter", size: 18, fallback: [],
  provider: "local", bitmapBytes: 128 * 1024, gpuBytes: 512 * 1024 });
```

The local worker also accepts `runtime.load` with `{"path":"fonts/Inter-Regular.ttf"}` through `offload("local")`. The path resolves below `ms0:/PSP/COMMON/pocketjs/`. It must contain at most 127 ASCII letters, digits, `/`, `.`, `_` or `-`, with no leading slash or `..`. The worker checks file size against the remaining source budget before allocating or reading the font. `runtime.fonts` reports granted face names and PSP limits; `runtime.memory` reports worker/UI thread IDs and private-heap residency.

| PSP local limit | Value |
| --- | ---: |
| Private worker heap | 4 MiB |
| Source TTF bytes | 1 MiB total; FreeType's copy is included in a 2 MiB source-residency cap |
| Faces / instances / stable glyph IDs | 4 / 32 / 4,096 |
| Text per request / shaped glyphs | 512 UTF-16 units / 2,048 |
| Shaping / layout / gray8 bitmap caches | 64 KiB / 64 KiB / 128 KiB |

**The worker has its own allocator and free lists.** The UI reserves one backing block before thread creation. Rust and C allocations on the local thread use that block; FreeType allocations cannot use the UI heap. Cache limits return protocol errors and cannot be raised above the PSP caps. A private-heap OOM takes the provider offline and preserves the UI heap. Large full CJK fonts can exceed the 1 MiB source cap; use a static subset or an explicit companion provider for them.

The companion remains available through the existing paired transport:

```sh
bun tools/text-provider.ts --pak dist/APP.pak --font assets/fonts/Inter-Regular.ttf \
  --usb /path/to/host0 --app APP_ID
```

Use `provider: "companion"` to select that service. A local error never changes the provider or runs parsing on the UI thread.

`bun tools/build.ts runtime-note-main` builds the proportional-font editor example. The browser playground URL is `/?demo=runtime-note-main`; it creates a text worker for each loaded app. This example opens the runtime-font edit surface. Typing and pointer selection use Note's desktop input service; hosts without that service show the document. The Note preview keeps its markdown styling and baked font slots.

**Validation distinguishes emulation from physical hardware.** Automated coverage exercises the native Rust service, a WASM service in a real Bun Worker, the shared WASM software renderer, the native QuickJS surface, and WGPU on Apple M4 Metal. PSP EBOOT runs in PPSSPP IR and JIT modes verify offline TTF/CJK rendering, a TTF read from `ms0:`, distinct UI/worker threads, bounded private-heap use and cache-budget refusal while frames continue. The two CPU modes produce matching final pixels. Physical PSP hardware was not connected for this validation.

`tools/psp-freetype.ts` builds a SHA-512-verified FreeType 2.13.3 source archive with the project's MIPS2/O32/noabicalls flags. It enables the TrueType, SFNT and gray renderer modules. The SDK's EABI32 FreeType archive is not linked. The PSP target uses one ELF LOAD segment, and `tools/psp-load-image.ts` checks the ELF/PRX mapping and module-info pointer after packaging. This prevents segment-alignment gaps from corrupting the PRX image. See [performance and acceptance](RUNTIME_FONT_PERFORMANCE.md) for measurements and reproduction commands.
