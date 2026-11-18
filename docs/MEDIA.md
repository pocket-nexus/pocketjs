# Companion media playback

`media.playback` provides one native playback plane per guest realm. **The
capability names playback behavior; codec hardware is reported by live status.**
List the capability in the application's `features`, then import `mediaPlayer` from
`@pocketjs/framework/media`. A provider returns a `MediaSource` containing an
IPv4 address, port and one-use ticket. `open` submits that source to a worker.
`pause`, `volume` and `close` update bounded command state. `texture` returns a
handle for an ordinary `Image`; its placement can use either display.

`status` reports phase, media position, buffered audio duration, decoded,
presented and dropped frames, received bytes, maximum decoder call duration,
audio underruns, hardware availability, `h264` (the console has the H.264
decoder, known before any open), `audio` (false while a stream plays muted)
and an error. **Position follows the audio output sample clock.** A rejected source, unavailable decoder, lost
connection or malformed stream produces an error. Applications must display it
and offer recovery. Opening a new source cancels the previous generation.

## Transport and ownership

The paired `io.offload` channel carries commands and metadata. Compressed media
uses a separate TCP connection created by `@pocketjs/framework/media/provider`.
The provider issues a 64-character ticket with a 60-second expiry, admits it
once, and limits outstanding tickets plus active streams to four. Disconnect
aborts the producer. Closing the server closes authenticated and pending peers.

The current wire adapter accepts **512×256 H.264 access units with one VCL
slice per frame, without B-frames,
and 22,050 Hz stereo IMA ADPCM blocks**. Apps fit source aspect ratio in display
pixels before mapping into the decoder plane. They can choose bitrate within
the native packet limit. This format is an implementation of the generic
playback capability, not a capability ID.

The header's video codec field (offset 14) selects the picture format: **1 is
H.264 for the MVD decoder, 2 is PAL8 for consoles without one.** A PAL8
stream is a palettized picture of at most 512×256 at the texture's top-left
corner that both ends keep. Each packet carries a width, height, colour count
and zero, an RGB565 palette when the colour count is not zero (the first
packet must carry one), then runs that cover every pixel in row order: a
varint of unchanged pixels, a varint of changed pixels, and that many colour
indices. Varints hold 7 bits a byte, low bits first, at most three bytes. The
worker applies a packet to its reference picture, then expands the picture
into the frame ring, repeating the last column and row once for filtered
reads. When the ring is full it drops the expansion and keeps the reference,
so the next frame shown is exact. `createPal8Encoder`, `quantizeCube` and
`PAL8_CUBE` in the provider module produce such packets from RGB24 frames
with a fixed 252-colour cube and a 4×4 ordered dither, which keeps still
pixels identical between frames: **240×136 at 12 frames a second took 58 to
215 KB/s on an Old 3DS**, against 390 KB/s for whole frames.

Providers using x264's zero-latency tune must disable sliced threading and
select one encoder thread to preserve this frame boundary. `slices=1` alone
can produce several slices per frame. A hardware decoder receives each slice
as a complete frame; partial frame slices are outside this wire profile.

| Boundary | Limit |
| --- | --- |
| Header | 32 bytes, little-endian PKMV version 1 |
| Packet header | 16 bytes: kind, zero flags/reserved, byte length, PTS in milliseconds, zero reserved |
| H.264 access unit | 128 KiB; Annex B NAL delimiters |
| PAL8 packet | 128 KiB; picture at most 512×256, palette at most 256 RGB565 entries |
| Stereo ADPCM block | 1,024 sample frames, 1,031 bytes maximum |
| Producer credits | 8 packets; consumer acknowledges each processed packet with byte 1 |
| Native video queue | 16 decoded RGB565 frames |
| Native audio queue | 24 blocks, about 1.1 seconds |
| Initial audio prebuffer | 300 ms and at least one decoded video frame |
| UI command queue | 4 fixed slots, lock-free generation fencing |

Each audio block contains two channel headers (signed 16-bit predictor,
8-bit step index, zero reserved byte), followed by one byte per remaining
stereo sample frame: left nibble in the low bits, right in the high bits.
**Every block can decode without previous blocks.** The public
`@pocketjs/framework/media/audio` encoder and the Rust decoder in
`programs/psp/src/media_wire.rs` share vectors (`tests/fixtures/psp-runtime`). Video and audio records carry absolute PTS; a new seek stream starts
with parameter sets and an IDR frame.

**The Nintendo 3DS media worker lives with the 3DS product host in
pocket-nexus/pocket-shell**: its sockets, the MVD H.264 decoder, ADPCM
expansion and NDSP output. A host renderer transfers at most one RGB565
frame into a texture after the previous graphics frame retires, and the UI
does not wait for network reads or video decoding.

An H.264 stream on a console without a hardware decoder yields a playback
error; the `h264` status field lets an app ask for PAL8 instead. A host
without an audio output plays the stream muted: audio packets are dropped,
the clock is the system timer from the first decoded frame (stopped while
paused), and `audio` in the status is false so the app can name the fix.

## PSP over the USB carrier

The PSP reads the same stream from the companion's USB carrier instead of a
socket: `media.open` sends the source's token in `media.req`, and the worker
reads the header and packets from `media.ring` in the PSPLINK share (the
"USB carrier" section of `docs/POCKET-LINK.md` in pocket-nexus/pocket-shell). The source's address and
port go unused. **The PSP takes PAL8 only**; `h264` is false in its status,
and a stream of another codec fails as unsupported.

`programs/psp/src/media.rs` runs one worker thread below the guest's
priority. It does every `host0:` read of the stream, applies PAL8 packets to
the reference picture (`media_wire.rs`), copies each picture into an 8-slot frame ring,
and decodes ADPCM blocks into the audio output's ring (one 44.1 kHz channel,
22,050 Hz doubled). **The worker reads no further than 400 ms of audio ahead
of the clock**, which bounds the frame ring and the reads; playback starts
when 300 ms is buffered, and again after an underrun. The clock is the audio
output's played position; without an audio channel it is the system timer
from the first picture, as on a 3DS without DSP firmware.

The plane is a **512×256 T8 texture** with a CLUT from the stream's palette.
Before each display list is encoded, the guest's thread expands the latest
picture whose time has come into it and commits it through
`Ui::update_texture_t8`, which keeps the storage a list in flight samples
until that list retires. The global allocator is single-threaded, so the
worker allocates nothing: it posts a picture size, and the guest's thread
allocates the reference picture and frame ring at the next frame.

## Shared interaction

`createMediaScrubber(seek)` keeps drag preview local. Begin and move change the
preview, commit issues one seek, and cancel issues none. Single-display overlays
and independent control surfaces can share this state machine.

`TextField` and `Osk` accept `surface` and `keyHeight`. Keyboard width, overlay
placement and touch hit queries use that surface. Modality blocks application
input until the keyboard closes. `createWasmUi().createAuxiliarySurface(w, h)`
and `renderAuxiliary()` expose the same separate roots and shared resources for
application tests and visual review.

## Service playback providers

**`createServiceClient(namespace)` owns service transport.** Companion commands
use `<namespace>.command`; an asynchronous `{ job }` reply is read through
`<namespace>.poll`. Mailbox and HTTP providers expose the same `send` and
`subscribe` methods. Pending requests have a frame deadline, and a session
change fails pending work before publishing an `offline` event. The service
opens its asset namespace when an image or stream is requested.

**`createMediaService(client)` owns one playback lifetime.** A `playing` reply
contains either a native media source or a frame-indexed stream, plus its frame
rate and position. The provider opens the decoder and exposes `texture()`,
`status()` and `volume()`. Applications send `play`, `pause`, `resume`, `seek`
and `stop` commands through this interface without reading host capabilities.

Native media pauses on the device and reports its audio clock. A companion
ring pauses through the service, advances through the host video plane, and
polls its provider for completion every 120 frames. Mailbox providers supply
completion events. Stop and disconnect close the decoder and invalidate
outstanding playback replies. Applications place the texture on their chosen
surface and render progress from the shared status.
