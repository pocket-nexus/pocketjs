import { defineBuiltinProfile } from "../framework/src/profile.ts";

export default defineBuiltinProfile({
  "id": "ios-dev",
  "platform": "ios",
  "form": "embedded",
  "display": {
    "physicalViewport": [
      1440,
      816
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
    "rasterDensity": 3
  },
  "capabilities": [
    "input.touch",
    "text.glyphs.baked"
  ],
  "tickHz": 60
});
