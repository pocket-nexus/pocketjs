import { defineRuntimeConfig } from "../../framework/src/runtime-config.ts";
import { build } from "../../tools/build/programs/ipodtouch4.ts";

export default defineRuntimeConfig({ profile: "../../profiles/ipodtouch4-dev.json", build });
