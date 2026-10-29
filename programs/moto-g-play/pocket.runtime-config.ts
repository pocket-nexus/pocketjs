import { defineRuntimeConfig } from "../../framework/src/runtime-config.ts";
import { build } from "../../tools/build/programs/moto-g-play.ts";

export default defineRuntimeConfig({ profile: "../../profiles/moto-g-play-dev.json", build });
