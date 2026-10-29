import { defineRuntimeConfig } from "../../framework/src/runtime-config.ts";
import { build } from "../../tools/build/programs/meizu-m8.ts";

export default defineRuntimeConfig({ profile: "../../profiles/meizu-m8-dev.json", build });
