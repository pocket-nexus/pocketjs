import { defineRuntimeConfig } from "../../framework/src/runtime-config.ts";
import { build } from "../../tools/build/programs/blackberry-classic.ts";

export default defineRuntimeConfig({ profile: "../../profiles/blackberry-qnx-dev.json", build });
