// The desktop host runs a package at the largest cadence its rate is a
// whole multiple of: a package compiled at app.tickHz 30 presents at 30 Hz
// and one compiled at 60 presents at 60 Hz, and after(1.5) fires 1.5 wall
// seconds after the first frame in both. The host binary needs a window
// system, so the test runs when POCKETJS_DESKTOP_HOST names a
// pocket-desktop-host built by `pocket build --target macos-app` (or
// linux-app on Linux).
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const host = process.env.POCKETJS_DESKTOP_HOST;
const target = process.platform === "darwin" ? "macos-app" : "linux-app";

function compile(directory: string, tickHz: number): string {
  const manifest = join(directory, `pocket-${tickHz}.json`);
  writeFileSync(manifest, JSON.stringify({
    $schema: "https://pocketjs.dev/schema/pocket-2.json", pocket: 2, id: "dev.pocketjs.cadence-probe", name: "cadence-probe",
    title: "Cadence Probe", version: "0.1.0", engine: { capabilities: { requires: ["text.glyphs.baked"] } },
    app: { entry: "tests/fixtures/cadence-probe/main.tsx", output: "cadence-probe", framework: "solid", tickHz,
      viewport: { dynamic: { default: [320, 240] } } },
  }));
  const output = join(directory, `probe-${tickHz}.pocket`);
  const result = Bun.spawnSync([process.execPath, join(root, "tools/pocket.ts"), "compile", "--target", target, "--manifest", manifest,
    "--project-root", root, "--plan-dir", join(directory, `plans-${tickHz}`), "--outdir", join(directory, `out-${tickHz}`), "--output", output],
    { cwd: root, stdout: "pipe", stderr: "pipe" });
  expect(result.success, result.stderr.toString()).toBe(true);
  return output;
}

/** Run the host for two seconds of frames; return each PROBE line with its arrival time in ms. */
async function run(pkg: string, cadence: number): Promise<{ line: string; at: number }[]> {
  const child = Bun.spawn([host!, "--package", pkg, "--viewport", "320x240", "--density", "2", "--quit-after", String(cadence * 2)],
    { stdout: "ignore", stderr: "pipe" });
  const lines: { line: string; at: number }[] = [];
  const decoder = new TextDecoder();
  let pending = "";
  const reader = child.stderr.getReader();
  for (let read = await reader.read(); !read.done; read = await reader.read()) {
    const chunk = read.value, at = performance.now();
    pending += decoder.decode(chunk, { stream: true });
    const parts = pending.split("\n");
    pending = parts.pop()!;
    // The host logs guest console lines behind a logger prefix.
    for (const line of parts) if (line.includes("PROBE ")) lines.push({ line: line.slice(line.indexOf("PROBE ")), at });
  }
  expect(await child.exited).toBe(0);
  return lines;
}

describe.skipIf(!host)("desktop cadence", () => {
  for (const [tickHz, cadence] of [[30, 30], [60, 60]] as const) {
    test(`a package compiled at ${tickHz} Hz presents at ${cadence} Hz and after(1.5) fires at 1.5 s`, async () => {
      const directory = join(root, ".pocket-build/validation/desktop-cadence", `${process.pid}-${tickHz}`);
      mkdirSync(directory, { recursive: true });
      const lines = await run(compile(directory, tickHz), cadence);
      const armed = lines.find(entry => entry.line.startsWith("PROBE armed"));
      const fired = lines.find(entry => entry.line.startsWith("PROBE fired"));
      expect(armed?.line).toBe(`PROBE armed simHz=${cadence}`);
      expect(fired?.line).toBe(`PROBE fired frame=${cadence * 1.5} simHz=${cadence}`);
      const seconds = (fired!.at - armed!.at) / 1000;
      console.log(`desktop cadence: tickHz ${tickHz}, cadence ${cadence}, after(1.5) fired at ${seconds.toFixed(3)} s`);
      expect(Math.abs(seconds - 1.5)).toBeLessThan(0.1);
    }, 60_000);
  }
});
