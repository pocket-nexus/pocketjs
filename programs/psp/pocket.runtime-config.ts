import { defineRuntimeConfig } from "../../framework/src/runtime-config.ts";
import profile from "../../profiles/psp.ts";
import { build } from "../../tools/build/programs/psp.ts";
export default defineRuntimeConfig({ profile, build });
