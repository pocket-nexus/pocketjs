# CardputerZero program

This program runs one package on the M5Stack CardputerZero: **the 320×170 RGB565 panel through fbdev (`/dev/fb0`), the keyboard as buttons through evdev, and `globalThis.net` over a loopback transport.** Its package is Pocket Companion's own screen, `apps/companion-zero`: the pages of the Mac app (consoles, applets, X, Discord, YouTube, the assistant, settings) for the companion that runs on the same Zero.

The transport (`src/net.rs`) answers three hosts. `http://companion/…` goes to the companion's control API on `127.0.0.1`; **the port and the bearer token come from `control.json` in the companion's store, read for every request,** so a restarted companion is reached without restarting the screen and the guest never holds the token. `http://zero/quit` ends the program after the turn, and `http://zero/restart` runs `systemctl restart pocket-companion.service` (`--unit` names another unit). `http://127.0.0.1:<port>/…` and `http://localhost:<port>/…` go out as written; every other URL fails with `invalid_request`.

The keyboard's first layer has Enter (START), Esc, Backspace, Space and Z (CROSS), X (CIRCLE), C (TRIANGLE) and Shift (SQUARE). **The arrows are on the Fn layer.** The panel reports partial refresh: a frame draws and flushes the regions that changed, and an unchanged frame writes nothing to the framebuffer.

The profile (`profile.ts`) is compiled into the binary: `build.rs` copies the file named by `POCKETJS_PROFILE_RS`. Build and install from a Mac or Linux machine with `cargo-zigbuild` and zig:

```sh
bun tools/cardputer-zero.ts build                  # .pocket-build/cardputer-zero/
bun tools/cardputer-zero.ts install root@<address> # build, copy, register with APPLaunch
```

`install` writes `/usr/bin/pocket-cardputer-zero`, `/usr/share/pocketjs/companion.pocket`, the launcher entry `/usr/share/APPLaunch/applications/pocket-companion.desktop` with its icon, and `/etc/sudoers.d/pocket-companion`. **The launcher runs as `pi` and starts the program with `sudo -n`, because the companion's `control.json` is root's (mode 600).** The sudoers rule allows the `gpio` group to run the program with no arguments, as the vendor's own root apps are allowed.

`--check` admits the package against the compiled profile without opening devices. `--shot DIR --script "…"` runs the program on any system with a scripted button source and an in-memory framebuffer of the panel's geometry; each `shot` event writes `DIR/<tick>.rgb565` (`src/shot.rs`). `bun tools/cardputer-zero.ts shot --control <control.json> --script "60:shot 64:DOWN 75:shot"` builds the program for the host and converts the frames to PNG.
