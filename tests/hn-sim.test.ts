// tests/hn-sim.test.ts — the Hacker News mini-app (apps/hn) headless on the
// wasm core with the 3DS geometry and a fixture-routed NET module
// (hosts/sim/net.ts, tests/hn-fixture.ts): the story list, paging, feeds,
// a comment thread with collapse, the reading pane, and the error states.
//
// POCKET_HOME_SHOTS=<dir> also writes top/bottom PNGs of the list and thread.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BTN } from "../contracts/spec/spec.ts";
import { bootConsole3ds, type Console3ds, type Console3dsOptions } from "../hosts/sim/console-3ds.ts";
import { encodePNG } from "../tools/png.ts";
import { HN_API, hnRoutes } from "./hn-fixture.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const OUT = mkdtempSync(join(tmpdir(), "pocket-hn-"));
const GUEST = join(OUT, "guest", "hn-main");
const SHOTS = process.env.POCKET_HOME_SHOTS;
const GLOBALS = ["ui", "__pak", "__simHz", "frame", "link", "wifi", "camera", "net", "__pocketApp"] as const;
const saved = new Map(GLOBALS.map((key) => [key, (globalThis as Record<string, unknown>)[key]]));

beforeAll(() => {
  const build = Bun.spawnSync(
    [process.execPath, "tools/3ds.ts", "hn", "--pocket-only", `--outdir=${join(OUT, "guest")}`, `--package-outdir=${OUT}`],
    { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
  );
  if (build.exitCode !== 0) throw new Error(`hn build failed\n${build.stdout}${build.stderr}`);
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
}, 120_000);

afterAll(() => {
  for (const [key, value] of saved) (globalThis as Record<string, unknown>)[key] = value;
  rmSync(OUT, { recursive: true, force: true });
});

function boot(options: Partial<Console3dsOptions> = {}): Promise<Console3ds> {
  return bootConsole3ds({ js: `${GUEST}.js`, pak: `${GUEST}.pak`, current: "hn-main", link: null, wifi: null, camera: false, net: hnRoutes(), ...options });
}

function shot(console3ds: Console3ds, name: string): void {
  if (!SHOTS) return;
  for (const surface of ["primary", "auxiliary"] as const) {
    const { width, height, rgba } = console3ds.world.pixels(surface);
    writeFileSync(join(SHOTS, `hn-${name}-${surface === "primary" ? "top" : "bottom"}.png`), encodePNG(rgba, width, height));
  }
}

/** Requests the NET fake started, in order. */
const started = (hn: Console3ds) => hn.net!.log.filter((line) => line.startsWith("start ")).map((line) => line.split(" ")[3]!);

/** The most requests the NET fake ever held at once. */
function peakInflight(hn: Console3ds): number {
  let open = 0;
  let peak = 0;
  for (const line of hn.net!.log) {
    if (line.startsWith("start ")) peak = Math.max(peak, ++open);
    else if (line.startsWith("poll ")) open -= (JSON.parse(line.slice(5)) as unknown[]).length;
  }
  return peak;
}

describe("stories", () => {
  test("the front page loads its ids, then 20 stories, never more than two requests at once", async () => {
    const hn = await boot();
    await hn.run(80);
    const urls = started(hn);
    expect(urls[0]).toBe(`${HN_API}/topstories.json`);
    expect(urls.filter((url) => url.includes("/item/"))).toHaveLength(20);
    expect(peakInflight(hn)).toBeLessThanOrEqual(2);
    expect(hn.net!.log.some((line) => line.includes("busy"))).toBe(false);
    const bottom = hn.texts("auxiliary");
    for (const label of ["Top", "New", "Best", "Ask", "Show", "1", "Show HN: A dual-screen Hacker", "7"]) expect(bottom).toContain(label);
    shot(hn, "list");
  });

  test("the d-pad selects a story and the top screen reads it", async () => {
    const hn = await boot();
    await hn.run(80);
    await hn.press(BTN.DOWN);
    await hn.press(BTN.DOWN);
    const top = hn.texts("primary");
    expect(top).toContain("The quiet engineering behind resistive");
    expect(top).toContain("example1.com");
    expect(top.some((line) => line.startsWith("393 points  |  by pocketdev"))).toBe(true);
  });

  test("scrolling to the end pages in the next 20", async () => {
    const hn = await boot();
    await hn.run(80);
    for (let swipe = 0; swipe < 6; swipe++) await hn.drag(160, 220, 160, 60, 8);
    await hn.run(60);
    expect(started(hn).filter((url) => url.includes("/item/")).length).toBeGreaterThanOrEqual(40);
    expect(peakInflight(hn)).toBeLessThanOrEqual(2);
  });

  test("the segmented control switches feeds", async () => {
    const hn = await boot();
    await hn.run(60);
    await hn.tapText("New");
    await hn.run(40);
    expect(started(hn)).toContain(`${HN_API}/newstories.json`);
    expect(hn.texts("primary")).toContain("New");
  });

  test("Ask HN stories show their text in the reading pane", async () => {
    const hn = await boot();
    await hn.run(60);
    await hn.tapText("Ask");
    await hn.run(40);
    await hn.press(BTN.DOWN);
    expect(hn.texts("primary").join(" ")).toContain("Mine is a 3DS running PocketJS. I'd love to hear about yours & why.");
  });
});

describe("comments", () => {
  test("a story opens its thread depth-first; tapping a comment reads it, tapping again collapses it", async () => {
    const hn = await boot();
    await hn.run(80);
    await hn.tapText("Show HN: A dual-screen Hacker");
    await hn.run(60);
    const bottom = hn.texts("auxiliary");
    expect(bottom).toContain("7 Comments");
    expect(bottom).toContain("ruthk");
    expect(bottom).toContain("This is great. The top screen as a reading pane is");
    // Depth-first: the reply to the first comment comes before the second top-level comment.
    expect(bottom.indexOf("Not yet. Items live in memory while the app runs;")).toBeLessThan(bottom.indexOf("kestrel") === -1 ? Infinity : bottom.indexOf("kestrel"));
    // The deleted leaf (5004) is not shown; no comment is fetched twice.
    const items = started(hn).filter((url) => /item\/50\d\d/.test(url));
    expect(new Set(items).size).toBe(items.length);
    expect(items).toHaveLength(7);
    expect(peakInflight(hn)).toBeLessThanOrEqual(2);

    await hn.tapText("This is great. The top screen as a reading pane is");
    const top = hn.texts("primary");
    expect(top).toContain("Does it cache stories between launches?");
    expect(top.some((line) => line.startsWith("ruthk"))).toBe(true);
    shot(hn, "comments");

    await hn.tapText("This is great. The top screen as a reading pane is");
    await hn.run(4);
    expect(hn.texts("auxiliary")).toContain("2 replies hidden");
    expect(hn.texts("auxiliary")).not.toContain("Not yet. Items live in memory while the app runs;");

    await hn.press(BTN.CROSS);
    await hn.run(24);
    expect(hn.texts("auxiliary")).toContain("Top");
  });

  test("code blocks and links in comments read as text", async () => {
    const hn = await boot();
    await hn.run(80);
    await hn.tapText("Show HN: A dual-screen Hacker");
    await hn.run(60);
    // The fifth comment in reading order holds the link and the code block.
    for (let step = 0; step < 5; step++) await hn.press(BTN.DOWN);
    const all = [...hn.texts("auxiliary"), ...hn.texts("primary")].join("\n");
    expect(all).toContain("fetch(url) -> link -> Mac -> https");
    expect(all).toContain("https://example.com/tls");
  });
});

describe("errors", () => {
  test("a feed that fails with `unavailable` says the Mac is not linked, and A retries", async () => {
    const hn = await boot({ net: hnRoutes({ failFeeds: "unavailable" }) });
    await hn.run(20);
    expect(hn.texts("auxiliary")).toContain("Not linked to a Mac");
    shot(hn, "unlinked");
    const before = started(hn).length;
    await hn.press(BTN.CIRCLE);
    await hn.run(10);
    expect(started(hn).length).toBe(before + 1);
  });

  test("a console without the NET module reports it the same way", async () => {
    const hn = await boot({ net: undefined });
    await hn.run(10);
    expect(hn.texts("auxiliary")).toContain("Not linked to a Mac");
  });
});
