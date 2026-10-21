import { defineProfile } from "@pocketjs/framework/profile";

export default defineProfile({
  "id": "idf-smoke",
  "platform": "esp-idf",
  "form": "takeover",
  "tickHz": 60,
  "display": {
    "physicalViewport": [
      320,
      240
    ],
    "logicalViewports": [
      [
        320,
        240
      ]
    ],
    "presentations": [
      "native"
    ],
    "rasterDensity": 1
  },
  "capabilities": [
    "input.buttons",
    "text.glyphs.baked"
  ]
});
