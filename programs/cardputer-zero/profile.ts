import { defineProfile } from "../../framework/src/profile.ts";
/** The M5Stack CardputerZero's 320x170 RGB565 panel (panel-mipi-dbid, /dev/fb0)
 * and its keyboard (tca8418, evdev buttons). `net.http` reaches this machine
 * only: the program's transport answers loopback URLs and the companion's
 * control API (programs/cardputer-zero/src/net.rs). */
export default defineProfile({
  id: "cardputer-zero", platform: "linux", form: "embedded", tickHz: 30,
  display: { physicalViewport: [320, 170], logicalViewports: [[320, 170]], rasterDensity: 1, presentations: ["native"] },
  capabilities: ["input.buttons", "text.glyphs.baked", "net.http"], roleCapabilities: {},
});
