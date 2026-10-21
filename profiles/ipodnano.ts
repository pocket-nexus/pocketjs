import { defineBuiltinProfile } from "../framework/src/profile.ts";

export default defineBuiltinProfile({
  "id": "ipodnano",
  "platform": "rockbox",
  "form": "takeover",
  "tickHz": 30,
  "display": {
    "physicalViewport": [
      176,
      132
    ],
    "logicalViewports": [
      [
        176,
        132
      ]
    ],
    "presentations": [
      "native"
    ],
    "rasterDensity": 1
  },
  "capabilities": []
});
