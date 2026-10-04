import { $ } from "bun";
import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const NUMERIC_FIELDS = [
  "eval_us",
  "boot_to_frame0_us",
  "avg_frame_interval_us",
  "max_frame_interval_us",
  "avg_js_us",
  "avg_jobs_us",
  "avg_tick_us",
  "avg_draw_us",
  "avg_render_us",
  "avg_work_us",
  "max_work_us",
  "stack_free_bytes",
  "bundle_bytes",
  "pak_bytes",
  "arena_capacity_bytes",
  "arena_bump_bytes",
  "arena_tail_free_bytes",
  "arena_init_free_bytes",
  "arena_configured_bytes",
] as const;

test("PPSSPP bench report preserves drawlist checksums", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pocketjs-psp-bench-"));
  const rawPath = join(dir, "input.jsonl");
  const outDir = join(dir, "out");
  const row: Record<string, number | string> = {
    kind: "sample",
    app: "stats",
    framework: "solid",
    sample: 1,
    sim_hz: 60,
    frames: 100,
    window_start: 28,
    window_n: 100,
    drawlist_checksum: "0123456789abcdef",
    host_wall_ms: 1,
    arena_limit_bytes: 0,
  };
  for (const field of NUMERIC_FIELDS) row[field] = 1;

  try {
    await writeFile(rawPath, `${JSON.stringify(row)}\n`);
    await $`bun tools/bench-ppsspp.ts --apps=stats --from-raw=${rawPath} --out-dir=${outDir}`.quiet();
    const reportPath = (await Array.fromAsync(new Bun.Glob("*.json").scan({ cwd: outDir })))[0];
    const report = JSON.parse(await readFile(join(outDir, reportPath), "utf8"));
    expect(report.drawlist_checksums.stats.solid).toEqual(["0123456789abcdef"]);

    const markdownPath = reportPath.replace(/\.json$/, ".md");
    expect(await readFile(join(outDir, markdownPath), "utf8")).toContain(
      "Drawlist checksums: 0123456789abcdef",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
