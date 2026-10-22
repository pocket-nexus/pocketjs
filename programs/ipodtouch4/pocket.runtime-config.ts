import { defineRuntimeConfig } from "../../framework/src/runtime-config.ts";
import profile from "../../profiles/ipodtouch4-dev.ts";
import { build } from "../../tools/build/programs/ipodtouch4.ts";

export default defineRuntimeConfig({ profile, build });
