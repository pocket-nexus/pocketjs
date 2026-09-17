import { resolve } from "node:path";
import { loadScenario, runNativeQuick } from "./native.ts";
import { runNativeSuite } from "./suite.ts";
import { isDamageScenario, runNativeDamageScenario } from "../executors/damage.ts";
import { runNativeVaporScenario } from "../executors/vapor.ts";
import { NATIVE_RUN_OUTPUT_PREFIX } from "../receipts/native-protocol.ts";

function value(flag: string): string | undefined {
  const exact = process.argv.indexOf(flag);
  if (exact >= 0) return process.argv[exact + 1];
  const prefix = `${flag}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

const scenarioPath = process.argv[2]?.startsWith("--") ? undefined : process.argv[2];
const suite = value("--suite");
if ((!scenarioPath && !suite) || (scenarioPath && suite)) {
  console.error(
    "usage:\n" +
      "  bun tools/perf/runner/native-cli.ts <scenario.json> [--source-root PATH] " +
      "[--harness-root PATH] [--out-dir PATH]\n" +
      "  bun tools/perf/runner/native-cli.ts --suite quick [--max-estimated-seconds N] " +
      "[--source-root PATH] [--out-dir PATH]",
  );
  process.exit(2);
}

const sourceRoot = resolve(value("--source-root") ?? new URL("../../..", import.meta.url).pathname);
const harnessRoot = resolve(value("--harness-root") ?? new URL("../../..", import.meta.url).pathname);
const outDir = value("--out-dir") ? resolve(value("--out-dir")!) : undefined;
if (suite) {
  const result = await runNativeSuite(suite, {
      sourceRoot,
      harnessRoot,
      outDir,
      maxEstimatedSeconds: value("--max-estimated-seconds")
        ? Number(value("--max-estimated-seconds"))
        : undefined,
    });
  console.log(JSON.stringify(result, null, 2));
  if (result.results.some((item) => item.status === "unsupported")) process.exitCode = 2;
} else {
  const scenario = loadScenario(resolve(scenarioPath!));
  const result = isDamageScenario(scenario)
    ? await runNativeDamageScenario(scenario, { sourceRoot, harnessRoot, outDir })
    : scenario.subject.family === "vapor"
      ? await runNativeVaporScenario(scenario, { sourceRoot, harnessRoot, outDir })
      : await runNativeQuick(scenario, { sourceRoot, outDir });
  console.log(`${NATIVE_RUN_OUTPUT_PREFIX}${JSON.stringify(result)}`);
  if (result.status === "unsupported") process.exitCode = 2;
}
