import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { OutputFormat } from "./args.ts";
import { comparePaths, type PathComparison } from "./compare-paths.ts";
import { runExecutor, type RunExecutorOptions } from "./executors.ts";
import { HARNESS_ROOT } from "./doctor.ts";
import { commandText, runCommand } from "./process.ts";
import type { ExecutorId, LocalInvalidResultV1, PerfRunSummaryV1 } from "./types.ts";

export interface LocalOptions {
  readonly base: string;
  readonly executors: readonly ExecutorId[];
  readonly suite: string;
  readonly repoRoot?: string;
  readonly harnessRoot?: string;
  readonly scenarioDir?: string;
  readonly budgetPath?: string;
  readonly format: OutputFormat;
  readonly out?: string;
  readonly maxEstimatedSeconds: number;
}

export interface LocalDependencies {
  readonly runExecutor?: (options: RunExecutorOptions) => Promise<PerfRunSummaryV1>;
}

export interface LocalSuccess {
  readonly result: PathComparison;
  readonly rendered: string;
}

export interface LocalInvalid {
  readonly result: LocalInvalidResultV1;
  readonly rendered: string;
}

function git(argv: readonly string[], cwd: string): void {
  const result = runCommand(["git", ...argv], { cwd });
  if (result.exitCode !== 0) {
    const detail = new TextDecoder().decode(result.stderr).trim();
    throw new Error(`git ${argv.join(" ")} failed (${result.exitCode})${detail ? `: ${detail}` : ""}`);
  }
}

function addWorktree(repoRoot: string, path: string, revision: string): void {
  git(["worktree", "add", "--detach", path, revision], repoRoot);
}

function overlayTrackedChanges(repoRoot: string, candidateRoot: string): void {
  // `git diff HEAD` includes index and working-tree changes to tracked files.
  // It deliberately excludes every untracked file, including local research
  // notes. The perf harness continues running from harnessRoot instead.
  const patch = runCommand(["git", "diff", "--binary", "--no-ext-diff", "HEAD", "--"], { cwd: repoRoot });
  if (patch.exitCode !== 0) throw new Error("failed to capture tracked candidate changes");
  if (patch.stdout.byteLength === 0) return;
  const applied = runCommand(["git", "apply", "--binary", "--whitespace=nowarn", "-"], {
    cwd: candidateRoot,
    stdin: patch.stdout,
  });
  if (applied.exitCode !== 0) {
    const detail = new TextDecoder().decode(applied.stderr).trim();
    throw new Error(`failed to overlay tracked candidate changes${detail ? `: ${detail}` : ""}`);
  }
}

function installWorkspaceDependencies(sourceRoot: string, label: "baseline" | "candidate"): void {
  const installed = runCommand([process.execPath, "install", "--frozen-lockfile"], { cwd: sourceRoot });
  if (installed.exitCode === 0) return;
  const stderr = new TextDecoder().decode(installed.stderr).trim();
  const stdout = new TextDecoder().decode(installed.stdout).trim();
  const detail = stderr || stdout;
  throw new Error(
    `${label} dependency install failed (${installed.exitCode})${detail ? `: ${detail}` : ""}`,
  );
}

function stageBenchmarkApps(harnessRoot: string, sourceRoot: string): void {
  const fixtures = join(harnessRoot, "tools", "perf", "apps");
  if (!existsSync(fixtures)) return;
  const destination = join(sourceRoot, "tools", "perf", "apps");
  mkdirSync(destination, { recursive: true });
  // These sources define the workload, like scenarios and input tapes. Both
  // revisions compile the same harness app against their own framework/core.
  cpSync(fixtures, destination, { recursive: true, force: true });
}

function safeRemoveTempRoot(path: string): void {
  const expectedPrefix = join(tmpdir(), "pocketjs-perf-local-");
  const absolute = resolve(path);
  if (!absolute.startsWith(expectedPrefix)) {
    throw new Error(`refusing to remove unexpected local perf path: ${absolute}`);
  }
  rmSync(absolute, { recursive: true, force: true });
}

function invalidResult(options: LocalOptions, reasons: readonly string[]): LocalInvalidResultV1 {
  return {
    schemaVersion: 1,
    kind: "pocketjs.perf.local",
    status: "invalid",
    baseRef: options.base,
    suite: options.suite,
    executors: options.executors,
    invalidReasons: reasons,
    temporaryWorktreesCleaned: true,
  };
}

function writeOptionalReport(path: string | undefined, rendered: string): void {
  if (!path) return;
  const output = resolve(path);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, rendered);
}

export async function runLocal(
  options: LocalOptions,
  dependencies: LocalDependencies = {},
): Promise<LocalSuccess | LocalInvalid> {
  const harnessRoot = resolve(options.harnessRoot ?? HARNESS_ROOT);
  const scenarioDir = resolve(options.scenarioDir ?? join(harnessRoot, "tools/perf/scenarios"));
  const execute = dependencies.runExecutor ?? runExecutor;

  // Resolve before registering a worktree, so an invalid user ref has no side effects.
  let repoRoot: string;
  let baseCommit: string;
  let candidateCommit: string;
  try {
    repoRoot = resolve(options.repoRoot ?? commandText(["git", "rev-parse", "--show-toplevel"], harnessRoot));
    baseCommit = commandText(["git", "rev-parse", "--verify", `${options.base}^{commit}`], repoRoot);
    candidateCommit = commandText(["git", "rev-parse", "--verify", "HEAD^{commit}"], repoRoot);
  } catch (error) {
    const result = invalidResult(options, [error instanceof Error ? error.message : String(error)]);
    const rendered = `${JSON.stringify(result, null, 2)}\n`;
    writeOptionalReport(options.out, rendered);
    return { result, rendered };
  }
  const tempRoot = mkdtempSync(join(tmpdir(), "pocketjs-perf-local-"));
  const baselineRoot = join(tempRoot, "baseline-source");
  const candidateRoot = join(tempRoot, "candidate-source");
  const baseReceipts = join(tempRoot, "receipts", "base");
  const candidateReceipts = join(tempRoot, "receipts", "candidate");
  let baselineAdded = false;
  let candidateAdded = false;
  let outcome: LocalSuccess | LocalInvalid;

  try {
    addWorktree(repoRoot, baselineRoot, baseCommit);
    baselineAdded = true;
    addWorktree(repoRoot, candidateRoot, candidateCommit);
    candidateAdded = true;
    overlayTrackedChanges(repoRoot, candidateRoot);
    stageBenchmarkApps(harnessRoot, baselineRoot);
    stageBenchmarkApps(harnessRoot, candidateRoot);
    // Bun's global download cache remains shared, but dependency resolution and
    // node_modules are derived independently from each source snapshot's own
    // package manifest and frozen lockfile.
    installWorkspaceDependencies(baselineRoot, "baseline");
    installWorkspaceDependencies(candidateRoot, "candidate");

    const invalidReasons: string[] = [];
    for (const executor of options.executors) {
      const common = {
        executor,
        suite: options.suite,
        harnessRoot,
        scenarioDir,
        maxEstimatedSeconds: options.maxEstimatedSeconds,
      } as const;
      const baseline = await execute({
        ...common,
        sourceRoot: baselineRoot,
        outDir: join(baseReceipts, executor),
      });
      const candidate = await execute({
        ...common,
        sourceRoot: candidateRoot,
        outDir: join(candidateReceipts, executor),
      });
      if (baseline.status === "invalid") {
        invalidReasons.push(...baseline.invalidReasons.map((reason) => `${executor} baseline: ${reason}`));
      }
      if (candidate.status === "invalid") {
        invalidReasons.push(...candidate.invalidReasons.map((reason) => `${executor} candidate: ${reason}`));
      }
    }
    if (invalidReasons.length > 0) {
      const result = invalidResult(options, invalidReasons);
      const rendered = `${JSON.stringify(result, null, 2)}\n`;
      writeOptionalReport(options.out, rendered);
      outcome = { result, rendered };
    } else {
      outcome = comparePaths({
        base: baseReceipts,
        candidate: candidateReceipts,
        budgetPath: options.budgetPath,
        format: options.format,
        out: options.out,
      });
    }
  } catch (error) {
    const result = invalidResult(options, [error instanceof Error ? error.message : String(error)]);
    const rendered = `${JSON.stringify(result, null, 2)}\n`;
    writeOptionalReport(options.out, rendered);
    outcome = { result, rendered };
  } finally {
    // Remove registrations before deleting their directories. Both commands
    // target only worktrees created under this invocation's mkdtemp root.
    if (candidateAdded) runCommand(["git", "worktree", "remove", "--force", candidateRoot], { cwd: repoRoot });
    if (baselineAdded) runCommand(["git", "worktree", "remove", "--force", baselineRoot], { cwd: repoRoot });
    try {
      safeRemoveTempRoot(tempRoot);
    } finally {
      // macOS may register /var/... worktrees under their /private/var/...
      // canonical path. If `worktree remove` misses that alias, deleting the
      // known mkdtemp root makes it safely prunable; expire it immediately so
      // `perf local` never leaves stale registrations behind.
      runCommand(["git", "worktree", "prune", "--expire", "now"], { cwd: repoRoot });
    }
  }
  return outcome!;
}
