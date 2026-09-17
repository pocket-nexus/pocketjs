import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePerfCommand, UsageError } from "../tools/perf/cli/args.ts";
import { comparePaths, comparisonExitCode } from "../tools/perf/cli/compare-paths.ts";
import { runLocal } from "../tools/perf/cli/local.ts";
import { runPerfCli } from "../tools/perf/cli/main.ts";
import { nativeResultToReceipt, writeReceipt } from "../tools/perf/cli/receipts.ts";
import type { PerfRunSummaryV1 } from "../tools/perf/cli/types.ts";
import { parseScenarioV1, type ReceiptV1 } from "../tools/perf/core/index.ts";
import type { NativeRunResult } from "../tools/perf/runner/native.ts";

const roots: string[] = [];

function temporaryRoot(prefix = "pocketjs-perf-cli-test-"): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function receipt(value: number, revision = "a".repeat(40)): ReceiptV1 {
  return {
    schemaVersion: 1,
    kind: "pocketjs.perf.receipt",
    createdAt: "2026-08-09T00:00:00.000Z",
    status: "valid",
    invalidReasons: [],
    provenance: {
      source: { revision, dirty: false, contentHash: "b".repeat(64) },
      scenario: {
        id: "fixture.v1",
        suite: "quick",
        framework: "solid",
        manifestHash: "9".repeat(64),
        inputTapeHash: "c".repeat(64),
      },
      toolchain: { rustc: "rustc fixture", cCompiler: "cc fixture", sysroot: "/fixture" },
      build: {
        target: "fixture-target",
        profile: "perf",
        rustFlags: [],
        cFlags: [],
        linkerFlags: [],
      },
      executor: {
        id: "native",
        version: "fixture",
        profile: "host-diagnostic",
        fingerprint: "a".repeat(64),
      },
      binary: { sha256: value === 1 ? "d".repeat(64) : "e".repeat(64) },
    },
    correctness: {
      framebufferHash: "1".repeat(64),
      drawListHash: "2".repeat(64),
      stateHash: "3".repeat(64),
      effectHash: "4".repeat(64),
    },
    gateMetrics: ["artifact.bundle_bytes"],
    unsupportedMetrics: [],
    metrics: { "artifact.bundle_bytes": { kind: "exact", value, unit: "bytes" } },
  };
}

function writeBudget(root: string): string {
  const path = join(root, "budget.json");
  writeFileSync(path, JSON.stringify({
    schemaVersion: 1,
    kind: "pocketjs.perf.budget-set",
    id: "fixture",
    metrics: {
      "artifact.bundle_bytes": {
        warn: { relative: 100, absolute: 100 },
        regression: { relative: 200, absolute: 200 },
      },
    },
  }));
  return path;
}

function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

function localDependencyPackage(relativePath: string): string {
  return `${JSON.stringify({
    name: "fixture",
    private: true,
    dependencies: { "fixture-dependency": `file:${relativePath}` },
  }, null, 2)}\n`;
}

function localDependencyLock(relativePath: string): string {
  return `{
  "lockfileVersion": 1,
  "configVersion": 1,
  "workspaces": {
    "": {
      "name": "fixture",
      "dependencies": {
        "fixture-dependency": "file:${relativePath}",
      },
    },
  },
  "packages": {
    "fixture-dependency": ["fixture-dependency@file:${relativePath}", {}],
  }
}\n`;
}

function writeRunSummary(
  root: string,
  receipts: readonly string[],
  overrides: Partial<PerfRunSummaryV1> = {},
): void {
  const summary: PerfRunSummaryV1 = {
    schemaVersion: 1,
    kind: "pocketjs.perf.run",
    status: "valid",
    executor: "native",
    suite: "quick",
    sourceRoot: root,
    outputDir: root,
    receipts,
    invalidReasons: [],
    ...overrides,
  };
  writeFileSync(join(root, "run.json"), `${JSON.stringify(summary, null, 2)}\n`);
}

describe("perf CLI arguments", () => {
  test("parses the four public commands and stable defaults", () => {
    expect(parsePerfCommand(["doctor"])).toEqual({ command: "doctor", format: "text" });
    expect(parsePerfCommand(["run", "--executor", "qemu-armv7-thumb2", "--suite=quick"])).toMatchObject({
      command: "run",
      executor: "qemu-armv7-thumb2",
      suite: "quick",
      maxEstimatedSeconds: 1_500,
    });
    expect(parsePerfCommand(["compare", "--base", "a", "--candidate", "b"])).toMatchObject({
      command: "compare",
      format: "json",
    });
    expect(parsePerfCommand(["local", "--base", "main"])).toMatchObject({
      command: "local",
      executors: ["native", "qemu-armv7-thumb2", "qemu-aarch64"],
      suite: "quick",
    });
  });

  test("rejects unknown executors and options", () => {
    expect(() => parsePerfCommand(["run", "--executor", "arm", "--suite", "quick"])).toThrow(UsageError);
    expect(() => parsePerfCommand(["doctor", "--install=yes"])).toThrow("unknown option --install");
  });

  test("help is available without touching an executor", async () => {
    let output = "";
    const exit = await runPerfCli(["--help"], {
      stdout(value) { output += value; },
      stderr() {},
    });
    expect(exit).toBe(0);
    expect(output).toContain("bun perf doctor");
    expect(output).toContain("bun perf local --base <git-ref>");
  });
});

describe("perf receipt comparison paths", () => {
  test("compares both a receipt pair and receipt directories", () => {
    const root = temporaryRoot();
    const budget = writeBudget(root);
    const baseDir = join(root, "base");
    const candidateDir = join(root, "candidate");
    const base = writeReceipt(baseDir, receipt(1));
    const candidate = writeReceipt(candidateDir, receipt(2));

    const single = comparePaths({ base, candidate, budgetPath: budget, format: "json" });
    expect(single.result.kind).toBe("pocketjs.perf.comparison");
    expect(single.result.status).toBe("pass");

    const directory = comparePaths({ base: baseDir, candidate: candidateDir, budgetPath: budget, format: "markdown" });
    expect(directory.result.kind).toBe("pocketjs.perf.comparison-set");
    expect(directory.result.status).toBe("invalid");
    expect(directory.rendered).toContain("has no run.json summary");
    expect(directory.rendered).toContain("performance comparison set");

    writeRunSummary(baseDir, [base]);
    writeRunSummary(candidateDir, [candidate]);
    const summarized = comparePaths({ base: baseDir, candidate: candidateDir, budgetPath: budget, format: "json" });
    expect(summarized.result.status).toBe("pass");
  });

  test("makes failed run summaries invalidate the directory comparison and CLI", async () => {
    const root = temporaryRoot();
    const budget = writeBudget(root);
    const baseDir = join(root, "base");
    const candidateDir = join(root, "candidate");
    const base = writeReceipt(baseDir, receipt(1));
    const candidate = writeReceipt(candidateDir, receipt(1));
    writeRunSummary(baseDir, [base], { status: "invalid", invalidReasons: ["baseline fixture failed"] });
    writeRunSummary(candidateDir, [candidate], { status: "invalid", invalidReasons: ["candidate fixture failed"] });

    const compared = comparePaths({ base: baseDir, candidate: candidateDir, budgetPath: budget, format: "json" });
    expect(compared.result.status).toBe("invalid");
    expect(comparisonExitCode(compared.result)).toBe(2);
    expect(compared.rendered).toContain("baseline fixture failed");
    expect(compared.rendered).toContain("candidate fixture failed");

    let stdout = "";
    let stderr = "";
    const exit = await runPerfCli([
      "compare",
      "--base", baseDir,
      "--candidate", candidateDir,
      "--budget", budget,
    ], {
      stdout(value) { stdout += value; },
      stderr(value) { stderr += value; },
    });
    expect(exit).toBe(2);
    expect(JSON.parse(stdout).status).toBe("invalid");
    expect(stderr).toBe("");
  });

  test("rejects missing, omitted, and malformed run artifacts", () => {
    const root = temporaryRoot();
    const budget = writeBudget(root);

    const missingBase = join(root, "missing-base");
    const missingCandidate = join(root, "missing-candidate");
    const unlistedBase = writeReceipt(missingBase, receipt(1));
    const unlistedCandidate = writeReceipt(missingCandidate, receipt(1));
    writeRunSummary(missingBase, [join(missingBase, "missing.receipt.json")]);
    writeRunSummary(missingCandidate, [unlistedCandidate]);
    const missing = comparePaths({
      base: missingBase,
      candidate: missingCandidate,
      budgetPath: budget,
      format: "json",
    });
    expect(missing.result.status).toBe("invalid");
    expect(missing.rendered).toContain("listed receipt does not exist");
    expect(missing.rendered).toContain("receipt is not listed by any run summary");
    expect(existsSync(unlistedBase)).toBe(true);

    const malformedBase = join(root, "malformed-base");
    const malformedCandidate = join(root, "malformed-candidate");
    mkdirSync(malformedBase);
    const candidate = writeReceipt(malformedCandidate, receipt(1));
    const malformedReceipt = join(malformedBase, "broken.receipt.json");
    writeFileSync(malformedReceipt, "{ definitely not JSON\n");
    writeRunSummary(malformedBase, [malformedReceipt]);
    writeRunSummary(malformedCandidate, [candidate]);
    const malformed = comparePaths({
      base: malformedBase,
      candidate: malformedCandidate,
      budgetPath: budget,
      format: "json",
    });
    expect(malformed.result.status).toBe("invalid");
    expect(malformed.rendered).toContain("malformed receipt");

    writeFileSync(join(malformedCandidate, "run.json"), JSON.stringify({
      schemaVersion: 1,
      kind: "pocketjs.perf.run",
      status: "valid",
      executor: "native",
      suite: "quick",
      sourceRoot: malformedCandidate,
      outputDir: malformedCandidate,
      receipts: [candidate],
      invalidReasons: [],
      unexpected: true,
    }));
    const malformedSummary = comparePaths({
      base: malformedBase,
      candidate: malformedCandidate,
      budgetPath: budget,
      format: "json",
    });
    expect(malformedSummary.result.status).toBe("invalid");
    expect(malformedSummary.rendered).toContain("unknown fields: unexpected");
  });

  test("requires run executor and suite metadata to match every listed receipt and peer run", () => {
    const root = temporaryRoot();
    const budget = writeBudget(root);
    const baseDir = join(root, "base");
    const candidateDir = join(root, "candidate");
    const base = writeReceipt(baseDir, receipt(1));
    const candidate = writeReceipt(candidateDir, receipt(1));
    writeRunSummary(baseDir, [base]);
    writeRunSummary(candidateDir, [candidate], { executor: "qemu-aarch64" });

    const compared = comparePaths({ base: baseDir, candidate: candidateDir, budgetPath: budget, format: "json" });
    expect(compared.result.status).toBe("invalid");
    expect(compared.rendered).toContain("does not match run summary executor");
    expect(compared.rendered).toContain("no run summary for native/quick");
  });

  test("safely relocates legacy absolute receipt paths with a moved run directory", () => {
    const root = temporaryRoot();
    const budget = writeBudget(root);
    const originalBase = join(root, "original-base");
    const originalCandidate = join(root, "original-candidate");
    const base = writeReceipt(originalBase, receipt(1));
    const candidate = writeReceipt(originalCandidate, receipt(1));
    writeRunSummary(originalBase, [base]);
    writeRunSummary(originalCandidate, [candidate]);
    const movedBase = join(root, "moved-base");
    const movedCandidate = join(root, "moved-candidate");
    renameSync(originalBase, movedBase);
    renameSync(originalCandidate, movedCandidate);

    const compared = comparePaths({
      base: movedBase,
      candidate: movedCandidate,
      budgetPath: budget,
      format: "json",
    });
    expect(compared.result.status).toBe("pass");
  });

  test("turns the native DrawList observation into a schema-valid receipt digest", () => {
    const scenario = parseScenarioV1(JSON.parse(readFileSync(join(import.meta.dir, "../tools/perf/scenarios/boot.json"), "utf8")));
    const native: NativeRunResult = {
      schemaVersion: 1,
      kind: "pocketjs.perf.native-result",
      status: "ok",
      scenarioId: scenario.id,
      executor: "native",
      sourceRoot: join(import.meta.dir, ".."),
      correctness: {
        framebufferTraceHash: "1".repeat(64),
        finalFramebufferHash: "2".repeat(64),
        drawListHash: "fnv1a64:0123456789abcdef",
        stateHash: "3".repeat(64),
        effectHash: "4".repeat(64),
        checkpoints: {},
      },
      measurement: {
        bootWallTimeNs: 1,
        phases: [{ name: "first-frame", startFrame: 0, endFrame: 1, wallTimeNs: 2 }],
        finalFramebufferHash: "2".repeat(64),
        finalDrawListHash: "fnv1a64:0123456789abcdef",
      },
      diagnosticMetrics: {
        "native.wall_time_ns": { value: 2, unit: "ns" },
      },
      exactMetrics: {
        "artifact.bundle_bytes": { value: 1, unit: "bytes" },
      },
      unsupportedMetrics: [
        "guest.instructions",
        "quickjs.live_bytes_after_gc",
      ],
    };
    const converted = nativeResultToReceipt(native, scenario, join(import.meta.dir, ".."));
    expect(converted.status).toBe("valid");
    expect(converted.correctness?.drawListHash).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("perf local isolation", () => {
  test("stages benchmark apps without admitting unrelated untracked files", async () => {
    const repo = temporaryRoot("pocketjs-perf-local-fixture-");
    git(repo, "init", "-b", "main");
    git(repo, "config", "user.name", "Perf Test");
    git(repo, "config", "user.email", "perf@example.invalid");
    git(repo, "config", "commit.gpgsign", "false");
    mkdirSync(join(repo, "vendor", "base-dependency"), { recursive: true });
    mkdirSync(join(repo, "vendor", "candidate-dependency"), { recursive: true });
    writeFileSync(
      join(repo, "vendor", "base-dependency", "package.json"),
      `${JSON.stringify({ name: "fixture-dependency", version: "1.0.0" }, null, 2)}\n`,
    );
    writeFileSync(
      join(repo, "vendor", "candidate-dependency", "package.json"),
      `${JSON.stringify({ name: "fixture-dependency", version: "2.0.0" }, null, 2)}\n`,
    );
    writeFileSync(join(repo, "package.json"), localDependencyPackage("vendor/base-dependency"));
    writeFileSync(join(repo, "bun.lock"), localDependencyLock("vendor/base-dependency"));
    writeFileSync(join(repo, "value.txt"), "1\n");
    git(repo, "add", "value.txt", "package.json", "bun.lock", "vendor");
    git(repo, "commit", "-m", "fixture");
    writeFileSync(join(repo, "value.txt"), "2\n");
    writeFileSync(join(repo, "package.json"), localDependencyPackage("vendor/candidate-dependency"));
    writeFileSync(join(repo, "bun.lock"), localDependencyLock("vendor/candidate-dependency"));
    mkdirSync(join(repo, "notes"));
    writeFileSync(join(repo, "notes", "untracked.md"), "must stay outside snapshots\n");
    mkdirSync(join(repo, "tools", "perf", "apps"), { recursive: true });
    writeFileSync(
      join(repo, "tools", "perf", "apps", "fixture-main.tsx"),
      "export const fixture = 'harness workload';\n",
    );
    const budget = writeBudget(repo);
    const before = git(repo, "worktree", "list", "--porcelain");
    const observedRoots: string[] = [];
    const observedModules: Array<{ realPath: string; version: string }> = [];

    const result = await runLocal({
      base: "HEAD",
      executors: ["native"],
      suite: "quick",
      repoRoot: repo,
      harnessRoot: repo,
      scenarioDir: repo,
      budgetPath: budget,
      format: "json",
      maxEstimatedSeconds: 10,
    }, {
      async runExecutor(options): Promise<PerfRunSummaryV1> {
        const sourceRoot = options.sourceRoot!;
        const outDir = options.outDir!;
        observedRoots.push(sourceRoot);
        expect(existsSync(join(sourceRoot, "notes", "untracked.md"))).toBe(false);
        const nodeModules = join(sourceRoot, "node_modules");
        expect(lstatSync(nodeModules).isSymbolicLink()).toBe(false);
        observedModules.push({
          realPath: realpathSync(nodeModules),
          version: JSON.parse(readFileSync(
            join(nodeModules, "fixture-dependency", "package.json"),
            "utf8",
          )).version,
        });
        expect(readFileSync(
          join(sourceRoot, "tools", "perf", "apps", "fixture-main.tsx"),
          "utf8",
        )).toContain("harness workload");
        const value = Number(readFileSync(join(sourceRoot, "value.txt"), "utf8").trim());
        const path = writeReceipt(outDir, receipt(value, git(sourceRoot, "rev-parse", "HEAD")));
        writeRunSummary(outDir, [path], {
          executor: options.executor,
          suite: options.suite,
          sourceRoot,
          outputDir: outDir,
        });
        return {
          schemaVersion: 1,
          kind: "pocketjs.perf.run",
          status: "valid",
          executor: options.executor,
          suite: options.suite,
          sourceRoot,
          outputDir: outDir,
          receipts: [path],
          invalidReasons: [],
        };
      },
    });

    expect(result.result.status).toBe("pass");
    expect(observedRoots).toHaveLength(2);
    expect(observedModules.map((item) => item.version)).toEqual(["1.0.0", "2.0.0"]);
    expect(observedModules[0]!.realPath).not.toBe(observedModules[1]!.realPath);
    expect(observedRoots.every((path) => !existsSync(path))).toBe(true);
    expect(git(repo, "worktree", "list", "--porcelain")).toBe(before);
    expect(readFileSync(join(repo, "value.txt"), "utf8")).toBe("2\n");
    expect(readFileSync(join(repo, "notes", "untracked.md"), "utf8")).toContain("outside snapshots");
  });

  test("returns structured invalid and cleans worktrees when a frozen install fails", async () => {
    const repo = temporaryRoot("pocketjs-perf-local-install-failure-");
    git(repo, "init", "-b", "main");
    git(repo, "config", "user.name", "Perf Test");
    git(repo, "config", "user.email", "perf@example.invalid");
    git(repo, "config", "commit.gpgsign", "false");
    mkdirSync(join(repo, "vendor", "base-dependency"), { recursive: true });
    mkdirSync(join(repo, "vendor", "candidate-dependency"), { recursive: true });
    writeFileSync(
      join(repo, "vendor", "base-dependency", "package.json"),
      `${JSON.stringify({ name: "fixture-dependency", version: "1.0.0" })}\n`,
    );
    writeFileSync(
      join(repo, "vendor", "candidate-dependency", "package.json"),
      `${JSON.stringify({ name: "fixture-dependency", version: "2.0.0" })}\n`,
    );
    writeFileSync(join(repo, "package.json"), localDependencyPackage("vendor/base-dependency"));
    writeFileSync(join(repo, "bun.lock"), localDependencyLock("vendor/base-dependency"));
    git(repo, "add", "package.json", "bun.lock", "vendor");
    git(repo, "commit", "-m", "fixture");
    // Change only the manifest. A non-frozen install could silently rewrite
    // the candidate lockfile; perf local must instead reject this snapshot.
    writeFileSync(join(repo, "package.json"), localDependencyPackage("vendor/candidate-dependency"));
    const before = git(repo, "worktree", "list", "--porcelain");
    let executorCalls = 0;

    const result = await runLocal({
      base: "HEAD",
      executors: ["native"],
      suite: "quick",
      repoRoot: repo,
      harnessRoot: repo,
      scenarioDir: repo,
      format: "json",
      maxEstimatedSeconds: 10,
    }, {
      async runExecutor(): Promise<PerfRunSummaryV1> {
        executorCalls += 1;
        throw new Error("executor must not run after dependency installation fails");
      },
    });

    expect(result.result.kind).toBe("pocketjs.perf.local");
    expect(result.result.status).toBe("invalid");
    if (result.result.kind !== "pocketjs.perf.local") throw new Error("expected a local invalid result");
    expect(result.result.invalidReasons.join("\n")).toContain("candidate dependency install failed");
    expect(result.result.temporaryWorktreesCleaned).toBe(true);
    expect(executorCalls).toBe(0);
    expect(git(repo, "worktree", "list", "--porcelain")).toBe(before);
  });
});
