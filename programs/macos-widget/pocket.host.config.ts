import { defineHostConfig } from "../../framework/src/host-config.ts";
import { widgetBuild as build } from "../../tools/build/programs/desktop.ts";
export default defineHostConfig({ host: "../../hosts/macos-widget/pocket.host.json", build });
