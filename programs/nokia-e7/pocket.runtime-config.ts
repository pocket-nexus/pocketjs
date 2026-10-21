import { defineRuntimeConfig } from "../../framework/src/runtime-config.ts";
import profile from "../../profiles/symbian-e7-dev.ts";
import { build } from "../../tools/build/programs/nokia-e7.ts";

export default defineRuntimeConfig({ profile, build });
