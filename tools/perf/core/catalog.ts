import type { JsonValue, MetricDefinition } from "./types.ts";

export const METRIC_CATALOG = {
  "guest.instructions": {
    id: "guest.instructions",
    label: "Guest instructions",
    direction: "lower-is-better",
    kind: "counter",
    unit: "count",
    diagnostic: false,
  },
  "guest.instruction_bytes": {
    id: "guest.instruction_bytes",
    label: "Dynamic instruction bytes",
    direction: "lower-is-better",
    kind: "counter",
    unit: "bytes",
    diagnostic: false,
  },
  "guest.thumb16_instructions": {
    id: "guest.thumb16_instructions",
    label: "16-bit Thumb instructions",
    direction: "lower-is-better",
    kind: "counter",
    unit: "count",
    diagnostic: true,
  },
  "guest.thumb32_instructions": {
    id: "guest.thumb32_instructions",
    label: "32-bit Thumb instructions",
    direction: "lower-is-better",
    kind: "counter",
    unit: "count",
    diagnostic: true,
  },
  "guest.load_store_events": {
    id: "guest.load_store_events",
    label: "Guest load/store events",
    direction: "lower-is-better",
    kind: "counter",
    unit: "count",
    diagnostic: false,
  },
  "guest.loads": {
    id: "guest.loads",
    label: "Guest loads",
    direction: "lower-is-better",
    kind: "counter",
    unit: "count",
    diagnostic: true,
  },
  "guest.stores": {
    id: "guest.stores",
    label: "Guest stores",
    direction: "lower-is-better",
    kind: "counter",
    unit: "count",
    diagnostic: true,
  },
  "memory.allocations": {
    id: "memory.allocations",
    label: "Allocations",
    direction: "lower-is-better",
    kind: "counter",
    unit: "count",
    diagnostic: false,
  },
  "memory.allocated_bytes": {
    id: "memory.allocated_bytes",
    label: "Allocated bytes",
    direction: "lower-is-better",
    kind: "counter",
    unit: "bytes",
    diagnostic: false,
  },
  "memory.current_bytes": {
    id: "memory.current_bytes",
    label: "Current allocated bytes",
    direction: "lower-is-better",
    kind: "gauge",
    unit: "bytes",
    diagnostic: true,
  },
  "memory.peak_bytes": {
    id: "memory.peak_bytes",
    label: "Peak bytes above phase baseline",
    direction: "lower-is-better",
    kind: "gauge",
    unit: "bytes",
    diagnostic: true,
  },
  "quickjs.live_bytes_after_gc": {
    id: "quickjs.live_bytes_after_gc",
    label: "QuickJS live bytes after GC",
    direction: "lower-is-better",
    kind: "gauge",
    unit: "bytes",
    diagnostic: false,
  },
  "artifact.bundle_bytes": {
    id: "artifact.bundle_bytes",
    label: "Bundle size",
    direction: "lower-is-better",
    kind: "gauge",
    unit: "bytes",
    diagnostic: false,
  },
  "artifact.pak_bytes": {
    id: "artifact.pak_bytes",
    label: "PAK size",
    direction: "lower-is-better",
    kind: "gauge",
    unit: "bytes",
    diagnostic: true,
  },
  "artifact.elf_text_rodata_bytes": {
    id: "artifact.elf_text_rodata_bytes",
    label: "ELF .text + .rodata",
    direction: "lower-is-better",
    kind: "gauge",
    unit: "bytes",
    diagnostic: false,
  },
  "native.wall_time_ns": {
    id: "native.wall_time_ns",
    label: "Native wall time",
    direction: "lower-is-better",
    kind: "gauge",
    unit: "ns",
    diagnostic: true,
  },
} as const satisfies Record<string, MetricDefinition>;

export type MetricId = keyof typeof METRIC_CATALOG;

export const METRIC_IDS = Object.freeze(
  Object.keys(METRIC_CATALOG) as MetricId[],
);

export function isMetricId(value: string): value is MetricId {
  return Object.hasOwn(METRIC_CATALOG, value);
}

export function metricDefinition(id: MetricId): MetricDefinition {
  return METRIC_CATALOG[id];
}

/** Scenario schemas validate this field before runners or factories consume it. */
export function gateMetricIds(
  params: Readonly<Record<string, JsonValue>>,
): readonly MetricId[] {
  const configured = params.gateMetrics;
  return Array.isArray(configured) ? configured as MetricId[] : [];
}
