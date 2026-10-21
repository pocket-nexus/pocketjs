import { defineBuiltinProfile } from "../framework/src/profile.ts";

export default defineBuiltinProfile({
  "id": "web-app",
  "platform": "web",
  "form": "window",
  "display": {
    "physicalViewport": [
      800,
      600
    ],
    "logicalViewports": [
      [
        800,
        600
      ]
    ],
    "dynamicViewport": {
      "min": [
        320,
        240
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
    "text.glyphs.runtime",
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
