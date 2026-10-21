import { defineRuntimeConfig } from "../../framework/src/runtime-config.ts";
import profile from "../../profiles/vita.ts";
import { build } from "../../tools/build/programs/vita.ts";
export default defineRuntimeConfig({ profile, build });
