import { defineBuiltinProfile } from "../framework/src/profile.ts";
import psp from "./psp.ts";

/** File-loaded PSP program without a compiled application offload worker. */
export default defineBuiltinProfile({
  ...psp,
  id: "psp-runtime",
  capabilities: psp.capabilities.filter(capability =>
    capability !== "io.offload" && capability !== "text.layout.offload"),
});
