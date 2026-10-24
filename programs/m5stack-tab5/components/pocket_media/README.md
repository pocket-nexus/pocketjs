# pocket_media

`globalThis.media` (contracts/spec/media.ts, capability media.playback) for
the ESP-IDF QuickJS guest: the companion's PKMV stream played into one core
texture and the board's speaker.

- Public header: `pocket/media.h`
- Targets: ESP32-P4 and ESP32-S3
- Dependencies: `pocket_runtime`, `pocket_guest_quickjs`

A stream task opens the TCP connection the guest names, reads PAL8 pictures
(`engine/host-services/media_wire.h`) into a ring of 16 PSM_5650 frames
(4.2 MB of PSRAM) and IMA ADPCM blocks (`media_adpcm.h`) into a ring of 24 PCM
blocks, and returns one credit per packet with `TCP_NODELAY` set. The frame
ring holds 1.3 s at 12 fps, more than the 1.1 s the audio ring lets the stream
run ahead. An audio task writes the PCM to the speaker through the board's
hooks and keeps the clock: **the position is the block being played plus the
time since its write began, less 40 ms of I2S queue**. The owner task copies
the frame due at that position into the 512x256 texture between turns
(`pocketjs_media_present`).

This host has no H.264 decoder: `status()` reports `h264: false`, and a
stream in another codec fails. Without a speaker (`audio_open` fails) streams
play muted on the system timer.
