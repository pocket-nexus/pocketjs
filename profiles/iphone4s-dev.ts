import { defineBuiltinProfile } from "../framework/src/profile.ts";

export default defineBuiltinProfile({
  "id": "iphone4s-dev",
  "platform": "ios",
  "form": "takeover",
  "display": {
    "physicalViewport": [
      640,
      960
    ],
    "logicalViewports": [
      [
        320,
        480
      ]
    ],
    "presentations": [
      "native"
    ],
    "rasterDensity": 2
  },
  "capabilities": [
    "input.touch",
    "text.glyphs.baked"
  ],
  "tickHz": 60
});
