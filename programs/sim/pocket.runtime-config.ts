import { defineRuntimeConfig } from "../../framework/src/runtime-config.ts";
import { build } from "../../tools/build/programs/sim.ts";
export default defineRuntimeConfig({ profiles: ["../../profiles/psp-runtime.json", "../../profiles/vita.json", "../../profiles/3ds-runtime.json"], build });
