import { defineRuntimeConfig } from "../../framework/src/runtime-config.ts";
import profile from "../../profiles/redmi-1s-dev.ts";
import { build } from "../../tools/build/programs/redmi-1s.ts";

export default defineRuntimeConfig({ profile, build });
