import { defineBuiltinProfile } from "../framework/src/profile.ts";

export default defineBuiltinProfile({
  "id": "gba",
  "platform": "gba",
  "form": "takeover",
  "tickHz": 30,
  "display": {
    "physicalViewport": [
      240,
      160
    ],
    "logicalViewports": [
      [
        240,
        160
      ]
    ],
    "presentations": [
      "native"
    ],
    "rasterDensity": 1
  },
  "capabilities": ["input.buttons", "text.glyphs.baked"]
});
