import { defineRuntimeConfig } from "../../framework/src/runtime-config.ts";
import profile from "../../profiles/blackberry-qnx-dev.ts";
import { build } from "../../tools/build/programs/blackberry-classic.ts";

export default defineRuntimeConfig({ profile, build });
