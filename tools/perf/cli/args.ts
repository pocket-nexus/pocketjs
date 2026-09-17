import { EXECUTOR_IDS, type ExecutorId } from "./types.ts";

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export type OutputFormat = "json" | "markdown";

export type PerfCommand =
  | { readonly command: "help" }
  | { readonly command: "doctor"; readonly format: "json" | "text" }
  | {
      readonly command: "run";
      readonly executor: ExecutorId;
      readonly suite: string;
      readonly sourceRoot?: string;
      readonly scenarioDir?: string;
      readonly outDir?: string;
      readonly maxEstimatedSeconds: number;
    }
  | {
      readonly command: "compare";
      readonly base: string;
      readonly candidate: string;
      readonly budget?: string;
      readonly format: OutputFormat;
      readonly out?: string;
    }
  | {
      readonly command: "local";
      readonly base: string;
      readonly executors: readonly ExecutorId[];
      readonly suite: string;
      readonly scenarioDir?: string;
      readonly budget?: string;
      readonly format: OutputFormat;
      readonly out?: string;
      readonly maxEstimatedSeconds: number;
    };

export const HELP = `PocketJS local performance regression runner

Usage:
  bun perf doctor [--json]
  bun perf run --executor <native|qemu-armv7-thumb2|qemu-aarch64> --suite <name> [options]
  bun perf compare --base <receipt-or-directory> --candidate <receipt-or-directory> [options]
  bun perf local --base <git-ref> [options]

Commands:
  doctor   Check local executor prerequisites without installing or building anything.
  run      Run one suite and write versioned receipts.
  compare  Compare one receipt pair, or matching receipts in two directories.
  local    Compare a git baseline with the tracked current worktree in isolated worktrees.

Run options:
  --source-root <path>             Source checkout to measure (default: current repository).
  --scenario-dir <path>            Scenario manifests (default: tools/perf/scenarios).
  --out-dir <path>                 Receipt directory (default: a new system temp directory).
  --max-estimated-seconds <n>      Suite estimate ceiling (default: 1500).

Compare options:
  --budget <path>                  Versioned budget JSON (default: built-in quick budget).
  --format <json|markdown>         Output format (default: json).
  --out <path>                     Also write the comparison report to this path.

Local options:
  --executor <id|all>              Executor to run (repeatable; default: all).
  --suite <name>                   Suite name (default: quick).
  --scenario-dir, --budget, --format, --out and --max-estimated-seconds are also accepted.

Exit status: 0 pass/warn, 1 regression, 2 invalid usage, prerequisites, or receipts.
`;

interface ParsedFlags {
  readonly values: ReadonlyMap<string, readonly string[]>;
  readonly booleans: ReadonlySet<string>;
}

function flags(args: readonly string[], booleanNames: readonly string[] = []): ParsedFlags {
  const booleans = new Set<string>();
  const values = new Map<string, string[]>();
  const booleanSet = new Set(booleanNames);
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (!token.startsWith("--")) throw new UsageError(`unexpected positional argument ${JSON.stringify(token)}`);
    const equal = token.indexOf("=");
    const name = equal >= 0 ? token.slice(2, equal) : token.slice(2);
    if (booleanSet.has(name)) {
      if (equal >= 0) throw new UsageError(`--${name} does not take a value`);
      booleans.add(name);
      continue;
    }
    const value = equal >= 0 ? token.slice(equal + 1) : args[++index];
    if (value === undefined || value.startsWith("--")) throw new UsageError(`--${name} requires a value`);
    const existing = values.get(name) ?? [];
    values.set(name, [...existing, value]);
  }
  return { values, booleans };
}

function rejectUnknown(parsed: ParsedFlags, allowedValues: readonly string[], allowedBooleans: readonly string[] = []): void {
  const allowedValueSet = new Set(allowedValues);
  const allowedBooleanSet = new Set(allowedBooleans);
  for (const name of parsed.values.keys()) {
    if (!allowedValueSet.has(name)) throw new UsageError(`unknown option --${name}`);
  }
  for (const name of parsed.booleans) {
    if (!allowedBooleanSet.has(name)) throw new UsageError(`unknown option --${name}`);
  }
}

function one(parsed: ParsedFlags, name: string, required = false): string | undefined {
  const found = parsed.values.get(name) ?? [];
  if (found.length > 1) throw new UsageError(`--${name} may only be supplied once`);
  if (required && found.length === 0) throw new UsageError(`missing required option --${name}`);
  return found[0];
}

function executor(value: string): ExecutorId {
  if ((EXECUTOR_IDS as readonly string[]).includes(value)) return value as ExecutorId;
  throw new UsageError(`unknown executor ${JSON.stringify(value)}`);
}

function format(value: string | undefined): OutputFormat {
  if (value === undefined || value === "json") return "json";
  if (value === "markdown") return "markdown";
  throw new UsageError(`--format must be json or markdown`);
}

function seconds(value: string | undefined): number {
  if (value === undefined) return 1_500;
  const result = Number(value);
  if (!Number.isFinite(result) || result <= 0) {
    throw new UsageError(`--max-estimated-seconds must be a positive number`);
  }
  return result;
}

export function parsePerfCommand(args: readonly string[]): PerfCommand {
  if (args.length === 0 || args[0] === "help" || args[0] === "--help" || args[0] === "-h") {
    return { command: "help" };
  }
  const command = args[0]!;
  const rest = args.slice(1);
  if (rest.includes("--help") || rest.includes("-h")) return { command: "help" };

  if (command === "doctor") {
    const parsed = flags(rest, ["json"]);
    rejectUnknown(parsed, [], ["json"]);
    return { command, format: parsed.booleans.has("json") ? "json" : "text" };
  }
  if (command === "run") {
    const parsed = flags(rest);
    rejectUnknown(parsed, ["executor", "suite", "source-root", "scenario-dir", "out-dir", "max-estimated-seconds"]);
    return {
      command,
      executor: executor(one(parsed, "executor", true)!),
      suite: one(parsed, "suite", true)!,
      sourceRoot: one(parsed, "source-root"),
      scenarioDir: one(parsed, "scenario-dir"),
      outDir: one(parsed, "out-dir"),
      maxEstimatedSeconds: seconds(one(parsed, "max-estimated-seconds")),
    };
  }
  if (command === "compare") {
    const parsed = flags(rest);
    rejectUnknown(parsed, ["base", "candidate", "budget", "format", "out"]);
    return {
      command,
      base: one(parsed, "base", true)!,
      candidate: one(parsed, "candidate", true)!,
      budget: one(parsed, "budget"),
      format: format(one(parsed, "format")),
      out: one(parsed, "out"),
    };
  }
  if (command === "local") {
    const parsed = flags(rest);
    rejectUnknown(parsed, ["base", "executor", "suite", "scenario-dir", "budget", "format", "out", "max-estimated-seconds"]);
    const rawExecutors = parsed.values.get("executor") ?? ["all"];
    const executors = rawExecutors.includes("all")
      ? EXECUTOR_IDS
      : rawExecutors.map(executor);
    if (rawExecutors.includes("all") && rawExecutors.length > 1) {
      throw new UsageError(`--executor all cannot be combined with another executor`);
    }
    return {
      command,
      base: one(parsed, "base", true)!,
      executors: [...new Set(executors)],
      suite: one(parsed, "suite") ?? "quick",
      scenarioDir: one(parsed, "scenario-dir"),
      budget: one(parsed, "budget"),
      format: format(one(parsed, "format")),
      out: one(parsed, "out"),
      maxEstimatedSeconds: seconds(one(parsed, "max-estimated-seconds")),
    };
  }
  throw new UsageError(`unknown command ${JSON.stringify(command)}`);
}
