import { defineBuiltinProfile } from "../framework/src/profile.ts";

export default defineBuiltinProfile({
  "id": "linux-app",
  "platform": "linux",
  "form": "window",
  "display": {
    "physicalViewport": [
      1280,
      800
    ],
    "logicalViewports": [
      [
        800,
        600
      ]
    ],
    "dynamicViewport": {
      "min": [
        240,
        180
      ],
      "max": [
        4096,
        4096
      ],
      "acceptsFixed": true
    },
    "presentations": [
      "native"
    ],
    "rasterDensity": 1
  },
  "capabilities": [
    "input.buttons",
    "display.viewport.live",
    "text.glyphs.baked",
    "io.offload",
    "text.layout.offload"
  ],
  "roleCapabilities": {
    "systemUI": [
      "ui.compositor-surfaces"
    ]
  },
  "tickHz": 60
});
