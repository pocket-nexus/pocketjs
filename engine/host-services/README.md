# Host services in C

Portable C that native programs compile directly into their binaries: the
services a console offers its guests besides the UI. Each source implements
one contract and calls the platform only through `host_services.h`, which
every program implements once.

| Source | Contract | What it does |
| --- | --- | --- |
| `link2.c`, `link2.h` | `contracts/spec/link2.ts`, `docs/POCKET-LINK.md` | The Pocket Link 2 client: discovery, the handshake from the pairing files, both request tables, streams with credit, catalog and install, `net.http`, the runtime operations, the DevTools stream and the host half of applet channels. The program supplies its operations as `Link2Host` callbacks and its sockets, clock and randomness as `Link2Platform`. |
| `link2_proto.c`, `link2_proto.h` | `contracts/spec/link2.ts` | The socket-free half of version 2: preamble, the 12-byte header, the streaming frame reader, control frames, proofs, the pairing files' readers, a bounded JSON writer. |
| `link2_bsd.c` | | The socket half of a `Link2Platform` from BSD sockets (POSIX, the 3DS). |
| `link2_guest.c`, `link2_guest.h` | `contracts/spec/link.ts` `LinkStatus`, `LinkEvent` | `globalThis.link` on the version 2 client, in version 1's shape: status, forget, catalog, install into the app's slot, remove, poll. |
| `link2_http.c` | `link_http.h`, `engine/worker/include/pocket/worker_protocol.h` | The worker's HTTP stream on version 2's `net.http`: the same calls and facts as `link_http.c`. A program links one of the two. |
| `link.c`, `link.h` | `contracts/spec/link.ts` | Version 1 of the Pocket Link client, for programs that have not moved to `link2.c`: beacons, the handshake, pairing, catalog and install requests, and the frames of the worker HTTP stream. One state machine pumped once per frame; every socket is non-blocking. |
| `link_http.c`, `link_http.h` | `engine/worker/include/pocket/worker_protocol.h`, `contracts/spec/link.ts` `net.stream` | Bounded streaming HTTP over the system Link, with an 8 KiB receive window, byte credit, separate headers and terminal state. Fact kinds, statuses and the block size come from the worker protocol header. All calls run on the Link owner task. |
| `link_proto.c`, `link_proto.h` | `contracts/spec/link.ts` | The socket-free half: constants, beacon and frame layouts, the pairing URI, HMAC proofs. |
| `launcher.c`, `launcher.h` | the `applications` operations, `docs/LAUNCHER.md` | The app table of a console with installed apps, the switch request, SELECT summons, `resume` and `lastError`. The program's main loop performs the switch. |
| `fs.c`, `fs.h` | `contracts/spec/fs.ts` | One guest's `data.fs` tree: the nine ops, quota, and replacement of a file on FAT, which refuses a rename onto an existing name. |
| `jscan.c`, `jscan.h` | | A bounded JSON reader and a growable JSON writer for the program's own records. |
| `sha256.c`, `sha256.h` | | SHA-256, HMAC-SHA256, hex, and the slot of an app id (the first 16 hex digits of SHA-256 of the id). |
| `photos_image.c`, `photos_image.h` | `contracts/spec/camera.ts` | DCF photo names, RGB565 to RGB888 for the encoder, and the box-filtered thumbnail and full view in `PSM_5650`. Each program brings its own JPEG codec. |
| `media_wire.h`, `media_adpcm.h` | `contracts/spec/media.ts`, `contracts/spec/media-adpcm.ts` | The media stream's header and packet layouts, PAL8 frame expansion, and the IMA ADPCM block decoder. |
| `quirc/` | | QR-code recognition, vendored unmodified (`quirc/VENDORED.txt`). |

## Programs

| Program | Build | `host_services.h` implementation |
| --- | --- | --- |
| Nintendo 3DS product | `products/3ds/Makefile` (`SHARED`) | `products/3ds/src/services_host.c`: libctru clocks and `ps:ps` randomness, the CFG owner name, `soc:U`, the SD card runtime slots (`runtime.c`), the agent channel (`agent.c`) |
| M5Stack Tab5 | pocket-nexus/pocket-m5 `programs/m5stack-tab5/components/pocket_system`, `pocket_camera`, `pocket_media` | `src/services_host.c` in `pocket_system`: `esp_timer`, `esp_fill_random`, lwIP, the `/pocket` store; the camera and media components compile the photo, QR and media sources |

`platforms/3ds/media.c` reads the media headers from this directory. The
build machine compiles `fs.c`, `jscan.c`, `link_proto.c` and `sha256.c` in
`tests/fs-3ds.test.ts`, `tests/3ds-link.test.ts` and
`tests/3ds-runtime-state.test.ts`. `link_http.c` needs `engine/worker/include`
on the include path; `tests/worker-http-stream.test.ts` builds it with
`jscan.c` and no link client. Pocket Hub's tests build `link.c`, `launcher.c`
and `link_http.c` (under `POCKETJS_WORKER_HTTP`) into a POSIX link client and
run it against Pocket Hub's companion.
