import { defineRuntimeConfig } from "../../framework/src/runtime-config.ts";
import { build } from "../../tools/build/programs/iphone2g.ts";

export default defineRuntimeConfig({ profile: "../../profiles/iphone2g-dev.json", build });
