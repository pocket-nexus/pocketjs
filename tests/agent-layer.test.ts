// tests/agent-layer.test.ts — the system agent's overlay (framework/src/
// agent-layer.tsx) over a fixture app (tests/fixtures/agent-app), headless on
// the wasm core with the 3DS geometry and a fake `globalThis.agent`
// (hosts/sim/agent.ts) in place of the host and the companion.
//
// The overlay is added by the build because the fixture's pocket.json
// declares "system.agent"; nothing in the fixture imports it.
//
// POCKET_AGENT_SHOTS=<dir> writes bottom-screen PNGs of each state.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_LABELS, AGENT_MODE, AGENT_SCREEN, type AgentClientMessage } from "../contracts/spec/agent.ts";
import { BTN } from "../contracts/spec/spec.ts";
import { bootConsole3ds, type Console3ds } from "../hosts/sim/console-3ds.ts";
import { resolve3dsBuildPlan } from "../tools/3ds-profile.ts";
import { encodePNG } from "../tools/png.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const OUT = mkdtempSync(join(tmpdir(), "pocket-agent-"));
const OUTPUT = "agent-fixture-main";
const GUEST = join(OUT, "guest", OUTPUT);
const FIXTURE = { id: "dev.pocket-nexus.agent-fixture", title: "Agent Fixture", output: OUTPUT };
const SHOTS = process.env.POCKET_AGENT_SHOTS;
const GLOBALS = ["ui", "__pak", "__simHz", "frame", "link", "wifi", "camera", "net", "agent", "__pocketApp"] as const;
const saved = new Map(GLOBALS.map((key) => [key, (globalThis as Record<string, unknown>)[key]]));

beforeAll(() => {
  const manifest = JSON.parse(readFileSync(join(ROOT, "tests/fixtures/agent-app/pocket.json"), "utf8"));
  const plan = join(OUT, "plan.json");
  writeFileSync(plan, JSON.stringify(resolve3dsBuildPlan(manifest)));
  const build = Bun.spawnSync(
    [process.execPath, "tools/3ds.ts", `--plan=${plan}`, `--project-root=${ROOT}`, "--pocket-only", `--outdir=${join(OUT, "guest")}`, `--package-outdir=${OUT}`],
    { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
  );
  if (build.exitCode !== 0) throw new Error(`fixture build failed\n${build.stdout}${build.stderr}`);
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
}, 120_000);

afterAll(() => {
  for (const [key, value] of saved) (globalThis as Record<string, unknown>)[key] = value;
  rmSync(OUT, { recursive: true, force: true });
});

async function boot(available = true): Promise<Console3ds> {
  const app = await bootConsole3ds({
    js: `${GUEST}.js`,
    pak: `${GUEST}.pak`,
    current: OUTPUT,
    apps: [{ ...FIXTURE, version: "0.1.0", bytes: 1, hash: "0".repeat(16) } as never],
    link: null,
    wifi: null,
    camera: false,
    agent: { available },
  });
  await app.run(80);
  return app;
}

function shot(app: Console3ds, name: string): void {
  if (!SHOTS) return;
  const { width, height, rgba } = app.world.pixels("auxiliary");
  writeFileSync(join(SHOTS, `agent-${name}.png`), encodePNG(rgba, width, height));
}

const sentOf = <T extends AgentClientMessage["t"]>(app: Console3ds, t: T) =>
  app.agent!.sent.filter((message): message is Extract<AgentClientMessage, { t: T }> => message.t === t);

const lastStage = (app: Console3ds) => app.agent!.stages[app.agent!.stages.length - 1];

describe("summoning", () => {
  test("the guest says hello with its app, and the stage idles", async () => {
    const app = await boot();
    const [hello] = sentOf(app, "agent.hello");
    expect(hello?.app.output).toBe(OUTPUT);
    expect(hello?.apps.map((app) => app.output)).toContain(OUTPUT);
    expect(lastStage(app)).toEqual([AGENT_MODE.idle, AGENT_SCREEN.idle]);
  });

  test("L+R opens the choice over a paused app; X types, START sends the request", async () => {
    const app = await boot();
    app.agent!.chordDown();
    await app.run(2);
    app.agent!.chordUp(120);
    await app.run(12);
    expect(app.agent!.listening).toBe(0);
    const texts = app.texts("auxiliary");
    expect(texts).toContain(AGENT_LABELS.choose);
    expect(texts).toContain(AGENT_LABELS.talk);
    expect(texts).toContain(AGENT_LABELS.type);
    expect(lastStage(app)).toEqual([AGENT_MODE.attend, AGENT_SCREEN.mirror]);
    shot(app, "choose");
    // The paused app ignores its feed button under the overlay.
    const appTexts = () => app.texts("auxiliary").slice(0, app.texts("auxiliary").indexOf("Claude")).join("|");
    const before = appTexts();
    await app.press(BTN.RTRIGGER, 10);
    expect(appTexts()).toBe(before);
    expect(app.texts("auxiliary")).toContain("R presses: 0");
    await app.press(BTN.TRIANGLE, 20);
    expect(app.texts("auxiliary")).toContain(AGENT_LABELS.placeholder);
    shot(app, "compose");
    for (const key of ["h", "i"]) await app.tapText(key);
    await app.press(BTN.START, 5);
    const [turn] = sentOf(app, "agent.turn");
    expect(turn?.text).toBe("hi");
    expect(turn!.id & 0x4000_0000).not.toBe(0);
    expect(lastStage(app)?.[0]).toBe(AGENT_MODE.think);
  });

  test("Talk records until A sends; B closes the reply and the app runs again", async () => {
    const app = await boot();
    app.agent!.chordDown();
    await app.run(2);
    app.agent!.chordUp(1500);
    await app.run(6);
    await app.press(BTN.CIRCLE, 4);
    const stream = app.agent!.listening;
    expect(stream).not.toBe(0);
    expect(lastStage(app)).toEqual([AGENT_MODE.listen, AGENT_SCREEN.mirror]);
    app.agent!.push({ t: "agent.transcript", id: stream, text: "open the top story", final: false });
    await app.run(4);
    expect(app.texts("auxiliary").join(" ")).toContain("open the top story");
    shot(app, "listening");
    await app.press(BTN.CIRCLE, 4);
    expect(app.agent!.listenEnds.at(-1)).toEqual({ id: stream, send: true });
    app.agent!.push(
      { t: "agent.request", id: stream, text: "open the top story" },
      { t: "agent.delta", id: stream, text: "Done: " },
      { t: "agent.delta", id: stream, text: "it is open." },
      { t: "agent.done", id: stream, text: "Done: it is open.", usage: { input: 1200, cachedInput: 0, output: 30, total: 1230 } },
    );
    await app.run(6);
    const texts = app.texts("auxiliary").join(" ");
    expect(texts).toContain("Done: it is open.");
    expect(texts).toContain("1.2k tokens");
    expect(texts).toContain(AGENT_LABELS.talk);
    expect(lastStage(app)?.[0]).toBe(AGENT_MODE.happy);
    shot(app, "reply");
    await app.press(BTN.CROSS, 10);
    expect(app.texts("auxiliary")).not.toContain("Done: it is open.");
    expect(lastStage(app)).toEqual([AGENT_MODE.idle, AGENT_SCREEN.idle]);
    // The app answers buttons again.
    await app.press(BTN.RTRIGGER, 30);
    expect(app.texts("auxiliary")).toContain("R presses: 1");
  });

  test("tapping Talk listens; B steps back to the choice; L+R closes it", async () => {
    const app = await boot();
    app.agent!.chordDown();
    app.agent!.chordUp(100);
    await app.run(6);
    const talk = app.locate(AGENT_LABELS.talk)!;
    expect(talk).not.toBeNull();
    await app.tap(talk[0] + 4, talk[1] + 4);
    await app.run(4);
    const stream = app.agent!.listening;
    expect(stream).not.toBe(0);
    await app.press(BTN.CROSS, 6);
    expect(app.agent!.listenEnds.at(-1)).toEqual({ id: stream, send: false });
    expect(app.texts("auxiliary")).toContain(AGENT_LABELS.choose);
    app.agent!.chordDown();
    await app.run(6);
    expect(app.texts("auxiliary")).not.toContain(AGENT_LABELS.choose);
    expect(lastStage(app)).toEqual([AGENT_MODE.idle, AGENT_SCREEN.idle]);
  });

  test("without the companion the overlay says so in ASCII", async () => {
    const app = await boot(false);
    app.agent!.chordDown();
    app.agent!.chordUp(100);
    await app.run(6);
    expect(app.texts("auxiliary")).toContain("Claude is offline");
    await app.press(BTN.CROSS, 6);
    expect(app.texts("auxiliary")).not.toContain("Claude is offline");
  });
});

describe("the agent's own screen", () => {
  test("B tucks the overlay into a banner and the app runs; L+R brings back the reply", async () => {
    const app = await boot();
    app.agent!.push({ t: "agent.state", phase: "acting", turn: 21, screen: "own", app: OUTPUT, request: "check the inbox" });
    await app.run(6);
    const texts = app.texts("auxiliary");
    expect(texts).toContain("check the inbox");
    expect(texts).toContain(AGENT_LABELS.ownHints);
    expect(lastStage(app)).toEqual([AGENT_MODE.act, AGENT_SCREEN.own]);
    await app.press(BTN.CROSS, 6);
    expect(app.texts("auxiliary")).toContain(AGENT_LABELS.expand);
    expect(sentOf(app, "agent.cancel")).toHaveLength(0);
    // The app answers its own buttons again.
    await app.press(BTN.RTRIGGER, 30);
    expect(app.texts("auxiliary")).toContain("R presses: 1");
    app.agent!.push({ t: "agent.done", id: 21, text: "The inbox holds six messages.", usage: { input: 10, cachedInput: 0, output: 5, total: 15 } });
    await app.run(4);
    expect(app.texts("auxiliary")).toContain(AGENT_LABELS.replied);
    expect(app.texts("auxiliary")).not.toContain("The inbox holds six messages.");
    shot(app, "tucked-reply");
    app.agent!.chordDown();
    await app.run(4);
    expect(app.agent!.listening).toBe(0);
    expect(app.texts("auxiliary")).toContain("The inbox holds six messages.");
  });
});

describe("tools on the user's screen", () => {
  test("observe reads the app's texts, not the overlay's, and takes a shot when asked", async () => {
    const app = await boot();
    app.agent!.push({ t: "agent.tool", id: 7, call: "c1", name: "observe", args: { image: true } });
    await app.run(8);
    const [result] = sentOf(app, "agent.result");
    expect(result?.ok).toBe(true);
    expect(result?.shot).toBeGreaterThan(0);
    expect(app.agent!.shots).toBe(1);
    const report = JSON.parse(result!.text) as { app: { output: string }; texts: { text: string; x: number; y: number }[] };
    expect(report.app.output).toBe(OUTPUT);
    const words = report.texts.map((text) => text.text);
    expect(words).toContain("Inbox");
    expect(words).toContain("Message 1");
    expect(words).not.toContain(AGENT_LABELS.stop);
  });

  test("tap plays a stylus tap into the app while a banner shows, then reports the new screen", async () => {
    const app = await boot();
    const top = app.locate("Message 2")!;
    expect(top).not.toBeNull();
    app.agent!.push(
      { t: "agent.state", phase: "acting", turn: 9, screen: "user", app: OUTPUT },
      { t: "agent.step", id: 9, text: "Tapping the second message" },
      { t: "agent.tool", id: 9, call: "c2", name: "tap", args: { x: top[0] + 20, y: top[1] + top[3] / 2 } },
    );
    await app.run(6);
    expect(app.texts("auxiliary")).toContain("Tapping the second message");
    expect(lastStage(app)).toEqual([AGENT_MODE.act, AGENT_SCREEN.mirror]);
    shot(app, "acting");
    await app.run(40);
    const result = sentOf(app, "agent.result").find((message) => message.call === "c2");
    expect(result?.ok).toBe(true);
    const words = (JSON.parse(result!.text) as { texts: { text: string }[] }).texts.map((text) => text.text).join(" ");
    expect(words).toContain("Opened Message 2");
    expect(words).not.toContain("Tapping the second message");
  });

  test("B stops a turn while the agent acts", async () => {
    const app = await boot();
    app.agent!.push({ t: "agent.tool", id: 11, call: "c3", name: "wait", args: { ms: 3000 } });
    await app.run(5);
    await app.press(BTN.CROSS, 4);
    expect(sentOf(app, "agent.cancel").at(-1)?.id).toBe(11);
    expect(app.texts("auxiliary")).toContain(AGENT_LABELS.stopped);
  });

  test("press and drag reach the app; an unknown button is refused", async () => {
    const app = await boot();
    app.agent!.push({ t: "agent.tool", id: 12, call: "p1", name: "press", args: { button: "R" } });
    await app.run(40);
    expect(app.texts("auxiliary")).toContain("R presses: 1");
    app.agent!.push({ t: "agent.tool", id: 12, call: "p2", name: "press", args: { button: "Z" } });
    await app.run(4);
    expect(sentOf(app, "agent.result").find((message) => message.call === "p2")?.ok).toBe(false);
    app.agent!.push({ t: "agent.tool", id: 12, call: "d1", name: "drag", args: { x0: 160, y0: 220, x1: 160, y1: 60 } });
    await app.run(60);
    expect(sentOf(app, "agent.result").find((message) => message.call === "d1")?.ok).toBe(true);
  });

  test("launch asks the launcher to switch apps and leaves the answer to the next guest", async () => {
    const app = await boot();
    app.agent!.push({ t: "agent.tool", id: 13, call: "l1", name: "launch", args: { app: "Agent Fixture" } });
    await app.run(30);
    expect(sentOf(app, "agent.result").find((message) => message.call === "l1")?.ok).toBe(true);
    app.agent!.push({ t: "agent.tool", id: 13, call: "l2", name: "launch", args: { app: "Pocket Home" } });
    await app.run(4);
    expect(sentOf(app, "agent.result").find((message) => message.call === "l2")?.ok).toBe(false);
    app.agent!.push({ t: "agent.tool", id: 13, call: "l3", name: "launch", args: { app: "home" } });
    await app.run(4);
    expect(app.launches).toEqual(["home-main"]);
    expect(sentOf(app, "agent.result").find((message) => message.call === "l3")).toBeUndefined();
  });
});
