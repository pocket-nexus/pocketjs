import { defineRuntimeConfig } from "../../framework/src/runtime-config.ts";
import profile from "../../profiles/iphone2g-dev.ts";
import { build } from "../../tools/build/programs/iphone2g.ts";

export default defineRuntimeConfig({ profile, build });
