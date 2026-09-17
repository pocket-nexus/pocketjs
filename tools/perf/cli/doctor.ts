import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runCommand } from "./process.ts";
import { EXECUTOR_IDS, type DoctorCheckV1, type DoctorResultV1, type ExecutorId } from "./types.ts";

export const HARNESS_ROOT = resolve(new URL("../../..", import.meta.url).pathname);

export function qemuBridgePath(harnessRoot = HARNESS_ROOT): string | null {
  for (const relative of [
    "tools/perf/executors/qemu.ts",
    "tools/perf/qemu/bridge.ts",
    "tools/perf/qemu/runner.ts",
  ]) {
    const path = join(harnessRoot, relative);
    if (existsSync(path)) return path;
  }
  return null;
}

function executableCheck(
  id: string,
  argv: readonly string[],
  executors: readonly ExecutorId[],
  cwd: string,
): DoctorCheckV1 {
  const result = runCommand(argv, { cwd });
  const stdout = new TextDecoder().decode(result.stdout).trim();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  const failure = (stderr || stdout).split(/\r?\n/, 1)[0] || `${argv[0]} is unavailable`;
  return {
    id,
    status: result.exitCode === 0 ? "ok" : "missing",
    detail: result.exitCode === 0 ? (stdout || stderr).split(/\r?\n/, 1)[0]! : failure,
    executors,
  };
}

function fileCheck(id: string, path: string, executors: readonly ExecutorId[]): DoctorCheckV1 {
  return {
    id,
    status: existsSync(path) ? "ok" : "missing",
    detail: existsSync(path) ? path : `missing ${path}`,
    executors,
  };
}

function outputContainsCheck(
  id: string,
  argv: readonly string[],
  expected: string,
  executors: readonly ExecutorId[],
  cwd: string,
): DoctorCheckV1 {
  const result = runCommand(argv, { cwd });
  const output = `${new TextDecoder().decode(result.stdout)}\n${new TextDecoder().decode(result.stderr)}`;
  const ok = result.exitCode === 0 && output.split(/\r?\n/).includes(expected);
  return {
    id,
    status: ok ? "ok" : "missing",
    detail: ok ? expected : `missing ${expected}`,
    executors,
  };
}

export function runDoctor(harnessRoot = HARNESS_ROOT): DoctorResultV1 {
  const qemuExecutors = ["qemu-armv7-thumb2", "qemu-aarch64"] as const;
  const all = EXECUTOR_IDS;
  const checks: DoctorCheckV1[] = [
    executableCheck("bun", [process.execPath, "--version"], all, harnessRoot),
    executableCheck("git", ["git", "--version"], all, harnessRoot),
    executableCheck("rustc", ["rustc", "--version"], all, harnessRoot),
    executableCheck("cargo", ["cargo", "--version"], all, harnessRoot),
    outputContainsCheck(
      "wasm-target",
      ["rustup", "target", "list", "--installed"],
      "wasm32-unknown-unknown",
      all,
      harnessRoot,
    ),
    fileCheck("workspace-dependencies", join(harnessRoot, "node_modules"), all),
    fileCheck("native-perf-host", join(harnessRoot, "tools/perf/runner/native-world.ts"), all),
    fileCheck("wasm-host-binding", join(harnessRoot, "hosts/web/wasm-ops.js"), all),
    fileCheck("build-driver", join(harnessRoot, "tools/build.ts"), all),
    fileCheck("scenario-schema", join(harnessRoot, "tools/perf/core/schema.ts"), all),
    executableCheck("docker-cli", ["docker", "--version"], qemuExecutors, harnessRoot),
    executableCheck("docker-daemon", ["docker", "info", "--format", "{{.ServerVersion}}"], qemuExecutors, harnessRoot),
    fileCheck("qemu-plugin", join(harnessRoot, "tools/perf/qemu/perf_counter.c"), qemuExecutors),
    fileCheck("qemu-container", join(harnessRoot, "tools/perf/qemu/Dockerfile"), qemuExecutors),
    fileCheck("qemu-runner-container", join(harnessRoot, "tools/perf/qemu/Dockerfile.runner"), qemuExecutors),
    executableCheck(
      "qemu-runner-image",
      ["docker", "image", "inspect", "pocketjs-perf-qemu:11.0.3", "--format", "{{.Id}}"],
      qemuExecutors,
      harnessRoot,
    ),
    {
      id: "qemu-version-pin",
      status: existsSync(join(harnessRoot, "tools/perf/qemu/Dockerfile")) &&
          readFileSync(join(harnessRoot, "tools/perf/qemu/Dockerfile"), "utf8").includes("11.0.3")
        ? "ok"
        : "mismatch",
      detail: "QEMU linux-user and plugin must be built from pinned 11.0.3 sources",
      executors: qemuExecutors,
    },
    {
      id: "qemu-run-bridge",
      status: qemuBridgePath(harnessRoot) ? "ok" : "missing",
      detail: qemuBridgePath(harnessRoot) ?? "missing tools/perf/executors/qemu.ts",
      executors: qemuExecutors,
    },
  ];
  const executorResult = (executor: ExecutorId): DoctorResultV1["executors"][ExecutorId] => {
    const failed = checks.filter((check) => check.executors.includes(executor) && check.status !== "ok");
    return {
      ready: failed.length === 0,
      reasons: failed.map((check) => `${check.id}: ${check.detail}`),
    };
  };
  const executorResults: DoctorResultV1["executors"] = {
    native: executorResult("native"),
    "qemu-armv7-thumb2": executorResult("qemu-armv7-thumb2"),
    "qemu-aarch64": executorResult("qemu-aarch64"),
  };
  return {
    schemaVersion: 1,
    kind: "pocketjs.perf.doctor",
    status: Object.values(executorResults).every((entry) => entry.ready) ? "ok" : "missing",
    checks,
    executors: executorResults,
  };
}

export function doctorToText(result: DoctorResultV1): string {
  const lines = ["PocketJS performance doctor", ""];
  for (const check of result.checks) {
    lines.push(`${check.status === "ok" ? "ok" : check.status}: ${check.id} — ${check.detail}`);
  }
  lines.push("");
  for (const executor of EXECUTOR_IDS) {
    lines.push(`${executor}: ${result.executors[executor].ready ? "ready" : "not ready"}`);
  }
  return `${lines.join("\n")}\n`;
}
