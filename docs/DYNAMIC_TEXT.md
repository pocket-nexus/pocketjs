# CJK residency and prepared text

**`prepareText()` reserves and loads every glyph in a text batch before reporting
ready.** Music metadata and book chapters can arrive after the app was built.
The app chooses a resident common-character set and a budget; it holds a lease
for each title, chapter or prefetched page that must remain renderable.

## Configure residency

```ts
import { openFontArchive } from '@pocketjs/framework/fonts';

const font = openFontArchive({
  path: 'fonts/cjk.pjfa',
  slots: [2],                 // regular 16 px, also declared by the app's styles
  provider: 'companion',      // default; 'local' selects the PSP storage worker
  capacity: 768,              // extra source cells per slot
  maxBytes: 768 * 1024,       // extra source bitmap budget
  resident: [{ slot: 2, text: commonCharacters }],
});
```

`commonCharacters` can come from configuration, a PAK text asset or a provider
read. **The resident set loads before pending dynamic batches and remains pinned
until the archive is disposed.** Packaged glyphs do not consume streamed cells.
The native cache admits the union of scalar values held by all leases; repeated
characters and overlapping texts share cells. Each size uses its own font slot
and its own glyph cells.

The capacity is 1–4096 cells per slot. **All streamed source cells share a 2 MiB
native limit.** `maxBytes` can impose a lower controller budget. Cell cost is
width × height bytes, including source padding; the storage archive uses two
bits per pixel. `stats().bytes` reports reserved source bitmap bytes. Baked
atlases, their padding, lease metadata, offload buffers and GPU pages are outside
that counter. Leave room for those allocations in the app's memory budget.

A batch accepts up to 65,536 UTF-16 units and 4096 unique scalars. One controller
holds at most 32 batches, including resident sets. **A batch that cannot fit
enters error before any of its missing glyphs are requested.** It cannot wait
for eviction of a glyph that another live batch owns. Release a previous batch,
reduce the resident set, increase capacity within the byte limit, or split the
content into pages. A chapter's character count can exceed its unique-scalar
count because repeated glyphs share residency.

## Preload and reveal a text

```tsx
import { createSignal, onCleanup } from 'solid-js';
import { Text, View } from '@pocketjs/framework/components';
import type { TextResource } from '@pocketjs/framework/fonts';

const [title, setTitle] = createSignal<TextResource>();
function selectSong(filename: string) {
  title()?.dispose();
  setTitle(font.prepareText(filename, { slot: 2 }));
}
onCleanup(() => { title()?.dispose(); font.dispose(); });

<View class="h-[48]">
  <Text
    resource={title()}
    class="text-base text-white"
    fallback={() => <Text class="text-base">Loading title...</Text>}
    errorFallback={() => <Text class="text-base">Title unavailable</Text>}
  />
</View>;
```

**`Text resource` uses the framework's `ResourceBoundary`.** Pending content
shows `fallback`; ready content appears as one text value; errors select
`errorFallback`. There is no per-character reveal timer. A parent `View` can
reserve layout while the fallback and text have different sizes. The immutable
prepared value supplies both text and font slot, so a selected filename
cannot borrow an old batch's ready flag. `children` and a conflicting
`style.fontSlot` do not override that prepared value.

`prepareText()` works before a component is mounted. It returns a
framework-neutral `TextResource` with `state()`, `subscribe()` and `dispose()`.
The state is `ResourceState<PreparedText>` and can feed a `ResourceBoundary` that
reveals several rows together. For a reader, prepare the complete chapter,
subscribe to its state, then render pages from the ready value. Keep the lease
until the chapter and its prefetched views no longer need it. The Solid `Text`
adapter subscribes and unsubscribes with its owner; **the caller owns disposal
of the batch**. Other UI adapters can consume the same state and subscription.

**Ready glyphs stay pinned even when their text is offscreen.** Releasing a batch
allows eviction of cells no other lease holds. Cached cells can serve later
batches without I/O. Drawing and measurement do not create glyph requests.
Ordinary `Text` without a resource can use baked or resident glyphs; it does not
initiate streaming for a missing scalar.

A missing glyph fails the whole batch. This keeps a title with an unsupported
character from being reported as complete. I/O and malformed replies have at
most three attempts per demanded glyph; failure enters error and withdraws
that batch's pins. `reload()` invalidates leases to pending, reopens the archive
and retries them. A provider session change does the same. Generation and
request checks reject replies from a superseded session. `dispose()` invalidates
consumers before releasing their native pins. `pause(true)` stops new glyph
requests; already submitted replies may complete.

## Offload providers and archive format

The app manifest requires `text.glyphs.baked`, `text.glyphs.streamed` and
`io.offload`. PSP implements the batch operations. WASM exposes them for host
adapters and injected-provider tests; other native hosts need these operations
before they can advertise streamed glyph support.

**Both providers speak `font.open`, `font.glyphs`, `font.stats` and `font.close`
through `io.offload`.** The companion's `createFontArchiveProvider()` accepts an
exact mapping from provider-relative paths to granted archive files. Run it in
the existing companion Worker using `dispatchOffload()`. Export:
`@pocketjs/framework/fonts/provider`. File reads, index lookup and checksums
belong to the worker. The UI scheduler holds at most two requests and applies
at most one delivered reply per frame. Replies contain at most four cells and
fit the 2500-character payload / 4096-byte record limits.

`provider: 'local'` uses the PSP's storage worker under
`ms0:/PSP/COMMON/pocketjs/`. That worker has eight 4 KiB index-cache pages, fixed
request/reply buffers and a 256 KiB stack. It does not call QuickJS, the UI core,
GE or the single-thread allocator. Absolute paths and parent traversal are
rejected. A companion connection is not required for this provider.

```sh
bun tools/font-archive.ts --font=MyFont.otf --out=cjk.pjfa --slots=2
```

**PJFA/1 stays outside the embedded PAK.** It contains a SHA-256 content identity,
strike geometry, sorted scalar indices, FNV cell checksums and packed coverage.
Checksums detect cell damage; provider path grants define access. A strike must
match the baked slot's baseline, line height and density. The format supports
density 1 and scalar coverage. It does not add shaping, bidi, grapheme editing,
Unicode line breaking or language-selected Han variants. See
[Text resources](TEXT_RESOURCES.md) for the separate editor glyph service.

## Text Lab

```sh
bun tools/text-lab-assets.ts .pocket-build/text-lab
bun tools/pocket.ts build --target psp --manifest apps/text-cjk/pocket.json --project-root . -- --release
bun tools/text-lab-companion.ts --assets .pocket-build/text-lab --usb /path/to/host0
```

The USB companion uses the app's existing offload worker. The companion CLI
also accepts `--address` and `POCKET_COMPANION_KEY` for hosts with the paired
network transport. PSP uses the USB path. For local mode, copy `fonts/` and the
four generated text files to `ms0:/PSP/COMMON/pocketjs/`. The app starts in
companion mode; Square switches provider.

The generated common set, song filenames and chapters are read at runtime.
They contain simplified and traditional Han, Japanese kana, rare glyphs such as
`龘靐齉麤`, and supplementary-plane `𠮷`. They are absent from the app's baked
atlas. Each document file fits the local 1536-byte read budget; larger books
need an application document paging capability before chapter preparation.
The fixture font's source and license are in `assets/fonts/NotoSansCJK-Demo.md`.
Generated full archives, binaries and captures remain under `.pocket-build/`.

**L/R cycles through the music library and two chapters.** The library presents
four tracks per page with filenames, album labels, formats and durations.
Up/Down selects a track; Triangle changes pages. `songs.txt` contains one track
per line, with tab-separated filename, duration and ASCII album label fields.
This is a metadata browsing demo; it does not play audio.

**Pending content shows an animated skeleton.** Music uses cover and label
placeholders; chapters use paragraph lines. The opacity loop runs on the UI
thread. One batch gates the entire music list through `ResourceBoundary`;
chapters use `Text resource`. Both reveal after all required glyphs are ready.
Circle pauses glyph loading and Cross reloads the files and font. The app uses
768 streamed cells at 16 px and pins its common set.

Start enters or leaves diagnostics. Within diagnostics, L/R selects cache
pressure, over-budget text or a missing glyph. In the pressure case, Cross
advances to a new 320-character set while retaining the cache. The over-budget
and missing-glyph cases display `EXPECTED` only when the returned error matches
the injected condition. Provider errors remain errors. These cases do not
appear in the library/reader navigation.

Acceptance checks:

1. Pause on a new chapter: the skeleton keeps animating and controls work.
   Resume: the first content frame contains the complete visible page.
2. Page through a ready chapter: no additional glyph requests occur.
3. Change selections during loading: no old chapter or partial title appears.
4. Reload pressure sets until eviction occurs, then revisit a chapter and
   compare glyph identity. Common glyphs remain resident.
5. Enter diagnostics and select the over-budget and missing-glyph cases:
   the expected rejection replaces the whole content, with no unbounded retry
   loop. Start returns to the library.
6. Edit a text file after building and reload. Disconnect/reconnect the provider
   and verify fallback, recovery and the absence of stale content.

```sh
bun tools/wasm.ts
bun test tests/font-config.test.ts tests/font-archive.test.ts tests/text-batch.test.ts tests/text-cjk.test.ts
bun test --conditions=browser tests/renderer.test.ts
cargo test --locked --manifest-path engine/core/Cargo.toml
```

The `devtools-offload` Cargo feature enables mailbox-driven device replay.
**The debug mailbox performs main-thread host0 I/O**; use a normal build for
performance measurements. Captures and per-run logs belong under
`.pocket-build/validation/`.

## Packaged fonts and GPU pages

`fonts.json` beside the app entry still declares baked coverage:

```json
{
  "fallback": ["fonts/MyCjkFont.otf"],
  "characters": "你好気迫",
  "characterFiles": ["labels.txt"],
  "ranges": ["U+3040-30FF"]
}
```

Paths are relative to that file. Character files have a 4 MiB limit; the declared
set has a 65,534-scalar limit before adding ASCII and the missing-glyph cell.
Declaring a scalar cannot supply an outline absent from the source font.

The PSP GE renderer keeps **at most sixteen 64×128 ABGR4444 pages, 256 KiB of
pixels**. Page identities include slot, atlas revision and glyph range. Source
stride, ink width and logical advance remain separate. Pages referenced by
queued GE commands stay immutable until `sceGuSync`. When every GPU page is
pinned, rendering uses CPU source coverage. Source leases preserve glyph
identity across that GPU replacement policy.

## Migration from #426

Remove `blockMs` and replace draw-triggered loading with `prepareText()` leases.
Use `Text resource` or a `ResourceBoundary` for atomic presentation. Set
`provider: 'local'` when retaining device storage; the new default is companion.
The external PJFA/1 archive format is unchanged. The former editor-oriented
`text.glyph` image cache and PSPMAN's separate PJPF/1 format are not converted by
this change.

## Adopting the shared API from a downstream font extension

**PJPF/1 and PJFA/1 identify different archive layouts and their versions.**
They are not text encodings or Unicode coverage levels. PSPMAN's public packages
contain PJPF/1; this provider reads PJFA/1. Renaming the file does not convert it.

Regenerate PJFA from the licensed source font with the current compiler. Select
the strikes the app uses, declare those slots in its baked styles, and keep the
archive outside the PAK. Set `provider: 'local'` for a standalone PSP player, or
grant the archive to a companion Worker. Both paths use the same batch API.
An adapter for an existing archive would need to supply validated cells through
the provider protocol; it would preserve defects in the input bitmaps.

| Product requirement | Shared mechanism |
| --- | --- |
| Names and tags discovered after build | Pass decoded Unicode strings to `prepareText` |
| Common UI characters stay available | Configure `resident` per slot |
| A list appears as one complete selection | Prepare the visible rows together; reveal through `ResourceBoundary` |
| Now Playing survives library scrolling | Keep its lease while releasing old list windows |
| Reader pages remain stable | Hold a chapter lease, or bounded page leases when its union exceeds capacity |
| Reopen, reconnect and retry | Invalidate to pending with `reload`; use error fallback on failure |
| No computer during playback | Select the PSP local storage worker |

**The active glyph union determines residency, not the total track count.** A
library can keep metadata for 1000 tracks while holding leases for the current
title, visible list and a prefetched window. Count the union across those leases
and the resident set before choosing capacity. Each strike consumes its own
cells; every slot shares the native byte limit. The loader does not decode ID3
tags, repair malformed Unicode, perform shaping, or create missing font outlines.

### Regression coverage without a downstream source tree

`tests/text-batch.test.ts` drives the production companion reader, batch
controller and WASM core with 1000 runtime titles at regular 12/14/16/24 px and
bold 12 px. Each strike uses a 32-cell cache, a pinned `気迫Ａ１𠮷` title and a
resident common set. It compares every five-row page against a baked reference,
then revisits the first page after eviction. Embedded ASCII keeps its original
coverage; streamed reference cells use the archive's two-bit coverage.

`tests/font-archive.test.ts` compares those CFF glyphs against source contours
with explicit closing edges. **A checksum proves byte integrity; it does not
prove that the baker drew the intended shape.** The contour regression fails
when implicit closure is removed. The built Text Lab test covers atomic reveal,
loading animation, cancellation and recovery. Native tests check actual vector
capacity after slot detach and retry after a partially overwritten index page.

PSPMAN's [public report #58](https://github.com/obsoletesony/PSPMAN-Issues/issues/58)
describes `迫` rendering incorrectly in Alpha 4. Its diagnostic log reports zero
capacity, decode and read failures. Comparing the published Alpha 4 and Alpha 5
PJPF files finds the same 6790 codepoints. At 16 px, the historical PocketJS
baker before `1446d244` reproduces Alpha 4's `気迫Ａ１` coverage byte for byte after
four-bit quantization; adding contour closure reproduces Alpha 5. The current
baker also matches Alpha 5 for those cells. This isolates a reproducible asset
generation defect without the private application source. The
[Alpha 5 release notes](https://www.obsoletesony.com/pspman/releases) report a
Japanese rendering improvement. This comparison does not establish which
private commit changed PSPMAN or validate its metadata and playback pipeline.

Rebuild old assets when adopting the shared API. Mainline already contains the
contour closure fix; changing residency or increasing a cache cannot repair an
incorrect bitmap stored in an old archive. **These tests validate the shared
font functionality; downstream application acceptance remains a separate run.**
