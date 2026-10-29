import { defineRuntimeConfig } from "../../framework/src/runtime-config.ts";
import { build } from "../../tools/build/programs/redmi-1s.ts";

export default defineRuntimeConfig({ profile: "../../profiles/redmi-1s-dev.json", build });
