import { defineRuntimeConfig } from "../../framework/src/runtime-config.ts";
import profile from "../../profiles/pocketbook.ts";
import { build } from "../../tools/build/programs/pocketbook.ts";

export default defineRuntimeConfig({ profile, build });
