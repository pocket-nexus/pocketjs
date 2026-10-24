# M5Stack Tab5

Firmware for the M5Stack Tab5: an ESP32-P4 with a 720x1280 MIPI-DSI panel,
a GT911 touch controller and an ESP32-C6 Wi-Fi coprocessor. The program
composes the runtime with `pocket_guest_quickjs`, two `pocket_render_esp_ppa`
renderers split across the cores (`pocketjs_esp32p4_ppa_lanes`), the
`pocket_display_esp_dpi` output and `pocket_runner`.

| Build | Profile | Picture |
| --- | --- | --- |
| `idf.py build` | `tab5-hero` (`hero.runtime-config.ts`) | `apps/hero` at 640x360, raster density 2, turned onto the panel |
| `idf.py -DPOCKETJS_TAB5_APP=clear build` | `tab5-clear` (`clear.runtime-config.ts`) | `apps/clear` at 360x640, raster density 2, upright |
| `idf.py -DPOCKETJS_TAB5_APP=home -DPOCKETJS_TAB5_HOME_PACKAGE=<home.pocket> build` | `tab5-home` (`home.runtime-config.ts`) | Pocket Home's auxiliary surface, 640x360 at raster density 1, turned and presented at 2x |

The home variant is a launcher console (`TAB5_LAUNCHER`): `components/pocket_system`
keeps a store of installed apps on the microSD card (SDSPI; the `storage`
flash partition without a card), the Pocket Link to a paired companion,
`net.http` over the link, each app's `data.fs` tree and the Wi-Fi radio on
the ESP32-C6 (esp_hosted). The program embeds Pocket Home, compiled in
pocket-shell against `home.runtime-config.ts`, as the launcher and boots one
runtime per app; SELECT from the home control returns to the launcher. The
primary surface of the profile is laid out into a PSRAM buffer that nothing
scans out. `pocket_idf_package_open` (the IDF archive) admits a stored package
for the profile before the runtime boots it. `components/pocket_camera` serves
`globalThis.camera` (the SC202CS on MIPI-CSI: a 320x240 preview at 15 fps,
QR decoding, JPEG stills on the card) and `components/pocket_media` serves
`globalThis.media` (the companion's stream on the ES8388 speaker) to a guest
whose plan declares those capabilities.

A picture smaller than the screen sits between two equal black margins. The
display moves retained pixels for content that only scrolled
(`POCKET_DISPLAY_RETAINED_MOVE`); the runtime's damage planner finds those
moves and repaints the rest. Pocket Clear holds 30 fps at 720x1280 this way
(`tickHz: 30` in its profile). Each strip holds a multiple of the rows that
span whole 128-byte cache lines (`line_rows`: four 1184-byte rows at 592x1,
one 1280-byte row at 640x1), and a turned strip a multiple of 8 raster rows
besides.

The launcher paints a 56-px translucent ball at the right edge of the
picture, halfway down, as two ARGB8888 faces (resting and pressed) in PSRAM
and hands the display the current face as its overlay
(`pocket_display_esp_dpi_set_overlay`), so the ball stays on the framebuffer
wherever the picture changes under it. A touch that lands on the ball never
reaches the guest, however far it travels. A tap (lifted within ten polls,
under 6 logical px of travel) sends one tick of SELECT to Pocket Home, and
from an app it summons the launcher instead (`pocketjs_system_summon`); a
finger that moves at once drags the ball anywhere inside the picture; a
finger that rests longer and then travels 24 px makes a gesture, logged by
its direction (`ball gesture: up`) where an effect attaches later.

The Tab5 keyboard (M5Stack A164, `tab5_keyboard.c`) answers at I2C address
0x6D on Ext.Port1 (SDA GPIO 0, SCL GPIO 1, the program's second I2C bus).
When one answers at boot the input source declares the TEXT class and the
profile's `input.text` holds: each poll drains the keyboard's character
events into `pocket_text_event` records, a character as a commit and a named
key as a down and up pair named as `KeyboardEvent.key` names it (`Enter`,
`Backspace`, `ArrowLeft`). The keyboard keeps its own Sym and Aa layers. Its
firmware 1 reports Ctrl in every event once the key was pressed and never
clears it, so the program reads no modifier from it; `Control+z` waits for
a firmware that releases the key.

The runner's task and the application task that boots the runtime each hold
a 192 KB stack in PSRAM (`task_stack_caps`), with the QuickJS stack limit at
144 KB: evaluating a deep Solid tree throws a RangeError before it reaches
the task's guard page.

```sh
cd programs/m5stack-tab5
idf.py -DPOCKETJS_TAB5_APP=clear -p /dev/cu.usbmodem1201 build flash monitor
```

Builds need the Pocket CLI (`pocket`) on `PATH` and, with
`POCKETJS_RUST_FROM_SOURCE=ON` (the default here), a Rust toolchain with the
`riscv32imafc-unknown-none-elf` target. The log reports the frame rate every
five seconds.
