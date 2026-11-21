import { allocatorCases } from "./helpers/psp-allocator-harness.ts";

allocatorCases("telemetry", [
  "program_budget_precedes_non_rust_heap_users",
  "live_bytes_follow_realloc_and_free",
  "failed_realloc_keeps_live_bytes_and_old_data",
  "zero_size_does_not_erase_failure_history",
  "diagnostics_count_tail_free_lists_and_splits",
  "requested_bytes_exclude_other_allocators_and_rounding",
]);
