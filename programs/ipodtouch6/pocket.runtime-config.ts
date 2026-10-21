import { defineRuntimeConfig } from "../../framework/src/runtime-config.ts";
import profile from "../../profiles/ipodtouch-dev.ts";
import { build } from "../../tools/build/programs/ipodtouch6.ts";

export default defineRuntimeConfig({ profile, build });
