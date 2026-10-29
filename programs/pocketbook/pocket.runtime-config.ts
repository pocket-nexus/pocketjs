import { defineRuntimeConfig } from "../../framework/src/runtime-config.ts";
import { build } from "../../tools/build/programs/pocketbook.ts";

export default defineRuntimeConfig({ profile: "../../profiles/pocketbook.json", build });
