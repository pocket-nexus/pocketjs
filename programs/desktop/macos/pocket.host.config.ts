import { defineHostConfig } from "../../../framework/src/host-config.ts";
import { macosBuild as build } from "../../../tools/build/programs/desktop.ts";
export default defineHostConfig({ host: "../../../hosts/macos-app/pocket.host.json", build });
