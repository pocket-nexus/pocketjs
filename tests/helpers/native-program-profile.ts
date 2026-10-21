import { defineProfile } from "../../framework/src/profile.ts";

export default defineProfile({
  "id": "native-program-fixture",
  "platform": "symbian",
  "form": "window",
  "display": {
    "physicalViewport": [
      640,
      360
    ],
    "logicalViewports": [
      [
        640,
        360
      ]
    ],
    "dynamicViewport": {
      "min": [
        360,
        360
      ],
      "max": [
        640,
        640
      ]
    },
    "presentations": [
      "native"
    ],
    "rasterDensity": 1
  },
  "capabilities": [
    "input.buttons",
    "input.touch",
    "display.viewport.live",
    "text.glyphs.baked",
    "ui.physics"
  ],
  "tickHz": 60
});
