import { defineBuiltinProfile } from "../framework/src/profile.ts";

export default defineBuiltinProfile({
  "id": "macos-embedded",
  "platform": "macos",
  "form": "embedded",
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
    "input.cursor",
    "text.glyphs.baked"
  ],
  "tickHz": 60
});
