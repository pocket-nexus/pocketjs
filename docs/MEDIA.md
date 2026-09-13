# Companion media playback

`media.playback` provides one native playback plane per guest realm. **The
capability names playback behavior; codec hardware is reported by live status.**
Declare the capability in the manifest, then import `mediaPlayer` from
`@pocketjs/framework/media`. A provider returns a `MediaSource` containing an
IPv4 address, port and one-use ticket. `open` submits that source to a worker.
`pause`, `volume` and `close` update bounded command state. `texture` returns a
handle for an ordinary `Image`; its placement can use either display.

`status` reports phase, media position, buffered audio duration, decoded,
presented and dropped frames, received bytes, maximum decoder call duration,
audio underruns, hardware availability and an error. **Position follows the
audio output sample clock.** A rejected source, unavailable decoder, lost
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

Providers using x264's zero-latency tune must disable sliced threading and
select one encoder thread to preserve this frame boundary. `slices=1` alone
can produce several slices per frame. The 3DS adapter submits each slice to
MVD as a complete frame; partial frame slices are outside this wire profile.

| Boundary | Limit |
| --- | --- |
| Header | 32 bytes, little-endian PKMV version 1 |
| Packet header | 16 bytes: kind, zero flags/reserved, byte length, PTS in milliseconds, zero reserved |
| H.264 access unit | 128 KiB; Annex B NAL delimiters |
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
`@pocketjs/framework/media/audio` encoder and native C decoder share cross-language
fixtures. Video and audio records carry absolute PTS; a new seek stream starts
with parameter sets and an IDR frame.

The 3DS worker owns sockets, MVD service calls, ADPCM expansion and NDSP.
The renderer transfers at most one RGB565 frame into a PICA texture after the
previous graphics frame retires. The UI does not wait for network reads or
video decoding. GPU transfer, drawing, allocation and scheduling still take
time; hardware measurements are required for a frame-rate claim.

MVD video processing is available on New 3DS. The host requests CPU speedup,
uses MVD for H.264 and color conversion, PICA for scaling, and NDSP for audio
output. See the [devkitPro MVD example](https://github.com/devkitPro/3ds-examples/tree/master/mvd)
and [libctru MVD interface](https://github.com/devkitPro/libctru/blob/master/libctru/include/3ds/services/mvd.h).
Unavailable MVD or DSP firmware yields a playback error. **NDSP requires a DSP
component from `/3ds/dspfirm.cdc` or the Homebrew Launcher `hb:ndsp` handle.**
If neither is available, status identifies the missing firmware. Luma3DS users
can press L + D-pad Down + SELECT, choose Miscellaneous options → Dump DSP
firmware in Rosalina, then reopen the media source. The dump reads firmware
from the console; the application does not distribute firmware. See the
[devkitPro audio setup](https://github.com/devkitPro/3ds-examples/blob/master/audio/README.md).
The 3DS profile remains
private and its host ABI is 10; ABI 8 launchers require a native replacement.
The CIA declares `mvd:STD` service access and the MVD system-module dependency
listed in [3dbrew's title table](https://www.3dbrew.org/wiki/Title_list#00040130_-_System_Modules).

## Shared interaction

`createMediaScrubber(seek)` keeps drag preview local. Begin and move change the
preview, commit issues one seek, and cancel issues none. Single-display overlays
and independent control surfaces can share this state machine.

`TextField` and `Osk` accept `surface` and `keyHeight`. Keyboard width, overlay
placement and touch hit queries use that surface. Modality blocks application
input until the keyboard closes. `createWasmUi().createAuxiliarySurface(w, h)`
and `renderAuxiliary()` expose the same separate roots and shared resources for
application tests and visual review.

The 3DS decoder requests **`MVD_OUTPUT_BGR565` (0x40002)** for the packed words
consumed by `GX_TRANSFER_FMT_RGB565` and `GPU_RGB565`. The MVD and GPU names use
different channel-order conventions. Selecting MVD's `RGB565` exchanges red
and blue; the companion must retain the source colors.
