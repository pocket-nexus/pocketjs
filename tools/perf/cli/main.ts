import { parsePerfCommand, HELP, UsageError } from "./args.ts";
import { comparePaths, comparisonExitCode } from "./compare-paths.ts";
import { doctorToText, runDoctor } from "./doctor.ts";
import { runExecutor } from "./executors.ts";
import { runLocal } from "./local.ts";

export interface CliIo {
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
}

const DEFAULT_IO: CliIo = {
  stdout(value) { process.stdout.write(value); },
  stderr(value) { process.stderr.write(value); },
};

export async function runPerfCli(args: readonly string[], io: CliIo = DEFAULT_IO): Promise<number> {
  try {
    const parsed = parsePerfCommand(args);
    if (parsed.command === "help") {
      io.stdout(HELP);
      return 0;
    }
    if (parsed.command === "doctor") {
      const result = runDoctor();
      io.stdout(parsed.format === "json" ? `${JSON.stringify(result, null, 2)}\n` : doctorToText(result));
      return result.status === "ok" ? 0 : 2;
    }
    if (parsed.command === "run") {
      const result = await runExecutor({
        executor: parsed.executor,
        suite: parsed.suite,
        sourceRoot: parsed.sourceRoot,
        scenarioDir: parsed.scenarioDir,
        outDir: parsed.outDir,
        maxEstimatedSeconds: parsed.maxEstimatedSeconds,
      });
      io.stdout(`${JSON.stringify(result, null, 2)}\n`);
      return result.status === "valid" ? 0 : 2;
    }
    if (parsed.command === "compare") {
      const { result, rendered } = comparePaths({
        base: parsed.base,
        candidate: parsed.candidate,
        budgetPath: parsed.budget,
        format: parsed.format,
        out: parsed.out,
      });
      io.stdout(rendered);
      return comparisonExitCode(result);
    }
    const { result, rendered } = await runLocal({
      base: parsed.base,
      executors: parsed.executors,
      suite: parsed.suite,
      scenarioDir: parsed.scenarioDir,
      budgetPath: parsed.budget,
      format: parsed.format,
      out: parsed.out,
      maxEstimatedSeconds: parsed.maxEstimatedSeconds,
    });
    io.stdout(rendered);
    if (result.kind === "pocketjs.perf.local") return 2;
    return comparisonExitCode(result);
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`perf: ${error.message}\n\n${HELP}`);
      return 2;
    }
    io.stderr(`perf: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}
