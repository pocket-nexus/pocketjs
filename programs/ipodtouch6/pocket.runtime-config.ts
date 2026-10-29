import { defineRuntimeConfig } from "../../framework/src/runtime-config.ts";
import { build } from "../../tools/build/programs/ipodtouch6.ts";

export default defineRuntimeConfig({ profile: "../../profiles/ipodtouch-dev.json", build });
