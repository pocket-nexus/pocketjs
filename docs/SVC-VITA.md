# SVC over WiFi — the Vita transport

The host service channel (spec ops 30–37: mailbox, side files, `.pkst`
video) was born on the PSP over PSPLINK's usbhostfs file share. The Vita has
no file share — it has WiFi. This document describes the Vita transport:
the **PKNT** wire protocol (contracts/spec/spec.ts "SVC WIRE protocol",
`engine/modules/media/src/wire.rs`), the RAM ring (`engine/modules/media/src/stream_rx.rs`),
and the host-side modules under `hosts/vita/src/` (`net.rs`, `svc.rs`,
`vid.rs`, `audio.rs`).

The guest contract does not change. An app that speaks the svc ops on PSP
speaks them unchanged on Vita: `svcOpen` is a non-blocking probe the app
retries, `svcPoll`/`svcSend` move JSON lines, `loadImgFile` resolves a side
file, `videoOpen/Tick/Texture/Close` present a `.pkst` stream. What changes
is what stands behind the ops.

## One connection, ordered

Everything rides **one TCP connection** (port 8622) framed as PKNT messages
(8-byte header: type, flags, u16 reserved, u32 len ≤ 256 KiB; unknown types
skip by length). One connection is a design decision, not a simplification:
TCP ordering is load-bearing. The `streamOpen` that resets the ring arrives
before the JSON line announcing the stream; the `file` pushes carrying
thumbnail IMG entries arrive before the `results` line that references
them — so the synchronous `loadImgFile` op hits a warm RAM cache and the
app's one-per-frame card loader works unchanged. These are exactly the
orderings the shared-filesystem transport got for free.

Discovery: `ux0:data/pocketjs/host.txt` (one line, `192.168.x.y:8622`),
when present, names the target directly — broadcast-hostile networks need
it. Otherwise the device listens for the companion host's once-a-second UDP
beacon (PKDB, port 8621); the datagram's **source address** plus its
advertised port is the connect target. A failed connect alternates the next
attempt between the two sources, so a stale `host.txt` — a Mac whose DHCP
lease moved on — degrades into beacon discovery instead of wedging the
supervisor forever (this failure was observed, twice, on hardware day).

## The RAM ring IS the file

The `.pkst` stream is not re-modeled for the socket. `stream_rx.rs`
maintains a **byte-exact `.pkst` file image in memory**: `videoSlot` and
`audioChunk` messages apply payload-first, `latestSeq`-after (the torn-frame
publication contract, verbatim), `streamMark` carries `bumpEpoch()`/
`markEnded()`. The same `pocketjs_core::stream` readers that parse the
PSP's file parse `RamStream::buf()` — one reader, one golden format, and a
cargo test that reconstructs the committed TS-written `.pkst` golden
byte-for-byte from wire messages.

## Threads

```
main/render thread            pjs-net (supervisor)          pjs-net-tx        pjs-audio
──────────────────            ────────────────────          ──────────        ─────────
svcOpen ── spawn once ──────▶ host.txt / beacon listen
svcPoll ◀─ line queue ◀────── TCP connect + handshake
svcSend ──▶ mpsc channel ────────────────────────────────▶ write_all frames
loadImgFile ◀ LRU file cache ◀ rx loop: CTRL → queue
videoTick ◀── RamStream ◀───────────  FILE → cache
  │ (stage newest slot,               SLOT/CHUNK/MARK → ring
  │  top up PCM ring ─────────────────────────────────────────────────────▶ sceAudioOutOutput
  ▼                            on error: mark ended,                          (blocking, BGM port,
vid::present() in the          1 s backoff, rediscover                         44.1 kHz stereo)
GPU-idle window
```

The 60 fps main thread never blocks on the network: its ops pop queues and
take short-held mutexes (worst case one ~130 KiB slot memcpy in
`videoTick`). All raw `sceNet` FFI lives in `net::init()` — module load,
`sceNetInit` with a 1 MiB static pool, `sceNetCtlInit`; everything after is
`std::net` over the newlib socket shims. An init failure (Vita3K has no
network stack) is remembered and final: `svcOpen` returns false forever and
the app stays on its connect screen — emulator golden runs never crash.

## The GXM discipline

`videoTick` only **stages** a validated frame. `vid::present()` commits it
to the plane texture inside the GPU-idle window — `Runtime::render` calls it
right after `begin_frame`, whose `ensure_rendering_done()` guarantees the
previous scene finished sampling. The commit path rewrites the existing
vita2d texture's pixels in place (`graphics::update_texture_in_place`);
the register/recycle path would allocate and drain GXM once per presented
frame at 24 fps. This is the PSP's GE race discipline, GXM edition: touch
texture memory only when the GPU provably is not reading it.

## Audio

`hosts/vita/src/audio.rs` is the PSP design with `sceAudioOut` in place of
`sceAudioCh`: one BGM port at 44.1 kHz, a dedicated output thread fed from
an in-RAM SPSC ring (~743 ms) over absolute frame counters, starvation
sleeps instead of queued silence, and the port opened **and released on the
main thread** (the channel-leak class of bug, once per platform is enough).
The integer upsampler (×1/×2/×4) keeps 22.05 kHz PSP-profile streams
playable; the Vita profile streams native 44.1 kHz.

## Diagnostics

`debugStats` (op 38) is wired: `hosts/vita/src/stats.rs` adds a `net`
section (rxBytes/txBytes/reconnects/slotsRx/fileEvicts) to the PSP shape,
plus the bundle FNV-1a64 for the stale-embed tripwire. Throughput tuning on
real hardware reads these as deltas over a window.

## Real-hardware verification checklist

Vita3K has no usable network stack — the transport is verified on hardware
only (UI stays covered by the Vita3K CPU-oracle goldens).

1. Install the VPK; run the companion host on the same LAN
   (`bun host/serve.ts` with the TCP transport; `.env` proxy as needed).
2. Beacon discovery connects in < 3 s; `host.txt` override also works.
3. Search returns rows with thumbnails (FILE pushes → warm loadImgFile).
4. Playback: plane updates at the negotiated rate, A/V in sync
   (`debugStats`: `slotsRx` per second, `audio.starved` flat while playing).
5. Pause / resume / seek: epoch bumps resync cleanly (`vid.epochs`).
6. Kill the host mid-play: frozen frame + app-level error, reconnect
   recovers a fresh session.
7. 30-minute soak: `fileEvicts` grows, memory stays bounded (LRU + fixed
   ring); no reconnect storms on a quiet LAN.
