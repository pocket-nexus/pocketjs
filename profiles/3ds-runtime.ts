import { defineBuiltinProfile } from "../framework/src/profile.ts";
import threeDs from "./3ds-dev.ts";

/** File-loaded 3DS program without application-specific media/offload workers. */
export default defineBuiltinProfile({
  ...threeDs,
  id: "3ds-runtime",
  capabilities: threeDs.capabilities.filter(capability =>
    capability !== "io.offload" && capability !== "media.playback"),
});
