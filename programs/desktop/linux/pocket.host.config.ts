import { defineHostConfig } from "../../../framework/src/host-config.ts";
import { linuxBuild as build } from "../../../tools/build/programs/desktop.ts";
export default defineHostConfig({ host: "../../../hosts/linux-app/pocket.host.json", build });
