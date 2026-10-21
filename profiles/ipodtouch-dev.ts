import { defineBuiltinProfile } from "../framework/src/profile.ts";

export default defineBuiltinProfile({
  "id": "ipodtouch-dev",
  "platform": "ios",
  "form": "takeover",
  "display": {
    "physicalViewport": [
      640,
      1136
    ],
    "logicalViewports": [
      [
        320,
        568
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
