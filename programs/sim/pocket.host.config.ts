import { defineHostConfig } from "../../framework/src/host-config.ts";
import { build } from "../../tools/build/programs/sim.ts";
export default defineHostConfig({ hosts: ["../../hosts/psp-runtime/pocket.host.json", "../../hosts/vita/pocket.host.json", "../../hosts/3ds-runtime/pocket.host.json"], build });
