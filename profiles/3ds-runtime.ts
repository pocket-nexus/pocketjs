import { defineBuiltinProfile } from "../framework/src/profile.ts";

export default defineBuiltinProfile({
  "id": "3ds-runtime",
  "platform": "3ds",
  "form": "takeover",
  "display": {
    "physicalViewport": [
      400,
      240
    ],
    "logicalViewports": [
      [
        400,
        240
      ]
    ],
    "presentations": [
      "native"
    ],
    "rasterDensity": 1,
    "auxiliary": {
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
    }
  },
  "capabilities": [
    "input.analog.left",
    "input.analog.right",
    "input.buttons",
    "input.cursor",
    "input.touch.auxiliary",
    "display.auxiliary",
    "text.glyphs.baked",
    "ui.physics"
  ],
  "tickHz": 60
});
