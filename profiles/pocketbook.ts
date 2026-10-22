import { defineBuiltinProfile } from "../framework/src/profile.ts";

export default defineBuiltinProfile({
  "id": "pocketbook",
  "platform": "pocketbook",
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
    "input.buttons",
    "input.touch",
    "text.glyphs.baked"
  ],
  "tickHz": 60
});
