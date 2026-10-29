import { defineRuntimeConfig } from "../../framework/src/runtime-config.ts";
import { build } from "../../tools/build/programs/3ds.ts";
export default defineRuntimeConfig({ profile: "../../profiles/3ds-runtime.json", build });
