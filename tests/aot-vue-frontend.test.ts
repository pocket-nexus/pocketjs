import { expect, test } from "bun:test";
import { relative, resolve } from "node:path";
import { analyzeVueAot } from "../vapor/compiler/aot-frontend.ts";
const root = resolve(import.meta.dir, "..");
export const portableAot = (program: unknown) => JSON.parse(JSON.stringify(program, (key, value) => key === "file" && typeof value === "string" ? relative(root, value) : value));
test("Vue feature lab View IR", () => {
  expect(portableAot(analyzeVueAot(resolve(root, "apps/vue-sfc-lab/app.vue"), { strict: true }))).toMatchSnapshot();
});
