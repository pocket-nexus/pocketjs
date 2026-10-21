import { defineRuntimeConfig } from "../../framework/src/runtime-config.ts";
import profile from "../../profiles/3ds-dev.ts";
import { build } from "../../tools/build/programs/3ds.ts";
export default defineRuntimeConfig({ profile, build });
