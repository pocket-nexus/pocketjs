import { defineBuiltinProfile } from "../framework/src/profile.ts";

export default defineBuiltinProfile({
  "id": "blackberry-qnx-dev",
  "platform": "blackberry10-qnx",
  "form": "takeover",
  "display": {
    "physicalViewport": [
      720,
      720
    ],
    "logicalViewports": [
      [
        360,
        360
      ]
    ],
    "presentations": [
      "native"
    ],
    "rasterDensity": 2
  },
  "capabilities": [
    "input.buttons",
    "input.touch",
    "text.glyphs.baked"
  ],
  "tickHz": 60
});
