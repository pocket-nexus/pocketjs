// vapor/tests/gb-build.test.ts — GB toolchain scheduling and failure propagation.
//
// buildGbRom compiles three independent translation units with sdcc. They run
// concurrently, which is only safe if a failure in any one of them still fails
// the build and no stale .rel from a previous build can be linked in its place.
// Each test spawns harness/gb_build_runner.ts with a shim named `sdcc` first on
// PATH (harness/sdcc_shim.sh) — a fresh process, because Bun's `$` resolves
// PATH as it was at startup. The shim logs when each compile starts and ends
// and fails chosen units on demand.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

const HERE = import.meta.dir;
const ENTRY = join(HERE, "..", "examples", "todo", "todo.tsx");
const SHIM = join(HERE, "harness", "sdcc_shim.sh");
const RUNNER = join(HERE, "harness", "gb_build_runner.ts");
const OUT = join(HERE, "..", "..", "dist", "vapor", "gb-build-test");

const UNITS = ["vapor_core.c", "vapor_gb.c", "gen_app.c"] as const;
const RELS = ["vapor_core.rel", "vapor_gb.rel", "gen_app.rel"] as const;

const REAL_SDCC = (await Bun.$`which sdcc`.text()).trim();

interface ShimRun {
  unit: string;
  start: number;
  end: number;
}

interface BuildResult {
  ok: boolean;
  romBytes?: number;
  message?: string;
  runs: ShimRun[];
}

/** Build todo.tsx for GB in a child process with `sdcc` shimmed. */
async function build(dir: string, shimEnv: Record<string, string> = {}): Promise<BuildResult> {
  const bin = join(dir, "bin");
  await mkdir(bin, { recursive: true });
  await copyFile(SHIM, join(bin, "sdcc"));
  await chmod(join(bin, "sdcc"), 0o755);

  const logPath = join(dir, "sdcc.log");
  await rm(logPath, { force: true });

  const proc = Bun.spawn(["bun", RUNNER, ENTRY, join(dir, "todo.gb")], {
    env: {
      ...process.env,
      ...shimEnv,
      VP_SDCC_REAL: REAL_SDCC,
      VP_SDCC_LOG: logPath,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const line = stdout.trim().split("\n").at(-1) ?? "";
  if (code !== 0 || !line.startsWith("{")) {
    throw new Error(`gb_build_runner exited ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }

  const at = new Map<string, Partial<ShimRun>>();
  const log = existsSync(logPath) ? await readFile(logPath, "utf8") : "";
  for (const entry of log.split("\n").filter((l) => l.trim())) {
    const [kind, unit, ms] = entry.split(" ");
    const run = at.get(unit) ?? { unit };
    if (kind === "S") run.start = Number(ms);
    else run.end = Number(ms);
    at.set(unit, run);
  }
  const runs = [...at.values()].filter(
    (r): r is ShimRun => r.start !== undefined && r.end !== undefined,
  );
  return { ...(JSON.parse(line) as Omit<BuildResult, "runs">), runs };
}

afterAll(async () => {
  await rm(OUT, { recursive: true, force: true });
});

describe("GB build: three sdcc translation units", () => {
  test("the three units overlap in time instead of running one after another", async () => {
    // Stub mode writes junk to each -o, so the link fails; what this build is
    // for is the timing log the three compiles leave behind.
    const result = await build(join(OUT, "concurrent"), {
      VP_SDCC_STUB: "1",
      VP_SDCC_STUB_DELAY: "0.4",
    });

    const compiles = result.runs.filter((r) => (UNITS as readonly string[]).includes(r.unit));
    expect(compiles.map((r) => r.unit).sort()).toEqual([...UNITS].sort());
    // Serial execution puts every start at or after the previous end. Each unit
    // sleeps 400 ms, so real overlap is far wider than clock granularity.
    const lastStart = Math.max(...compiles.map((r) => r.start));
    const firstEnd = Math.min(...compiles.map((r) => r.end));
    expect(lastStart).toBeLessThan(firstEnd);
  }, 60_000);

  for (const [i, unit] of UNITS.entries()) {
    test(`a failure in ${unit} fails the build and names the unit`, async () => {
      const dir = join(OUT, `fail-${unit}`);
      const result = await build(dir, {
        VP_SDCC_FAIL: unit,
        // Exercise both common diagnostic streams: gen_app stands in for an
        // sdcc wrapper that reports its failure on stdout.
        ...(unit === "gen_app.c" ? { VP_SDCC_FAIL_STDOUT: unit } : {}),
      });

      expect(result.ok).toBe(false);
      expect(result.message).toContain(RELS[i]);
      expect(result.message).toContain("target gb");
      // sdcc's own diagnostic survives into the message, whether the tool or
      // wrapper writes it to stderr or stdout.
      expect(result.message).toContain(`injected failure for ${unit}`);
      // The failing unit produced nothing, and the build stopped before
      // makebin/rgbfix could write a ROM.
      expect(existsSync(join(dir, "gen-gb", RELS[i]))).toBe(false);
      expect(existsSync(join(dir, "todo.gb"))).toBe(false);
    }, 60_000);
  }

  test("a unit that fails on a rebuild removes stale and partial outputs", async () => {
    const dir = join(OUT, "stale");
    const rel = join(dir, "gen-gb", RELS[2]);
    const rom = join(dir, "todo.gb");

    const first = await build(dir);
    expect(first.ok).toBe(true);
    expect(first.romBytes).toBe(32768);
    expect((await readFile(rel)).length).toBeGreaterThan(0);

    const second = await build(dir, {
      VP_SDCC_FAIL: UNITS[2],
      // Some compiler versions or wrappers can truncate/write -o before
      // returning nonzero; that partial output must not replace the stale one.
      VP_SDCC_FAIL_OUTPUT: "1",
    });
    expect(second.ok).toBe(false);
    // Neither the old ROM nor a stale/partial .rel can masquerade as output
    // from the failed rebuild.
    expect(existsSync(rel)).toBe(false);
    expect(existsSync(rom)).toBe(false);
  }, 120_000);

  test("all three units failing at once reports one unit and mentions the others", async () => {
    const result = await build(join(OUT, "fail-all"), {
      VP_SDCC_FAIL: UNITS.join(","),
      // Complete in reverse link order. The diagnostic must still use link
      // order, rather than whichever subprocess happens to exit first.
      VP_SDCC_DELAY_VAPOR_CORE: "0.4",
      VP_SDCC_DELAY_VAPOR_GB: "0.2",
    });

    expect(result.ok).toBe(false);
    expect(
      result.runs
        .filter((r) => (UNITS as readonly string[]).includes(r.unit))
        .sort((a, b) => a.end - b.end)
        .map((r) => r.unit),
    ).toEqual([...UNITS].reverse());
    // Reported in link order, so one build breakage reads the same way every
    // run regardless of which process happened to exit first.
    expect(result.message).toContain(`sdcc failed compiling ${RELS[0]} for target gb`);
    expect(result.message).toContain(`${RELS[1]}, ${RELS[2]} also failed`);
    const detailOffsets = RELS.map((rel) => result.message!.indexOf(`${rel}:`));
    expect(detailOffsets.every((offset) => offset >= 0)).toBe(true);
    expect(detailOffsets).toEqual([...detailOffsets].sort((a, b) => a - b));
    for (const unit of UNITS) {
      expect(result.message).toContain(`injected failure for ${unit}`);
    }
  }, 60_000);
});
