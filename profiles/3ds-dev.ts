import { defineBuiltinProfile } from "../framework/src/profile.ts";

export default defineBuiltinProfile({
  "id": "3ds-dev",
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
    "io.offload",
    "media.playback",
    "input.analog.left",
    "input.analog.right",
    "input.buttons",
    "input.cursor",
    "input.touch.auxiliary",
    "display.auxiliary",
    "text.glyphs.baked",
    "ui.physics",
    "net.http",
    "link.companion",
    "system.wifi",
    "camera.qr",
    "camera.photo",
    "system.agent",
    "data.fs",
    "game.playset"
  ],
  "tickHz": 60
});
