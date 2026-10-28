# CardputerZero program

This program runs one package on the M5Stack CardputerZero: **the 320×170 RGB565 panel through fbdev (`/dev/fb0`), the keyboard as buttons and as text keys through evdev, the package's worker domain on its own thread, the device API behind the worker's `http` node, and the camera as the runtime's video plane.** Two packages run on it: Pocket Companion's own screen (`apps/companion-zero`, the pages of the Mac app for the companion on the same Zero) and Pocket Tools ([pocket-nexus/pocket-zero-tools](https://github.com/pocket-nexus/pocket-zero-tools), a launcher of hardware tools built with `@pocketjs/framework/compact`).

## Keys

The keyboard's keys reach the guest twice. As buttons: Enter is START, Esc, Backspace, Space and Z are CROSS, X is CIRCLE, C is TRIANGLE, Shift is SQUARE, and the arrows on the Fn layer are the d-pad. As text events (`input.text`): every key named as `KeyboardEvent.key` names it (`a`, `A`, `Enter`, `ArrowLeft`, `Control+z`, `Shift+ArrowRight`), with Shift and CapsLock applied to characters and the modifiers as events of their own. **The Zero's symbol layer arrives on key codes the US layout gives other keys (code 26 types `!`, code 74 types `[`); `keymap.rs` names them from the vendor's `/usr/share/keymaps/tca8418_keypad_m5stack_keymap.map` and falls back to the launcher's built-in table.**

## The worker and its `http` node

The worker runs on engine/worker's C runner (`src/worker.rs`); `build.rs` compiles it against the QuickJS-NG source of the `rquickjs-sys` package in the workspace lock, so the worker realm and the UI realm link one engine. The UI realm reaches the worker through the channel bridge, latched before every frame. **The worker's `http` node (`src/http.rs`) answers four kinds of URL.** `http://zero/dev/…` is the device API below, answered in process by the request's thread. `http://companion/…` goes to the companion's control API on `127.0.0.1`; **the port and the bearer token come from `control.json` in the companion's store, read for every request,** so a restarted companion is reached without restarting the screen and neither realm holds the token. A missing `control.json` answers 503 and a port that does not answer 502, each with `{"error": …}`. `http://zero/quit` ends the program after the turn, and `http://zero/restart` runs `systemctl restart pocket-companion.service` (`--unit` names another unit). `http://127.0.0.1:<port>/…` and `http://localhost:<port>/…` go out as written; `open` refuses every other URL. Each request runs on its own thread; the worker's owner task emits its headers, body blocks and end into the core, so closing a resource never waits on a socket.

## The device API

`src/device/mod.rs` keeps one snapshot of the hardware and answers it as JSON. A sampler thread reads the IMU every 20 ms and the battery and system once a second; a GET is a copy of the latest snapshot. Long work (a scan, a capture, learning a signal) runs on its own thread and the topic carries `scanning`, `busy` or `learning` until it lands. `--mock` answers from synthesized readings on any machine.

| Route | Reads or does |
| --- | --- |
| `GET /dev/capabilities` | Which of the below the hardware offers. |
| `GET /dev/motion`; `POST /dev/motion/zero`, `/unzero`, `/calibrate {on}` | Pitch, roll, bubble, heading, acceleration, rotation rate, field, shake, impacts (BMI270 and BMM150 over IIO sysfs, `pose.rs`); the level's zero and the hard-iron calibration, kept in the store. |
| `GET /dev/battery` | Percent, voltage, current, power, status, temperature (`/sys/class/power_supply`). |
| `GET /dev/system`; `POST /dev/system/backlight {value}`, `/volume {value}` | Hostname, uptime, load, memory, disk, CPU temperature, address, Wi-Fi link (`/proc/net/wireless`, `nmcli`), backlight (`/sys/class/backlight`), mixer volume (`amixer`). |
| `GET /dev/audio`; `POST /dev/audio/capture {on}`, `/record {on}`, `/play {name}`, `/delete {name}`, `/beep` | Level and peak in dBFS, a 64-point waveform, 32 log-spaced bands, the pitch and its note (`dsp.rs`), from `arecord` at 16 kHz mono; recordings as WAV files; `aplay`. |
| `GET /dev/ir`; `POST /dev/ir/learn {on}`, `/send {id \| address,command \| pulses \| captured}`, `/save {name}`, `/rename`, `/delete` | The LIRC receiver and transmitter (`/dev/lirc*`, `ir.rs`): a capture as pulse and space durations with its NEC decode, replay, and saved keys. |
| `GET /dev/radio`; `POST /dev/radio/wifi/scan`, `/ble/scan` | `nmcli dev wifi list --rescan yes`; `bluetoothctl --timeout 6 scan on`. |
| `GET /dev/camera`; `POST /dev/camera/live {on}`, `/scan {on}`, `/capture {qr}`, `/delete {name}`; `GET /dev/camera/thumbnail.rgb565` | **The live stream (`camera.rs`): `rpicam-vid` sends 640×360 MJPEG on stdout while the stream is open; the first frame arrives after 9 to 11 s, then about 12.7 frames a second of about 11 KiB.** A reader thread keeps the latest frame and decodes it to a 256×128 RGBA texture for the video plane. A picture is the latest frame written as it is; the thumbnail is the last picture at 128×64 RGB565 (16 KiB). While scanning, rqrr reads QR codes from the latest frame four times a second. Without the stream, `capture` runs `rpicam-still` (about 6 s a picture). The module is mounted turned half a turn, so the stream and the still pass `--hflip --vflip`. **rpicam-apps allocates from `/dev/dma_heap/linux,cma` or `vidbuf_cached`; this kernel names the heap `default_cma_region`, so an application that uses the camera installs a udev rule with the two names.** |
| `GET`/`PUT /dev/store/<key>` | A JSON value the application keeps, at most 64 KiB, under `<store>/store/`. |

The store (`--store`; by default `~/.config/<package file name>`, as the CardputerZero's application guidelines ask) holds the calibration, the saved signals, `recordings/` and `photos/`.

## The camera as the video plane

`src/video.rs` serves the video-plane ops (`videoOpen`, `videoTick`, `videoTexture`, `videoClose`). `videoOpen("camera")` starts the live stream and allocates one 256×128 RGBA texture; **each `videoTick()` copies the newest decoded frame into that texture in place (`Ui::update_texture_rect`)**, so an Image bound to `videoTexture()` follows the lens while no frame crosses JavaScript or the worker's channels, whose records are 1 KiB. `videoClose()` stops the stream.

## The panel

`/dev/fb0` is the DRM emulation of the `panel-mipi-dbi` SPI panel (60 MHz). Writes through the mapping reach the panel by deferred I/O, 50 ms after the first, which merges the frames of an animation. **`platforms/linux/fbdev` calls `fsync` on the framebuffer after each frame, and the kernel sends the written pages at once:** 186 updates a second when asked, against 18 without it. The panel reports partial refresh: a frame draws and flushes the regions that changed, and an unchanged frame writes nothing.

## Running it

The profile (`profile.ts`) is compiled into the binary: `build.rs` copies the file named by `POCKETJS_PROFILE_RS`. Build and install from a Mac or Linux machine with `cargo-zigbuild` and zig:

```sh
bun tools/cardputer-zero.ts build                  # .pocket-build/cardputer-zero/
bun tools/cardputer-zero.ts install root@<address> # build, copy, register with APPLaunch
```

`install` writes `/usr/bin/pocket-cardputer-zero`, `/usr/share/pocketjs/companion.pocket`, the launcher entry `/usr/share/APPLaunch/applications/pocket-companion.desktop` with its icon, and `/etc/sudoers.d/pocket-companion`. **The launcher runs as `pi` and starts the companion's screen with `sudo -n`, because the companion's `control.json` is root's (mode 600).** The sudoers rule allows the `gpio` group to run the program with no arguments, as the vendor's own root apps are allowed. Pocket Tools runs as `pi` without it; its repository builds the CardputerZero Store's `.deb` with its own copy of this program.

`--check` admits the package against the compiled profile without opening devices. `--shot DIR --script "…"` runs the program on any system with a scripted button and key source and an in-memory framebuffer of the panel's geometry; each `shot` event writes `DIR/<tick>.rgb565` (`src/shot.rs`), and `--mock` answers the device API beside it. A script word is `<tick>:<event>`: a button (`DOWN`, `ENTER`, `ESC`), a key (`key:f`, `key:Enter`, `key:Shift+ArrowRight`), typed text (`type:hello_world`) or `shot`. `bun tools/cardputer-zero.ts shot --control <control.json> --script "60:shot 64:DOWN 75:shot"` builds the program for the host and converts the frames to PNG.
