import { defineHostConfig } from "../../../framework/src/host-config.ts";
import { genericBuild as build } from "../../../tools/build/programs/psp.ts";
export default defineHostConfig({ host: "../../../hosts/psp-runtime/pocket.host.json", build });
