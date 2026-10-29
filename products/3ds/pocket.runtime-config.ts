import { defineRuntimeConfig } from "../../framework/src/runtime-config.ts";
import { build } from "./recipe.ts";
export default defineRuntimeConfig({ profile: "../../profiles/3ds-dev.json", build });
