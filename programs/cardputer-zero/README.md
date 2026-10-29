# CardputerZero program

This program runs one package on the M5Stack CardputerZero: **the 320×170 RGB565 panel through fbdev (`/dev/fb0`), the keyboard as buttons through evdev, and the package's worker domain on its own thread.** Its package is Pocket Companion's own screen, `apps/companion-zero`: the pages of the Mac app (consoles, applets, X, Discord, YouTube, the assistant, settings) for the companion that runs on the same Zero.

The worker runs on engine/worker's C runner (`src/worker.rs`); `build.rs` compiles it against the QuickJS-NG source of the `rquickjs-sys` package in the workspace lock, so the worker realm and the UI realm link one engine. The UI realm reaches the worker through the channel bridge, latched before every frame. **The worker's `http` node (`src/http.rs`) answers three hosts.** `http://companion/…` goes to the companion's control API on `127.0.0.1`; **the port and the bearer token come from `control.json` in the companion's store, read for every request,** so a restarted companion is reached without restarting the screen and neither realm holds the token. A missing `control.json` answers 503 and a port that does not answer 502, each with `{"error": …}`. `http://zero/quit` ends the program after the turn, and `http://zero/restart` runs `systemctl restart pocket-companion.service` (`--unit` names another unit). `http://127.0.0.1:<port>/…` and `http://localhost:<port>/…` go out as written; `open` refuses every other URL. Each request runs on its own thread; the worker's owner task emits its headers, body blocks and end into the core, so closing a resource never waits on a socket.

The keyboard's first layer has Enter (START), Esc, Backspace, Space and Z (CROSS), X (CIRCLE), C (TRIANGLE) and Shift (SQUARE). **The arrows are on the Fn layer.** The panel reports partial refresh: a frame draws and flushes the regions that changed, and an unchanged frame writes nothing to the framebuffer.

The host contract (`pocket.host.json`) is compiled into the binary: `build.rs` copies the file named by `POCKETJS_PROFILE_RS`. Build and install from a Mac or Linux machine with `cargo-zigbuild` and zig:

```sh
bun tools/cardputer-zero.ts build                  # .pocket-build/cardputer-zero/
bun tools/cardputer-zero.ts install root@<address> # build, copy, register with APPLaunch
```

`install` writes `/usr/bin/pocket-cardputer-zero`, `/usr/share/pocketjs/companion.pocket`, the launcher entry `/usr/share/APPLaunch/applications/pocket-companion.desktop` with its icon, and `/etc/sudoers.d/pocket-companion`. **The launcher runs as `pi` and starts the program with `sudo -n`, because the companion's `control.json` is root's (mode 600).** The sudoers rule allows the `gpio` group to run the program with no arguments, as the vendor's own root apps are allowed.

`--check` admits the package against the compiled host contract without opening devices. `--shot DIR --script "…"` runs the program on any system with a scripted button source and an in-memory framebuffer of the panel's geometry; each `shot` event writes `DIR/<tick>.rgb565` (`src/shot.rs`). `bun tools/cardputer-zero.ts shot --control <control.json> --script "60:shot 64:DOWN 75:shot"` builds the program for the host and converts the frames to PNG.
