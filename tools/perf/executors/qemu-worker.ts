import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseScenarioV1 } from "../core/index.ts";
import { runVaporScenario } from "./vapor.ts";

export const QEMU_WORKER_OUTPUT_PREFIX = "POCKETJS_PERF_QEMU_WORKER ";

function flag(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const scenario = parseScenarioV1(JSON.parse(readFileSync(resolve(flag("--scenario")), "utf8")));
const executor = flag("--executor");
if (executor !== "qemu-armv7-thumb2" && executor !== "qemu-aarch64") {
  throw new Error(`unsupported QEMU worker executor ${JSON.stringify(executor)}`);
}
const result = await runVaporScenario({
  scenario,
  executor,
  sourceRoot: resolve(flag("--source-root")),
  harnessRoot: resolve(flag("--harness-root")),
  outDir: resolve(flag("--out-dir")),
  image: flag("--image"),
});
console.log(`${QEMU_WORKER_OUTPUT_PREFIX}${JSON.stringify(result)}`);
if (result.status === "invalid") process.exitCode = 2;
