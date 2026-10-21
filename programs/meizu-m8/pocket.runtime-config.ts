import { defineRuntimeConfig } from "../../framework/src/runtime-config.ts";
import profile from "../../profiles/meizu-m8-dev.ts";
import { build } from "../../tools/build/programs/meizu-m8.ts";

export default defineRuntimeConfig({ profile, build });
