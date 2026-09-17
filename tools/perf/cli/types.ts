import type { ComparisonStatus, ComparisonV1, ReceiptV1 } from "../core/index.ts";

export const EXECUTOR_IDS = [
  "native",
  "qemu-armv7-thumb2",
  "qemu-aarch64",
] as const;

export type ExecutorId = (typeof EXECUTOR_IDS)[number];

export interface PerfRunSummaryV1 {
  readonly schemaVersion: 1;
  readonly kind: "pocketjs.perf.run";
  readonly status: "valid" | "invalid";
  readonly executor: ExecutorId;
  readonly suite: string;
  readonly sourceRoot: string;
  readonly outputDir: string;
  readonly receipts: readonly string[];
  readonly invalidReasons: readonly string[];
}

export interface ComparisonSetEntryV1 {
  readonly key: string;
  readonly status: ComparisonStatus;
  readonly basePath: string | null;
  readonly candidatePath: string | null;
  readonly comparison: ComparisonV1 | null;
  readonly reason: string | null;
}

export interface ComparisonSetV1 {
  readonly schemaVersion: 1;
  readonly kind: "pocketjs.perf.comparison-set";
  readonly status: ComparisonStatus;
  readonly comparable: boolean;
  readonly entries: readonly ComparisonSetEntryV1[];
}

export interface DoctorCheckV1 {
  readonly id: string;
  readonly status: "ok" | "missing" | "mismatch";
  readonly detail: string;
  readonly executors: readonly ExecutorId[];
}

export interface DoctorResultV1 {
  readonly schemaVersion: 1;
  readonly kind: "pocketjs.perf.doctor";
  readonly status: "ok" | "missing";
  readonly checks: readonly DoctorCheckV1[];
  readonly executors: Readonly<Record<ExecutorId, {
    readonly ready: boolean;
    readonly reasons: readonly string[];
  }>>;
}

export interface LocalInvalidResultV1 {
  readonly schemaVersion: 1;
  readonly kind: "pocketjs.perf.local";
  readonly status: "invalid";
  readonly baseRef: string;
  readonly suite: string;
  readonly executors: readonly ExecutorId[];
  readonly invalidReasons: readonly string[];
  readonly temporaryWorktreesCleaned: true;
}

export interface QemuBridgeOptions {
  readonly executor: Exclude<ExecutorId, "native">;
  readonly suite: string;
  readonly sourceRoot: string;
  /** The current checkout owns the versioned protocol and guest harness. */
  readonly harnessRoot: string;
  readonly scenarioDir: string;
  readonly outDir: string;
  readonly maxEstimatedSeconds: number;
}

export interface QemuBridge {
  runQemuSuite(options: QemuBridgeOptions): Promise<
    | PerfRunSummaryV1
    | readonly ReceiptV1[]
    | { readonly receipts: readonly ReceiptV1[]; readonly invalidReasons?: readonly string[] }
  >;
}
