import { defineRuntimeConfig } from "../../framework/src/runtime-config.ts";
import { build } from "../../tools/build/programs/iphone4s.ts";

export default defineRuntimeConfig({ profile: "../../profiles/iphone4s-dev.json", build });
