import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  parseReceiptV1,
  type ReceiptProvenanceV1,
  type ReceiptV1,
  type ScenarioV1,
} from "../core/index.ts";
import { createNativeReceipt } from "../receipts/index.ts";
import type { NativeRunResult } from "../runner/native.ts";
import { canonicalJson, commandText, runCommand, sha256 } from "./process.ts";

const BENCHMARK_ROOT = resolve(new URL("../../..", import.meta.url).pathname);

function firstLine(value: string): string {
  return value.split(/\r?\n/, 1)[0]?.trim() || "unavailable";
}

function commandVersion(argv: readonly string[], cwd: string): string {
  const result = runCommand(argv, { cwd });
  return result.exitCode === 0
    ? firstLine(new TextDecoder().decode(result.stdout) || new TextDecoder().decode(result.stderr))
    : "unavailable";
}

function sourceProvenance(sourceRoot: string): ReceiptProvenanceV1["source"] {
  const revision = commandText(["git", "rev-parse", "HEAD"], sourceRoot);
  const diff = runCommand(["git", "diff", "--binary", "--no-ext-diff", "HEAD", "--"], { cwd: sourceRoot });
  if (diff.exitCode !== 0) throw new Error(`cannot inspect tracked source changes in ${sourceRoot}`);
  const dirty = diff.stdout.byteLength > 0;
  const content = createHash("sha256").update(revision).update("\0").update(diff.stdout).digest("hex");
  return { revision, dirty, contentHash: content };
}

function artifactHash(
  sourceRoot: string,
  scenario: ScenarioV1,
  extraArtifacts: readonly string[] = [],
): string {
  const hash = createHash("sha256");
  let count = 0;
  const artifacts: readonly (readonly [string, string])[] = [
    ...scenario.subject.family === "guest-app" ? [
      ["wasm", join(sourceRoot, "hosts/web/pocketjs.wasm")] as const,
      ["js", join(sourceRoot, "dist", `${scenario.subject.entry}.js`)] as const,
      ["pak", join(sourceRoot, "dist", `${scenario.subject.entry}.pak`)] as const,
    ] : [],
    ...scenario.subject.family === "vapor" ? [
      ["vapor-source", join(sourceRoot, scenario.subject.entry)] as const,
    ] : [],
    ...extraArtifacts.map((path, index) => [`extra-${index}`, path] as const),
  ];
  for (const [label, path] of artifacts) {
    if (!existsSync(path)) continue;
    const bytes = readFileSync(path);
    hash.update(label).update("\0").update(String(bytes.byteLength)).update("\0").update(bytes);
    count += 1;
  }
  if (count === 0) hash.update("pocketjs.perf.no-native-artifact.v1");
  return hash.digest("hex");
}

function nativeExecutorFingerprint(): string {
  const hash = createHash("sha256").update("pocketjs.native-perf-host.v1\0");
  for (const relative of [
    "tools/perf/core/render-config.ts",
    "tools/perf/runner/native.ts",
    "tools/perf/runner/native-cli.ts",
    "tools/perf/runner/native-world.ts",
    "tools/perf/runner/input.ts",
    "tools/perf/apps/idle-fixture-main.tsx",
    "tools/perf/apps/list-fixture-main.tsx",
    "tools/perf/apps/keyed-list-model.ts",
    "tools/perf/executors/damage.ts",
    "tools/perf/executors/vapor.ts",
    "tools/perf/damage-fixture/src/main.rs",
    "tools/perf/damage-fixture/Cargo.lock",
    "tools/perf/receipts/factory.ts",
    "tools/perf/receipts/hash.ts",
    "tools/perf/receipts/native-protocol.ts",
    "hosts/web/wasm-ops.js",
    "framework/src/touch.ts",
    "bun.lock",
  ]) {
    const bytes = readFileSync(join(BENCHMARK_ROOT, relative));
    hash.update(relative).update("\0").update(String(bytes.byteLength)).update("\0").update(bytes);
  }
  return hash.digest("hex");
}

export function nativeProvenance(
  sourceRootInput: string,
  scenario: ScenarioV1,
  extraArtifacts: readonly string[] = [],
): ReceiptProvenanceV1 {
  const sourceRoot = resolve(sourceRootInput);
  return {
    source: sourceProvenance(sourceRoot),
    scenario: {
      id: scenario.id,
      suite: scenario.suite,
      framework: scenario.subject.framework,
      manifestHash: sha256(canonicalJson(scenario)),
      inputTapeHash: sha256(canonicalJson(scenario.tape)),
    },
    toolchain: {
      rustc: commandVersion(["rustc", "--version"], sourceRoot),
      cCompiler: commandVersion(["cc", "--version"], sourceRoot),
      sysroot: commandText(["rustc", "--print", "sysroot"], sourceRoot, { allowFailure: true }) || "unavailable",
    },
    build: {
      target: `${process.arch}-${process.platform}`,
      profile: "native-sim",
      rustFlags: [],
      cFlags: [],
      linkerFlags: [],
    },
    executor: {
      id: "native",
      version: `bun ${Bun.version}`,
      profile: "host-diagnostic",
      fingerprint: nativeExecutorFingerprint(),
    },
    binary: { sha256: artifactHash(sourceRoot, scenario, extraArtifacts) },
  };
}

export function nativeResultToReceipt(
  result: NativeRunResult,
  scenario: ScenarioV1,
  sourceRoot: string,
  extraArtifacts: readonly string[] = [],
): ReceiptV1 {
  const complete = nativeProvenance(sourceRoot, scenario, extraArtifacts);
  const { scenario: _scenario, ...environment } = complete;
  return createNativeReceipt(scenario, result, {
    provenance: environment,
  });
}

export function receiptFileName(receipt: ReceiptV1): string {
  const safe = `${receipt.provenance.scenario.id}.${receipt.provenance.scenario.framework}.${receipt.provenance.executor.id}`
    .replace(/[^a-zA-Z0-9._-]+/g, "-");
  return `${safe}.receipt.json`;
}

export function writeReceipt(outDir: string, receipt: ReceiptV1): string {
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, receiptFileName(receipt));
  writeFileSync(path, `${JSON.stringify(parseReceiptV1(receipt), null, 2)}\n`);
  return path;
}

export function readReceipt(path: string): ReceiptV1 {
  if (!statSync(path).isFile()) throw new Error(`receipt is not a file: ${path}`);
  return parseReceiptV1(JSON.parse(readFileSync(path, "utf8")));
}
