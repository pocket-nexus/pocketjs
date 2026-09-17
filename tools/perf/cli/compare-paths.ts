import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  DEFAULT_BUDGET_SET,
  compareReceipts,
  comparisonToMarkdown,
  parseBudgetSetV1,
  type BudgetSetV1,
  type ComparisonStatus,
  type ComparisonV1,
  type ReceiptV1,
} from "../core/index.ts";
import type { OutputFormat } from "./args.ts";
import { readReceipt } from "./receipts.ts";
import {
  EXECUTOR_IDS,
  type ComparisonSetEntryV1,
  type ComparisonSetV1,
  type ExecutorId,
  type PerfRunSummaryV1,
} from "./types.ts";

function statusRank(status: ComparisonStatus): number {
  return { pass: 0, warn: 1, regression: 2, invalid: 3 }[status];
}

function worst(statuses: readonly ComparisonStatus[]): ComparisonStatus {
  return statuses.reduce<ComparisonStatus>(
    (current, status) => statusRank(status) > statusRank(current) ? status : current,
    "pass",
  );
}

function receiptKey(receipt: ReceiptV1): string {
  const { scenario, executor, build } = receipt.provenance;
  return [executor.id, executor.profile, build.target, scenario.suite, scenario.id, scenario.framework].join("/");
}

function findFiles(root: string, matches: (name: string) => boolean): string[] {
  const result: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && matches(entry.name)) result.push(path);
    }
  };
  visit(root);
  return result;
}

function findReceiptFiles(root: string): string[] {
  return findFiles(root, (name) => name.endsWith(".receipt.json"));
}

function findRunSummaryFiles(root: string): string[] {
  return findFiles(root, (name) => name === "run.json");
}

function parseRunSummary(value: unknown): PerfRunSummaryV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("run summary must be an object");
  }
  const record = value as Record<string, unknown>;
  const expected = [
    "schemaVersion",
    "kind",
    "status",
    "executor",
    "suite",
    "sourceRoot",
    "outputDir",
    "receipts",
    "invalidReasons",
  ];
  const missing = expected.filter((key) => !(key in record));
  const unknown = Object.keys(record).filter((key) => !expected.includes(key));
  if (missing.length > 0 || unknown.length > 0) {
    const reasons = [
      ...missing.length > 0 ? [`missing fields: ${missing.join(", ")}`] : [],
      ...unknown.length > 0 ? [`unknown fields: ${unknown.sort().join(", ")}`] : [],
    ];
    throw new Error(`run summary has invalid fields (${reasons.join("; ")})`);
  }
  if (record.schemaVersion !== 1) throw new Error("run summary schemaVersion must be 1");
  if (record.kind !== "pocketjs.perf.run") throw new Error("run summary kind must be pocketjs.perf.run");
  if (record.status !== "valid" && record.status !== "invalid") {
    throw new Error("run summary status must be valid or invalid");
  }
  if (typeof record.executor !== "string" || !EXECUTOR_IDS.includes(record.executor as ExecutorId)) {
    throw new Error(`run summary executor is unsupported: ${JSON.stringify(record.executor)}`);
  }
  for (const field of ["suite", "sourceRoot", "outputDir"] as const) {
    if (typeof record[field] !== "string" || record[field].length === 0) {
      throw new Error(`run summary ${field} must be a non-empty string`);
    }
  }
  if (!Array.isArray(record.receipts) || record.receipts.some((path) => typeof path !== "string" || path.length === 0)) {
    throw new Error("run summary receipts must be an array of non-empty strings");
  }
  if (!Array.isArray(record.invalidReasons) || record.invalidReasons.some((reason) => typeof reason !== "string")) {
    throw new Error("run summary invalidReasons must be an array of strings");
  }
  if (record.status === "valid" && record.invalidReasons.length > 0) {
    throw new Error("a valid run summary must not contain invalidReasons");
  }
  if (record.status === "invalid" && record.invalidReasons.length === 0) {
    throw new Error("an invalid run summary must contain at least one invalidReason");
  }
  return {
    schemaVersion: 1,
    kind: "pocketjs.perf.run",
    status: record.status,
    executor: record.executor as ExecutorId,
    suite: record.suite as string,
    sourceRoot: record.sourceRoot as string,
    outputDir: record.outputDir as string,
    receipts: record.receipts as string[],
    invalidReasons: record.invalidReasons as string[],
  };
}

interface DirectoryIssue {
  readonly path: string | null;
  readonly reason: string;
}

interface RunSummaryRecord {
  readonly path: string;
  readonly summary: PerfRunSummaryV1;
}

interface DirectoryContents {
  readonly receipts: Map<string, { path: string; receipt: ReceiptV1 }>;
  readonly receiptByRealPath: Map<string, { path: string; receipt: ReceiptV1 } | null>;
  readonly runSummaryFiles: readonly string[];
  readonly summaries: readonly RunSummaryRecord[];
  readonly issues: DirectoryIssue[];
}

function containedRelativePath(path: string): boolean {
  return path.length > 0 && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function listedReceiptCandidates(runPath: string, summary: PerfRunSummaryV1, listed: string): string[] {
  if (!isAbsolute(listed)) return [resolve(dirname(runPath), listed)];
  const result: string[] = [];
  // Version 1 originally wrote absolute paths. If the complete run directory
  // was moved, relocate only the suffix that was safely below its recorded
  // outputDir; never reinterpret a path that escaped that directory.
  if (isAbsolute(summary.outputDir)) {
    const local = relative(resolve(summary.outputDir), resolve(listed));
    if (containedRelativePath(local)) result.push(resolve(dirname(runPath), local));
  }
  result.push(resolve(listed));
  return [...new Set(result)];
}

function scanDirectory(root: string): DirectoryContents {
  const receipts = new Map<string, { path: string; receipt: ReceiptV1 }>();
  const receiptByRealPath = new Map<string, { path: string; receipt: ReceiptV1 } | null>();
  const issues: DirectoryIssue[] = [];
  const receiptFiles = findReceiptFiles(root);
  for (const path of receiptFiles) {
    let realPath: string;
    try {
      realPath = realpathSync(path);
    } catch (error) {
      issues.push({ path, reason: `cannot resolve receipt: ${error instanceof Error ? error.message : String(error)}` });
      continue;
    }
    try {
      const receipt = readReceipt(path);
      const item = { path, receipt };
      receiptByRealPath.set(realPath, item);
      const key = receiptKey(receipt);
      const previous = receipts.get(key);
      if (previous) {
        issues.push({
          path,
          reason: `duplicate receipt identity ${JSON.stringify(key)} also appears in ${relative(root, previous.path)}`,
        });
        continue;
      }
      receipts.set(key, item);
    } catch (error) {
      receiptByRealPath.set(realPath, null);
      issues.push({ path, reason: `malformed receipt: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  if (receiptFiles.length === 0) issues.push({ path: null, reason: `no *.receipt.json files found in ${root}` });

  const runSummaryFiles = findRunSummaryFiles(root);
  const summaries: RunSummaryRecord[] = [];
  for (const path of runSummaryFiles) {
    try {
      const summary = parseRunSummary(JSON.parse(readFileSync(path, "utf8")));
      summaries.push({ path, summary });
    } catch (error) {
      issues.push({ path, reason: `malformed run summary: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  return { receipts, receiptByRealPath, runSummaryFiles, summaries, issues };
}

function validateRunSummaries(root: string, contents: DirectoryContents): Map<string, RunSummaryRecord> {
  const identities = new Map<string, RunSummaryRecord>();
  const listedReceipts = new Map<string, string>();
  const suites = new Set<string>();
  for (const item of contents.summaries) {
    const { path, summary } = item;
    suites.add(summary.suite);
    const identity = `${summary.executor}/${summary.suite}`;
    const previous = identities.get(identity);
    if (previous) {
      contents.issues.push({
        path,
        reason: `duplicate run summary for executor/suite ${JSON.stringify(identity)}; first appears in ${relative(root, previous.path)}`,
      });
    } else {
      identities.set(identity, item);
    }
    if (summary.status !== "valid") {
      contents.issues.push({
        path,
        reason: `run summary status is invalid: ${summary.invalidReasons.join("; ")}`,
      });
    }
    if (summary.receipts.length === 0) {
      contents.issues.push({ path, reason: "run summary lists no receipts" });
    }
    for (const listed of summary.receipts) {
      const candidates = listedReceiptCandidates(path, summary, listed);
      let realPath: string | null = null;
      let foundFileOutsideTree = false;
      let inspectionFailure: string | null = null;
      for (const listedPath of candidates) {
        if (!existsSync(listedPath)) continue;
        try {
          if (!statSync(listedPath).isFile()) {
            inspectionFailure = `listed receipt is not a file: ${listed}`;
            continue;
          }
          const candidateRealPath = realpathSync(listedPath);
          if (!contents.receiptByRealPath.has(candidateRealPath)) {
            foundFileOutsideTree = true;
            continue;
          }
          realPath = candidateRealPath;
          break;
        } catch (error) {
          inspectionFailure = `cannot inspect listed receipt ${listed}: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
      if (realPath === null) {
        contents.issues.push({
          path,
          reason: inspectionFailure ?? (foundFileOutsideTree
            ? `listed receipt is not a *.receipt.json file inside the compared directory: ${listed}`
            : `listed receipt does not exist: ${listed}`),
        });
        continue;
      }
      const previousOwner = listedReceipts.get(realPath);
      if (previousOwner) {
        contents.issues.push({
          path,
          reason: `receipt ${listed} is listed more than once; first listed by ${relative(root, previousOwner)}`,
        });
      } else {
        listedReceipts.set(realPath, path);
      }
      const parsed = contents.receiptByRealPath.get(realPath);
      if (!parsed) continue;
      if (parsed.receipt.provenance.executor.id !== summary.executor) {
        contents.issues.push({
          path: parsed.path,
          reason: `receipt executor ${parsed.receipt.provenance.executor.id} does not match run summary executor ${summary.executor}`,
        });
      }
      if (parsed.receipt.provenance.scenario.suite !== summary.suite) {
        contents.issues.push({
          path: parsed.path,
          reason: `receipt suite ${JSON.stringify(parsed.receipt.provenance.scenario.suite)} does not match run summary suite ${JSON.stringify(summary.suite)}`,
        });
      }
      if (parsed.receipt.status !== "valid") {
        contents.issues.push({ path: parsed.path, reason: "a valid run summary lists an invalid receipt" });
      }
    }
  }
  if (suites.size > 1) {
    contents.issues.push({
      path: null,
      reason: `run summaries disagree on suite: ${[...suites].sort().join(", ")}`,
    });
  }
  for (const [realPath, parsed] of contents.receiptByRealPath) {
    if (!listedReceipts.has(realPath)) {
      contents.issues.push({
        path: parsed?.path ?? realPath,
        reason: "receipt is not listed by any run summary",
      });
    }
  }
  return identities;
}

function displayedPath(root: string, path: string | null): string | null {
  if (path === null) return null;
  const result = relative(root, path);
  return result.length > 0 && !result.startsWith("..") ? result : path;
}

function issueEntries(
  side: "baseline" | "candidate",
  root: string,
  issues: readonly DirectoryIssue[],
): ComparisonSetEntryV1[] {
  return issues.map((issue, index) => ({
    key: `!validation/${side}/${String(index + 1).padStart(4, "0")}`,
    status: "invalid",
    basePath: side === "baseline" ? displayedPath(root, issue.path) : null,
    candidatePath: side === "candidate" ? displayedPath(root, issue.path) : null,
    comparison: null,
    reason: issue.reason,
  }));
}

function compareDirectories(baseRoot: string, candidateRoot: string, budget: BudgetSetV1): ComparisonSetV1 {
  const base = scanDirectory(baseRoot);
  const candidate = scanDirectory(candidateRoot);
  if (base.runSummaryFiles.length === 0) {
    base.issues.push({ path: null, reason: "baseline directory has no run.json summary" });
  }
  if (candidate.runSummaryFiles.length === 0) {
    candidate.issues.push({ path: null, reason: "candidate directory has no run.json summary" });
  }
  const baseRuns = validateRunSummaries(baseRoot, base);
  const candidateRuns = validateRunSummaries(candidateRoot, candidate);
  for (const identity of [...new Set([...baseRuns.keys(), ...candidateRuns.keys()])].sort()) {
    if (!baseRuns.has(identity)) {
      base.issues.push({ path: null, reason: `baseline directory has no run summary for ${identity}` });
    }
    if (!candidateRuns.has(identity)) {
      candidate.issues.push({ path: null, reason: `candidate directory has no run summary for ${identity}` });
    }
  }

  const keys = [...new Set([...base.receipts.keys(), ...candidate.receipts.keys()])].sort();
  const receiptEntries: ComparisonSetEntryV1[] = keys.map((key) => {
    const left = base.receipts.get(key);
    const right = candidate.receipts.get(key);
    if (!left || !right) {
      const missing = left ? "candidate" : "baseline";
      return {
        key,
        status: "invalid",
        basePath: left ? relative(baseRoot, left.path) : null,
        candidatePath: right ? relative(candidateRoot, right.path) : null,
        comparison: null,
        reason: `${missing} directory has no matching receipt`,
      };
    }
    const comparison = compareReceipts(left.receipt, right.receipt, budget);
    return {
      key,
      status: comparison.status,
      basePath: relative(baseRoot, left.path),
      candidatePath: relative(candidateRoot, right.path),
      comparison,
      reason: null,
    };
  });
  const entries = [
    ...issueEntries("baseline", baseRoot, base.issues),
    ...issueEntries("candidate", candidateRoot, candidate.issues),
    ...receiptEntries,
  ];
  const status = worst(entries.map((entry) => entry.status));
  return {
    schemaVersion: 1,
    kind: "pocketjs.perf.comparison-set",
    status,
    comparable: entries.length > 0 && entries.every((entry) => entry.comparison?.comparable === true),
    entries,
  };
}

function comparisonSetToMarkdown(result: ComparisonSetV1): string {
  const lines = [
    "# PocketJS performance comparison set",
    "",
    `Status: **${result.status}**`,
    "",
    "| Receipt | Status | Base | Candidate |",
    "| --- | --- | --- | --- |",
    ...result.entries.map((entry) =>
      `| \`${entry.key}\` | **${entry.status}** | ${entry.basePath ? `\`${entry.basePath}\`` : "—"} | ${entry.candidatePath ? `\`${entry.candidatePath}\`` : "—"} |`),
  ];
  for (const entry of result.entries) {
    if (entry.reason) lines.push("", `- \`${entry.key}\`: ${entry.reason}`);
    if (entry.comparison && entry.comparison.status !== "pass") {
      lines.push("", `## ${entry.key}`, "", comparisonToMarkdown(entry.comparison).trim());
    }
  }
  return `${lines.join("\n")}\n`;
}

export type PathComparison = ComparisonV1 | ComparisonSetV1;

export interface ComparePathsOptions {
  readonly base: string;
  readonly candidate: string;
  readonly budgetPath?: string;
  readonly format: OutputFormat;
  readonly out?: string;
}

export function loadBudget(path?: string): BudgetSetV1 {
  return path
    ? parseBudgetSetV1(JSON.parse(readFileSync(resolve(path), "utf8")))
    : DEFAULT_BUDGET_SET;
}

export function comparePaths(options: ComparePathsOptions): { result: PathComparison; rendered: string } {
  const base = resolve(options.base);
  const candidate = resolve(options.candidate);
  if (!existsSync(base)) throw new Error(`baseline path does not exist: ${base}`);
  if (!existsSync(candidate)) throw new Error(`candidate path does not exist: ${candidate}`);
  const baseDirectory = statSync(base).isDirectory();
  const candidateDirectory = statSync(candidate).isDirectory();
  if (baseDirectory !== candidateDirectory) {
    throw new Error("--base and --candidate must both be receipt files or both be receipt directories");
  }
  const budget = loadBudget(options.budgetPath);
  const result = baseDirectory
    ? compareDirectories(base, candidate, budget)
    : compareReceipts(readReceipt(base), readReceipt(candidate), budget);
  const rendered = options.format === "markdown"
    ? result.kind === "pocketjs.perf.comparison-set"
      ? comparisonSetToMarkdown(result)
      : comparisonToMarkdown(result)
    : `${JSON.stringify(result, null, 2)}\n`;
  if (options.out) {
    const output = resolve(options.out);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, rendered);
  }
  return { result, rendered };
}

export function comparisonExitCode(result: PathComparison): number {
  if (result.status === "regression") return 1;
  if (result.status === "invalid") return 2;
  return 0;
}
