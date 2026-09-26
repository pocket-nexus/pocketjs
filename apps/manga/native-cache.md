# Prepared resources on 3DS storage

Pocket Manga installs immutable images on its SD card and loads them through
`apps/manga/pack-client.ts`. **File access and zlib decoding run on a
native worker.** Guest JavaScript submits an indexed address and receives a
bounded image ticket. It never opens a file, parses a directory or copies pixels.

```ts
const tiles = createPackedImageCollection(runtime, {
  key: (tile: { pack: string; entry: number }) => `${tile.pack}/${tile.entry}`,
  pack: tile => ({ name: tile.pack, entry: tile.entry }),
  width: 256, height: 256,
  maxEntries: 28, maxViews: 2, maxDemandsPerView: 24,
  fallback: { client: remote, method: "manga.image", payload: tile => `${tile.pack}/${tile.entry}` },
});
const visible = createResourceView(tiles, { demand: visibleTiles });
```

The collection owns one cache regardless of storage. Views merge demand,
priority and pins; withdrawal cancels delivery, completion releases staging,
and eviction frees the native texture. A missing or corrupt local record can
use the optional paired-desktop fallback. A host without `io.resource-pack`
uses that fallback directly. Loaders that report a disconnected client refuse
admission so they do not consume the shared scheduler's active slots.

Declare `io.resource-pack` in the app manifest's `enhances` list. The 3DS build
includes the worker only when the resolved profile enables this capability.
PSP and other hosts currently have no local pack implementation.

## Installation and image preparation

`apps/manga/pack-format.ts` exports `prepareTiledRGB565` and
`createResourcePack(path, count)`. The desktop converts core RGB565 pixels to
PICA's channel order, vertical origin and 8×8 Morton ordering, then compresses
each entry with zlib. The writer completes a temporary file before renaming it.
Install the resulting file at
`sdmc:/pocketjs/assets/<runtime-slot>/<name>.prp`. The slot is the first 16 hex
characters of SHA-256 of the app ID. Names contain 1–48 lowercase ASCII letters,
digits or hyphens. Upload to a temporary path and verify before activation;
installed names identify immutable contents and must change when contents change.

**A 256×256 prepared image occupies 128 KiB of GPU texture storage.** The host
copies its tiled RGB565 bytes without the normal RGBA8 expansion or pixel
conversion. The core retains a generation-tagged descriptor with dimensions,
without a second CPU pixel copy. The renderer adopts or retires storage
after its previous GPU work completes. Manga configures one image
materialization per frame across the local and desktop paths.

The worker owns eight 128 KiB result slots, one 128 KiB + 128 byte compressed
scratch buffer, four open files and a 32 KiB thread stack. Zlib uses bounded
per-record working storage. **No whole book or whole index is loaded into
RAM.** A request reads one 24-byte index entry and its bounded payload.
Submission and delivery each allow one record per frame. Saturation rejects
admission; it does not wait. Realm reset fences obsolete jobs by generation.
Canceled reads may finish on the worker, but cannot reach the old view.

## Format and diagnostics

PRP1 version 1 uses a 64-byte little-endian header and up to 65,536 indexed
24-byte entries. Header fields are magic, version, count and total file length;
remaining bytes are zero. Entry fields are offset, compressed length, raw length,
CRC32, kind, then 16-bit width and height. Files are limited to 2 GiB minus one
byte for the 3DS stdio seek range. Every entry is independently zlib compressed.

Kind 1 carries at most 2,500 UTF-8 bytes of application metadata, with zero
dimensions. `resourcePacks()?.request("pack.read", "manga-index/0", callback)` reads
it through the same bounded async service. The serialized response must fit
the 4,096-byte offload record envelope; excessive escaping produces an error.
Kind 2 carries tiled RGB565 images with power-of-two dimensions from 16 to 256.
CRC32 detects damage; it is not an authentication mechanism.

`resourcePackStats()` reports completed reads, failures, cumulative IO/decode/
upload microseconds and maxima. These counters separate SD and codec time from
GPU upload time; they do not measure full visible-tile latency or frame rate.
Compare identical camera routes and cache budgets on hardware before claiming
a latency or frame-rate improvement.
