# pocket_camera

`globalThis.camera` (contracts/spec/camera.ts) for a guest on the Tab5:
the camera.qr viewfinder with QR decoding and the camera.photo store.

- Public header: `pocket/camera.h`
- Target: ESP32-P4 (PPA, JPEG codec)
- Dependencies: `esp_video`, `pocket_runtime`, `pocket_guest_quickjs`

The board supplies the sensor's V4L2 device, a hook that starts the sensor,
the sensor's rotation and the storage directory. A capture task streams
RGB565 from the ISP and the PPA turns every second frame into a 320x240
PSM_5650 preview: **a centered 4:3 crop scaled by a sixteenth-step factor,
rotated upright and mirrored for the inner flag**. On the Tab5 a 15 fps
preview keeps a 30 fps UI at 14.6 ms a frame on average and 25.5 ms at most;
a preview every sensor frame took 33.2 ms on average, the whole frame
budget. The owner task copies the newest
preview into one 512x256 texture of the running guest between ticks
(`pocketjs_camera_present`, through `pocket_runtime_update_texture`, so only
the quads that sample it repaint), so the guest draws an ordinary image handle. A
decode task runs quirc (`engine/host-services/quirc`) on the preview's luma
at most every 250 ms, built with `QUIRC_FLOAT_TYPE=float` for the P4's
single-precision FPU: **135 ms for a frame holding a pairing code** (1.7 s in
double), 9 ms for a frame without a code.

Stills are the same crop at 640x480, encoded by the JPEG codec to
`<storage>/DCIM/100POCKT/PKT_nnnn.JPG` (41 to 55 ms with the file write on
an SD card over SPI). Thumbnails (78 px in a 128 texture)
and full views (fitted to 320x240) are decoded by the codec and box-filtered
by `engine/host-services/photos_image.c`; thumbnails are cached under
`<storage>/photos/thumbs`. Long file names need FAT LFN or LittleFS.

Call `pocketjs_camera_install` with the guest's realm before the runtime
boots it and `pocketjs_camera_teardown` before the runtime is destroyed.
