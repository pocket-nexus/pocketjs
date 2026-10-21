import { defineBuiltinProfile } from "../framework/src/profile.ts";

export default defineBuiltinProfile({
  "id": "macos-widget",
  "platform": "macos",
  "form": "widget",
  "display": {
    "physicalViewport": [
      840,
      1120
    ],
    "logicalViewports": [
      [
        420,
        560
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
      ]
    },
    "presentations": [
      "native"
    ],
    "rasterDensity": 2
  },
  "capabilities": [
    "input.buttons",
    "input.ime",
    "input.pointer",
    "input.text",
    "host.clipboard",
    "display.viewport.live",
    "text.glyphs.baked",
    "text.glyphs.runtime"
  ],
  "tickHz": 60
});
