import { defineBuiltinProfile } from "../framework/src/profile.ts";

export default defineBuiltinProfile({
  "id": "macos-app",
  "platform": "macos",
  "form": "window",
  "display": {
    "physicalViewport": [
      1440,
      960
    ],
    "logicalViewports": [
      [
        720,
        480
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
    "rasterDensity": 2
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
