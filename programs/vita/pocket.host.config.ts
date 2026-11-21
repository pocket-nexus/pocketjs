import { defineHostConfig } from "../../framework/src/host-config.ts";
import { build } from "../../tools/build/programs/vita.ts";
export default defineHostConfig({ host: "../../hosts/vita/pocket.host.json", build });
