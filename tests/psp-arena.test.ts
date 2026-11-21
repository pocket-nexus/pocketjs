import { allocatorCases } from "./helpers/psp-allocator-harness.ts";

allocatorCases("permanent", [
  "exact_large_request",
  "failed_requests_preserve_tail",
  "alignment_and_recycling_do_not_overlap",
  "exact_fit_then_exhaustion",
  "free_list_is_not_permanent_tail",
  "kernel_reservation_failure",
]);

allocatorCases("compaction", [
  "script_heap_and_big_blocks_grow_from_opposite_ends",
  "failure_joins_a_gap_a_routine_pass_would_skip",
  "routine_pass_waits_for_enough_freed",
  "routine_pass_rejoins_neighbours_across_classes",
  "routine_pass_keeps_script_heap_out_of_big_classes",
  "script_heap_reuses_its_frees_before_growing",
  "failure_also_joins_script_heap_held_apart",
  "blocks_never_overlap_under_churn",
]);
