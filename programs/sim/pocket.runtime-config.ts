import { defineRuntimeConfig } from "../../framework/src/runtime-config.ts";
import psp from "../../profiles/psp-runtime.ts";
import vita from "../../profiles/vita.ts";
import threeDs from "../../profiles/3ds-runtime.ts";
import { build } from "../../tools/build/programs/sim.ts";
export default defineRuntimeConfig({ profiles: [psp, vita, threeDs], build });
