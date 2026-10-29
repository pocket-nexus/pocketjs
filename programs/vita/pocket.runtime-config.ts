import { defineRuntimeConfig } from "../../framework/src/runtime-config.ts";
import { build } from "../../tools/build/programs/vita.ts";
export default defineRuntimeConfig({ profile: "../../profiles/vita.json", build });
