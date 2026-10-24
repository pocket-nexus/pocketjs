import { defineBuiltinProfile } from "../framework/src/profile.ts";

export default defineBuiltinProfile({
  "id": "psp",
  "platform": "psp",
  "form": "takeover",
  "display": {
    "physicalViewport": [
      480,
      272
    ],
    "logicalViewports": [
      [
        480,
        272
      ]
    ],
    "presentations": [
      "native",
      "integer-fit"
    ],
    "rasterDensity": 1
  },
  "capabilities": [
    "input.analog.left",
    "input.buttons",
    "io.offload",
    "text.layout.offload",
    "net.http",
    "link.companion",
    "input.cursor",
    "audio.pcm",
    "text.glyphs.baked",
    "text.glyphs.streamed"
  ],
  "tickHz": 60
});
