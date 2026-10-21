import { defineBuiltinProfile } from "../framework/src/profile.ts";

export default defineBuiltinProfile({
  "id": "vita",
  "platform": "vita",
  "form": "takeover",
  "display": {
    "physicalViewport": [
      960,
      544
    ],
    "logicalViewports": [
      [
        480,
        272
      ]
    ],
    "presentations": [
      "integer-fit"
    ],
    "rasterDensity": 2
  },
  "capabilities": [
    "input.analog.left",
    "input.buttons",
    "input.cursor",
    "input.touch",
    "text.glyphs.baked"
  ],
  "tickHz": 60
});
