import { defineBuiltinProfile } from "../framework/src/profile.ts";

export default defineBuiltinProfile({
  "id": "meizu-m8-dev",
  "platform": "wince",
  "form": "takeover",
  "display": {
    "physicalViewport": [
      480,
      720
    ],
    "logicalViewports": [
      [
        480,
        720
      ]
    ],
    "presentations": [
      "native"
    ],
    "rasterDensity": 1
  },
  "capabilities": [
    "input.touch",
    "text.glyphs.baked"
  ],
  "tickHz": 60
});
