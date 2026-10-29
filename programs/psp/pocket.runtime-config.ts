import { defineRuntimeConfig } from "../../framework/src/runtime-config.ts";
import { build } from "../../tools/build/programs/psp.ts";
export default defineRuntimeConfig({ profile: "../../profiles/psp.json", build });
