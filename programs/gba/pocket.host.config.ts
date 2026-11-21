import { defineHostConfig } from "../../framework/src/host-config.ts";
import { gbaBuild as build } from "../../tools/build/programs/aot.ts";
export default defineHostConfig({ host: "../../hosts/gba/pocket.host.json", build });
