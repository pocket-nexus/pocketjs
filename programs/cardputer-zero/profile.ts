import { defineProfile } from "../../framework/src/profile.ts";
/** The M5Stack CardputerZero: a 320x170 RGB565 panel (panel-mipi-dbi, /dev/fb0)
 * drawn by the software rasterizer, and its 46-key matrix keyboard (tca8418,
 * evdev) read as buttons and as text keys. A package's worker domain runs on
 * its own thread; its `net.http` reaches this machine only: the `http` node
 * answers loopback URLs, the companion's control API and the device API under
 * http://zero/dev/ (programs/cardputer-zero/src/http.rs, device/). */
export default defineProfile({
  id: "cardputer-zero", platform: "linux", form: "embedded", tickHz: 30,
  display: { physicalViewport: [320, 170], logicalViewports: [[320, 170]], rasterDensity: 1, presentations: ["native"], animation: "repaint" },
  capabilities: ["input.buttons", "input.text", "text.glyphs.baked", "runtime.worker", "net.http"], roleCapabilities: {},
});
