import { defineProfile } from "@pocketjs/framework/profile";
import { defineRuntimeConfig } from "@pocketjs/framework/runtime-config";
export default defineRuntimeConfig({profile:defineProfile({
  id:"zephyr-contract", platform:"esp-idf", form:"takeover", tickHz:30,
  display:{physicalViewport:[8,6],logicalViewports:[[8,6]],presentations:["native"],rasterDensity:1},
  capabilities:["input.buttons", "input.touch"], roleCapabilities:{systemUI:[]},
})});
