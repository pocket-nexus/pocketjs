import { defineHostConfig } from "../../framework/src/host-config.ts";
import { build } from "./recipe.ts";
export default defineHostConfig({ host: "../../hosts/3ds-dev/pocket.host.json", build });
