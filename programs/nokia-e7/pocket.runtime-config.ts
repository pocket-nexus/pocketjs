import { defineRuntimeConfig } from "../../framework/src/runtime-config.ts";
import { build } from "../../tools/build/programs/nokia-e7.ts";

export default defineRuntimeConfig({ profile: "../../profiles/symbian-e7-dev.json", build });
