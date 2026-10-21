import { defineBuiltinProfile } from "../framework/src/profile.ts";

export default defineBuiltinProfile({
  "id": "iphone2g-dev",
  "platform": "ios",
  "form": "takeover",
  "display": {
    "physicalViewport": [
      320,
      480
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
    "rasterDensity": 1
  },
  "capabilities": [
    "input.touch",
    "text.glyphs.baked"
  ],
  "tickHz": 60
});
