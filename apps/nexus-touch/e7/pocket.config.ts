// apps/nexus-touch/e7 — app-local Pocket config: the baked idle motion
// (apps/nexus/motion.ts) at the wordmark size the homepage chose for 360x640.

import { definePocketConfig } from "@pocketjs/framework/config";
import { FS } from "./art.ts";
import { nexusMotion } from "../../nexus/motion.ts";

export default definePocketConfig({ theme: nexusMotion(FS) });
