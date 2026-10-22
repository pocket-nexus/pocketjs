import { defineRuntimeConfig } from "../../framework/src/runtime-config.ts";
import profile from "../../profiles/iphone4s-dev.ts";
import { build } from "../../tools/build/programs/iphone4s.ts";

export default defineRuntimeConfig({ profile, build });
