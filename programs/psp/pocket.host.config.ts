import { defineHostConfig } from "../../framework/src/host-config.ts";
import { build } from "../../tools/build/programs/psp.ts";
export default defineHostConfig({ host: "../../hosts/psp/pocket.host.json", build });
