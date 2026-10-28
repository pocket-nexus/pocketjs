# CardputerZero program

This program runs one package on the M5Stack CardputerZero: **the 320×170 RGB565 panel through fbdev (`/dev/fb0`), the keyboard as buttons through evdev.** Its package is Pocket Companion's own screen, `apps/companion-zero`: the pages of the Mac app (consoles, applets, X, Discord, YouTube, the assistant, settings) for the companion that runs on the same Zero.

**The program offers no network.** A UI realm has no network namespace, and the worker domain that would carry the screen's calls to the companion's control API (`control.json`, `http://127.0.0.1:<port>`) is not on this program yet. Until that port lands, the screen shows the companion as unreachable and its buttons answer the same way.

The keyboard's first layer has Enter (START), Esc, Backspace, Space and Z (CROSS), X (CIRCLE), C (TRIANGLE) and Shift (SQUARE). **The arrows are on the Fn layer.** The panel reports partial refresh: a frame draws and flushes the regions that changed, and an unchanged frame writes nothing to the framebuffer.

The profile (`profile.ts`) is compiled into the binary: `build.rs` copies the file named by `POCKETJS_PROFILE_RS`. Build and install from a Mac or Linux machine with `cargo-zigbuild` and zig:

```sh
bun tools/cardputer-zero.ts build                  # .pocket-build/cardputer-zero/
bun tools/cardputer-zero.ts install root@<address> # build, copy, register with APPLaunch
```

`install` writes `/usr/bin/pocket-cardputer-zero`, `/usr/share/pocketjs/companion.pocket`, the launcher entry `/usr/share/APPLaunch/applications/pocket-companion.desktop` with its icon, and `/etc/sudoers.d/pocket-companion`. **The launcher runs as `pi` and starts the program with `sudo -n`, because the companion's `control.json` is root's (mode 600).** The sudoers rule allows the `gpio` group to run the program with no arguments, as the vendor's own root apps are allowed.

`--check` admits the package against the compiled profile without opening devices. `--shot DIR --script "…"` runs the program on any system with a scripted button source and an in-memory framebuffer of the panel's geometry; each `shot` event writes `DIR/<tick>.rgb565` (`src/shot.rs`). `bun tools/cardputer-zero.ts shot --script "60:shot 64:DOWN 75:shot"` builds the program for the host and converts the frames to PNG.
