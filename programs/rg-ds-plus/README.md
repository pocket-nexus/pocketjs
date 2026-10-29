# RG DS Plus program

This program runs one package on the Anbernic RG DS Plus: **both 1024×768 MIPI DSI panels rendered by the Mali-G52 through Rockchip's libmali (GBM, EGL, GLES 2), the gamepad and buttons as buttons and the Goodix panel as touch through evdev.** DSI-1 (top) is the primary surface and DSI-2 (bottom) the auxiliary surface, each 512×384 points at raster density 2. Omarchy Pocket's shell (pocket-nexus/omarchy-pocket) runs on it.

**The device never renders on the CPU.** `src/gpu.rs` opens `/dev/dri/card0` once, creates libmali's GBM device on it, one EGL context and one GBM surface plus EGL window surface per panel, and renders with `pocket-gles2`. A flush makes that panel's surface current (presentation renders every panel before flushing any), swaps, adds the GBM front buffer to KMS once and page-flips with the legacy API; a wait takes the flip event for that panel's CRTC and returns the previous buffer to GBM. The program links `libmali.so.1` directly: libmali's `libEGL`, `libGLESv2` and `libgbm` are small wrappers that export none of those symbols.

The gamepad (`ANBERNIC-rk3568-keys`) gets its own key table: A (304) is CIRCLE, the framework's focus press; B (305) is CROSS; X/Y are TRIANGLE/SQUARE; L1/R1 (308/309) are LTRIGGER/RTRIGGER; L2/R2 (314/315) are ZL/ZR; Select (310) and Start (311) are SELECT and START. The D-pad is a hat (ABS_HAT0X/ABS_HAT0Y). Touch lands on the lower surface unless `--touch-on-top`.

`touch /tmp/pocket-shot` on the device reads each panel's next presented frame back with `glReadPixels` into `/tmp/pocket-shot-<panel>.rgba` (bottom row first); the trigger goes once both panels have a file.

`--shot DIR --script "…"` runs the package on any system without the panels, for layout work: scripted buttons and taps on the lower panel (`tap@x,y`), the CPU raster renderer and two in-memory panels behind the same KMS display type, written to `DIR/<tick>-top.xrgb` and `DIR/<tick>-bottom.xrgb` at each `shot` event.

The profile (`profile.ts`) is compiled into the binary: `build.rs` copies the file named by `POCKETJS_PROFILE_RS`. Cross-compiling needs `cargo-zigbuild`, zig and the device's `libmali.so.1` for the linker:

```sh
bun tools/rg-ds-plus.ts libs root@<address>   # copy libmali from the device into .pocket-build/rg-ds-plus/gl-libs
bun tools/rg-ds-plus.ts build                 # .pocket-build/rg-ds-plus/cargo/aarch64-unknown-linux-gnu/release/pocket-rg-ds-plus
bun tools/rg-ds-plus.ts shot --package app.pocket --script "30:shot 40:DOWN 50:shot"
```

`--check` admits the package against the compiled profile without opening devices. Default package: `/usr/share/pocketjs/omarchy-pocket.pocket`.
