# Pocket Studio on the TrimUI Smart Pro

`programs/trimui-smart-pro` runs the Pocket Studio room on the console: the 3D room, the agent loop, speech recognition and every game execute on the device. **No companion process takes part.** The only network traffic is HTTPS from the device to the model endpoint.

## Device facts

| Fact | Value |
| --- | --- |
| Firmware | TinaLinux on kernel 4.9.191, glibc 2.33 |
| CPU and memory | Allwinner A133 Plus, 4 Cortex-A53 cores, 1 GB |
| GPU | PowerVR GE8300, OpenGL ES 3.2, ASTC |
| Display | 1280x720; `eglCreateWindowSurface` with a null window takes the whole panel |
| Gamepad | `TRIMUI Player1`, a uinput device published by `trimui_inputd` |
| Microphone | ALSA `hw:0,0` left channel, gain on mixer control `numid=5` |

**A launcher app replaces MainUI until it exits.** MainUI lists `/mnt/UDISK/Apps/<name>/config.json` and the same path under `/mnt/SDCARD` when a card is mounted; choosing an entry writes `/tmp/cmd_to_run.sh` and exits, and `runtrimui.sh` runs that script, then restarts MainUI. **`/tmp/stay_awake` stops the firmware from suspending while the file exists.** MainUI ignores `SIGTERM`; development runs end it with `SIGKILL`.

**The USB gadget does not survive a suspend.** After a resume, the device re-enumerates about every 1.6 s and `adb` drops; a reboot restores it. Wi-Fi returns on resume. Sending `tcpip:5555` to this `adbd` ends the process, and its init script does not restart it. `/etc/init.d/adbd` has no respawn parameter.

## Structure

| Path | Role |
| --- | --- |
| `programs/trimui-smart-pro` | EGL, gamepad, room, main loop, agent host, microphone |
| `programs/trimui-smart-pro/agent/harness.ts` | The agent loop |
| `apps/studio-handheld` | The Solid interface drawn over the room |
| `engine/arcade` | Pocket Arcade: the game framework's Rust core and TypeScript SDK |
| `tools/trimui-smart-pro.ts` | Build, install, sign-in copy, run and screenshots |
| `tools/trimui-smart-pro/bake-room.ts` | Room bake from a Pocket Studio checkout |

## The room

`bake-room.ts` reads `rooms/workshop/package` from a Pocket Studio checkout and writes `room.pak`: world-space meshes, ASTC 4x4 mip chains at 2048x2048, and the manifest's anchors, camera poses and glows. **The baked file holds Pocket Studio's art and stays in ignored build output.** The bake drops the shade atlases, which feed the web room's live shadow maps.

The rig reproduces the web room's flights: poses come from the manifest, the field of view derives from each pose's fit rectangle, and a move follows a lifted arc. A lens shift moves the picture sideways to make room for a card.

The interface runs in the shared PocketJS `Runtime`. `pocket-gles2` draws into the default framebuffer with `ClearMode::Preserve`, after the room. State and commands cross the `pocket.overlay` service as JSON lines. Text that arrives at run time gets its glyphs from `/usr/trimui/res/full.ttf` before the UI measures it.

## The agent loop

`harness.ts` runs in a QuickJS runtime capped at 12 MiB, on its own thread. It is a synchronous loop: one model turn through `host.model`, then each tool call, then a trim of what the model has already seen. **Stream deltas and screenshots stay in Rust**: deltas go to the screen and are dropped, and the harness refers to screenshots by name. Tool calls and results older than the last 16 items shrink to stubs, and only the newest screenshots stay in the conversation.

| Tool | Effect |
| --- | --- |
| `list_files`, `read_file`, `write_file`, `edit_file` | Files inside the game's directory; TypeScript syntax errors return with the write |
| `run_game` | Runs `main.ts` at 60 ticks per second on the in-room console with scripted buttons; returns errors, logs, counts and screenshots |
| `finish` | Writes `game.json`, which puts the game on the rack |

`data/harness.ts`, when present on the device, replaces the built-in harness at the next run.

### Sign-in and network

`auth` copies `~/.codex/auth.json` to `/mnt/UDISK/pocket-studio/auth.json` with mode 0600. `llm.rs` calls `https://chatgpt.com/backend-api/codex/responses` over rustls with bundled roots.

**A refresh rotates the refresh token, which invalidates the copy on the computer.** The program refreshes only when the access token has under five minutes left or the server answers 401. Copying a fresh `auth.json` after signing in again restores both sides.

`config.json` beside it sets `model`, `effort`, `base_url` and `proxy`. On a network that blocks the endpoint, `proxy` names an HTTP CONNECT proxy; TLS still terminates on the device.

## Speech

`mic.rs` records through the firmware's `arecord`. On release, it removes DC offset and normalizes the peak. `sherpa-onnx-offline-websocket-server` decodes the samples with the 80 MB `paraformer-zh-small` model over a local WebSocket. **Loading the model takes about 15 s and decoding a 6 s clip about 1 s**, so the process starts when the desk or the rack opens and stops when a game starts. The transcript appears on a review card; A starts the agent, X records again.

## Pocket Arcade

A game is a directory with a `main.ts` importing `@pocketjs/framework/arcade`. **There is no build step**: oxc strips types module by module when QuickJS loads each import, so a changed file runs on the next load.

- **Entities** live in one `Float32Array` of 16 floats per entity, written by the SDK and read by the renderer each frame. Setting `e.x` crosses no host boundary.
- **Drawing** groups entities by mesh into one instanced draw call with per-vertex lighting and fog.
- **Limits**: 4096 entities, a 48 MiB heap per game, and a 4 second limit per update. An exceeded limit stops the game with an error the agent can read.
- **Determinism**: `update` runs at a fixed 60 Hz and `rand` is seeded, so a scripted `run_game` replays exactly.

The API surface is `engine/arcade/ts/arcade.d.ts`, which the agent receives in its instructions.

## Validation

The program reads lines from the FIFO `/tmp/pocket-studio.ctl`:

| Line | Effect |
| --- | --- |
| `press a 8` | Holds a button for 8 frames |
| `hold x`, `release x` | Holds or releases a button |
| `prompt <text>` | Starts the agent on a new game |
| `voice <file.wav>` | Runs recognition on a 16 kHz mono WAV |
| `shot <file.png>` | Writes the next frame to a file |
| `quit` | Exits; MainUI returns |

```sh
bun tools/trimui-smart-pro.ts ctl 'press a 8'
bun tools/trimui-smart-pro.ts shot .pocket-build/validation/trimui/shot.png
adb shell cat /tmp/studio.log
```

The log reports frame rate, worst frame time and resident memory every 5 seconds, and token counts and harness heap after each agent run.

## Performance

| Measure | Result |
| --- | --- |
| Room with UI, 167,014 triangles | 60.3 fps; worst frame 16.8 ms; CPU at 816 MHz under `ondemand` |
| Arcade game, full screen | 60 fps |
| Program resident memory | 30 to 49 MB |
| Harness heap peak | 249 KB |
| Recognizer resident memory | 145 MB while loaded |
| Recognition of a 6 s clip, model loaded | 1.5 s |
| New game, prompt to shelf | 56 to 97 s with `gpt-6-astra` at medium effort |

**The UI renderer runs with `set_swap_synchronized(true)`.** With the `glFinish` that `pocket-gles` issues by default, the CPU waits out the GPU before the swap, the frame misses vsync, and the room holds 50 to 54 fps.
