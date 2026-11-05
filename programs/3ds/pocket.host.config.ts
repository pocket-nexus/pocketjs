import { defineHostConfig } from "../../framework/src/host-config.ts";
import { build } from "../../tools/build/programs/3ds.ts";
export default defineHostConfig({ host: "../../hosts/3ds-runtime/pocket.host.json", build });
