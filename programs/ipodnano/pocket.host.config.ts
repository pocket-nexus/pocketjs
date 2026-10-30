import { defineHostConfig } from "../../framework/src/host-config.ts";
import { ipodNanoBuild as build } from "../../tools/build/programs/aot.ts";
export default defineHostConfig({ host: "../../hosts/ipodnano/pocket.host.json", build });
