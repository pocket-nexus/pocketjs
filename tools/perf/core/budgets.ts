import type { BudgetSetV1, MetricBudgetV1 } from "./types.ts";

const QEMU_EXECUTORS = ["qemu-armv7-thumb2", "qemu-aarch64"] as const;

export const DEFAULT_BUDGET_SET: BudgetSetV1 = Object.freeze({
  schemaVersion: 1,
  kind: "pocketjs.perf.budget-set",
  id: "pocketjs-quick-v1",
  metrics: Object.freeze({
    "guest.instructions": {
      warn: { relative: 0.005, absolute: 5_000 },
      regression: { relative: 0.01, absolute: 10_000 },
      executors: QEMU_EXECUTORS,
    },
    "guest.instruction_bytes": {
      warn: { relative: 0.005, absolute: 10 * 1024 },
      regression: { relative: 0.01, absolute: 20 * 1024 },
      executors: QEMU_EXECUTORS,
    },
    "guest.load_store_events": {
      warn: { relative: 0.01, absolute: 10_000 },
      regression: { relative: 0.02, absolute: 20_000 },
      executors: QEMU_EXECUTORS,
    },
    "memory.allocated_bytes": {
      warn: { relative: 0.01, absolute: 4 * 1024 },
      regression: { relative: 0.02, absolute: 8 * 1024 },
      executors: QEMU_EXECUTORS,
    },
    "quickjs.live_bytes_after_gc": {
      warn: { relative: 0.01, absolute: 32 * 1024 },
      regression: { relative: 0.02, absolute: 64 * 1024 },
      executors: QEMU_EXECUTORS,
    },
    "artifact.bundle_bytes": {
      warn: { relative: 0.01, absolute: 2 * 1024 },
      regression: { relative: 0.03, absolute: 4 * 1024 },
    },
    "artifact.elf_text_rodata_bytes": {
      warn: { relative: 0.005, absolute: 2 * 1024 },
      regression: { relative: 0.01, absolute: 4 * 1024 },
      executors: QEMU_EXECUTORS,
    },
  }),
  scenarios: Object.freeze({
    "vapor.todo.reactive-grid.v1": Object.freeze({
      "memory.allocations": {
        hardMax: 0,
        executors: QEMU_EXECUTORS,
      },
    }),
  }),
});

/** Return a copied budget set with an explicit absolute bound for one metric. */
export function withHardLimits(
  budgetSet: BudgetSetV1,
  metricId: string,
  limits: Pick<MetricBudgetV1, "hardMax" | "hardMin">,
): BudgetSetV1 {
  const existing = budgetSet.metrics[metricId] ?? {};
  return {
    ...budgetSet,
    metrics: {
      ...budgetSet.metrics,
      [metricId]: { ...existing, ...limits },
    },
  };
}
