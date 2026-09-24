export interface BenchLine {
  app: string;
  sim_hz: number;
  frames: number;
  window_start: number;
  window_n: number;
  eval_us: number;
  boot_to_eval_begin_us: number;
  boot_to_frame0_us: number;
  avg_frame_interval_us: number;
  max_frame_interval_us: number;
  avg_js_us: number;
  avg_jobs_us: number;
  avg_tick_us: number;
  avg_draw_us: number;
  avg_render_us: number;
  avg_work_us: number;
  max_work_us: number;
  stack_free_bytes: number;
  bundle_bytes: number;
  pak_bytes: number;
  arena_capacity_bytes: number;
  arena_bump_bytes: number;
  arena_tail_free_bytes: number;
  arena_init_free_bytes: number;
  arena_configured_bytes: number;
  drawlist_checksum?: string;
}

function isRequestedApp(row: BenchLine, app: string): boolean {
  const base = row.app.split(".")[0];
  return base === `${app}-main` || base === app;
}

export function parseBenchOutput(output: string, requestedApp: string, sample: number): BenchLine {
  const lines = output.trim().split("\n").filter(Boolean);
  let rows: BenchLine[];
  try {
    rows = lines.map((line) => JSON.parse(line) as BenchLine);
  } catch (error) {
    throw new Error(`${requestedApp} sample ${sample}: invalid PSP bench JSON: ${String(error)}`);
  }

  if (rows.length === 0) {
    throw new Error(`${requestedApp} sample ${sample}: PSP bench output was empty`);
  }
  // Older PSP hosts emit one row and did not identify the requested app reliably.
  const parsed = rows.length === 1 ? rows[0] : rows.find((row) => isRequestedApp(row, requestedApp));
  if (!parsed) {
    throw new Error(
      `${requestedApp} sample ${sample}: requested app not found in PSP bench output (${rows.map((row) => row.app).join(", ")})`,
    );
  }
  if (parsed.drawlist_checksum !== undefined && !/^[0-9a-f]{16}$/.test(parsed.drawlist_checksum)) {
    throw new Error(`${requestedApp} sample ${sample}: invalid drawlist checksum`);
  }
  return parsed;
}
