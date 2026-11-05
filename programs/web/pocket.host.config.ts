import { defineHostConfig } from "../../framework/src/host-config.ts";
import { build as build } from "../../tools/build/programs/web.ts";
export default defineHostConfig({ host: "../../hosts/web-app/pocket.host.json", build });
