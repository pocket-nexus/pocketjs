// The console agent's companion side (tools/companion/agent.ts) against
// contracts/spec/agent.ts, over a live loopback link driven by the reference
// console client: hello and state, a typed turn whose tool call the console
// answers with a screenshot stream, a spoken turn through the transcriber,
// cancel, busy, reset, a tool the console never answers, and a `launch` that
// reboots the guest and resumes on its hello.
//
// The model is a fake `codex app-server` (written below, selected through the
// agent's codexBin) that speaks the JSON-RPC subset the companion uses and
// scripts its turn from the request text. The transcriber and the CoreText
// glyph helper are fakes selected through $POCKET_AGENT_TRANSCRIBER and
// $POCKET_AGENT_GLYPHS. The glyph tests read the atlases back with a reader of
// the FONT ATLAS v3 format written here from contracts/spec/spec.ts.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_COMPANION_STREAM, AGENT_FONT, AGENT_FONT_SLOT, AGENT_LABEL_GLYPHS, AGENT_LINK_FEATURE, AGENT_SHOT_BYTES, AGENT_TOOLS } from "../contracts/spec/agent.ts";
import { FONT_CMAP_ENTRY_SIZE, FONT_HEADER_SIZE, FONT_MAGIC } from "../contracts/spec/spec.ts";
import { AGENT_BASE_CODEPOINTS, codepointsOf, GlyphFeed, tofuCell, type GlyphRasterizer } from "../tools/companion/glyphs.ts";
import { shotDataUrl } from "../tools/companion/agent.ts";
import { prepareCodexHome } from "../tools/companion/codex.ts";
import { LinkConsoleClient, type ConsoleDevice } from "../tools/companion/console-client.ts";
import { rgb565ToRgba, rgbaToRgb565, screenTexts } from "../tools/companion/own-screen.ts";
import type { LinkCtrl } from "../tools/companion/protocol.ts";
import { Companion } from "../tools/companion/server.ts";
import { CompanionStore } from "../tools/companion/store.ts";

const tmpRoot = mkdtempSync(join(tmpdir(), "pocket-agent-"));
const DEVICE: ConsoleDevice = { id: "0a1b2c3d4e5f6071", name: "Test 3DS", model: "Nintendo 3DS", target: "3ds-dev" };
const APP = { id: "dev.pocket-nexus.home", title: "Pocket", output: "home-main" };
const HN = { id: "dev.pocket-nexus.hn", title: "Hacker News", output: "hn-main" };

// ---------------------------------------------------------------------------
// The fake codex app-server
// ---------------------------------------------------------------------------

const FAKE_CODEX = `#!${process.execPath}
// Scripted by the last input text of turn/start:
//   "observe ..."  one observe call, then a reply that says what came back
//   "launch ..."   launch hn-main, then observe, then a reply
//   "slow ..."     one delta, then waits for turn/interrupt
//   anything else  a two-delta reply
let buffer = "";
let next = 1000;
let threads = 0;
let tools = 0;
const waiting = new Map();
let active = null;
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
const notify = (method, params) => send({ method, params });
const call = (method, params) => new Promise((resolve) => { const id = next++; waiting.set(id, resolve); send({ id, method, params }); });
const usage = (threadId, turnId, input) => notify("thread/tokenUsage/updated", { threadId, turnId, tokenUsage: {
  total: { totalTokens: 1000 + input, inputTokens: input, cachedInputTokens: 10, cacheWriteInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 0 },
  last: { totalTokens: input + 5, inputTokens: input, cachedInputTokens: 10, cacheWriteInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 0 },
  modelContextWindow: null } });
const reply = (threadId, turnId, parts) => { const itemId = "msg-" + next++; notify("item/started", { threadId, turnId, item: { type: "agentMessage", id: itemId, text: "", phase: "final_answer" } }); for (const delta of parts) notify("item/agentMessage/delta", { threadId, turnId, itemId, delta }); };
const done = (threadId, turnId, status = "completed") => { active = null; notify("turn/completed", { threadId, turn: { id: turnId, items: [], status, error: null } }); };
const tool = async (threadId, turnId, name, args) => {
  const result = await call("item/tool/call", { threadId, turnId, callId: "call-" + next, namespace: null, tool: name, arguments: args });
  return result;
};
async function run(threadId, turnId, text) {
  usage(threadId, turnId, 100);
  if (text.startsWith("observe")) {
    const commentary = "msg-c" + next++;
    notify("item/started", { threadId, turnId, item: { type: "agentMessage", id: commentary, text: "", phase: "commentary" } });
    notify("item/agentMessage/delta", { threadId, turnId, itemId: commentary, delta: "I will look." });
    notify("item/completed", { threadId, turnId, item: { type: "agentMessage", id: commentary, text: "I will look.", phase: "commentary" } });
    const result = await tool(threadId, turnId, "observe", { image: true });
    const image = result.contentItems.some((c) => c.type === "inputImage" && c.imageUrl.startsWith("data:image/png;base64,"));
    const text0 = result.contentItems[0].text;
    reply(threadId, turnId, ["seen:", text0.slice(0, 60), " image:", image ? "yes" : "no", " ok:", String(result.success)]);
  } else if (text.startsWith("launch")) {
    const launched = await tool(threadId, turnId, "launch", { app: "hn-main" });
    const seen = await tool(threadId, turnId, "observe", {});
    const image = seen.contentItems.some((c) => c.type === "inputImage");
    reply(threadId, turnId, ["launched:", String(launched.success), " ", launched.contentItems[0].text.slice(0, 40), " then:", seen.contentItems[0].text.slice(0, 30), " image:", image ? "yes" : "no"]);
  } else if (text.startsWith("slow")) {
    reply(threadId, turnId, ["thinking..."]);
    active = { threadId, turnId };
    return;
  } else {
    reply(threadId, turnId, ["好的，", "thread " + threadId + " tools " + tools]);
  }
  usage(threadId, turnId, 50);
  done(threadId, turnId);
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.method === undefined) { waiting.get(m.id)?.(m.result ?? { success: false, contentItems: [{ type: "inputText", text: m.error?.message ?? "" }] }); waiting.delete(m.id); continue; }
    if (m.method === "initialize") send({ id: m.id, result: { userAgent: "fake" } });
    else if (m.method === "initialized") {}
    else if (m.method === "thread/start") { threads += 1; tools = (m.params.dynamicTools ?? []).length; send({ id: m.id, result: { thread: { id: "thread-" + threads } } }); }
    else if (m.method === "turn/start") {
      const turnId = "turn-" + next++;
      const texts = m.params.input.filter((i) => i.type === "text").map((i) => i.text);
      send({ id: m.id, result: { turn: { id: turnId, items: [], status: "inProgress" } } });
      notify("turn/started", { threadId: m.params.threadId, turn: { id: turnId } });
      setTimeout(() => run(m.params.threadId, turnId, texts[texts.length - 1]), 5);
    } else if (m.method === "turn/interrupt") {
      send({ id: m.id, result: {} });
      if (active) done(active.threadId, active.turnId, "interrupted");
    } else send({ id: m.id, error: { code: -32601, message: "unsupported " + m.method } });
  }
});
`;

// Partial after the first bytes, the byte count in the final text; "" for silence.
const FAKE_TRANSCRIBER = `
let bytes = 0;
let told = false;
process.stdin.on("data", (chunk) => {
  bytes += chunk.length;
  if (!told) { told = true; process.stdout.write(JSON.stringify({ text: "打开", final: false }) + "\\n"); }
});
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({ text: bytes ? "打开 Hacker News " + bytes : "", final: true }) + "\\n");
  process.exit(0);
});
`;

// Coverage filled with the codepoint's low byte; U+1F600 has no font.
const FAKE_GLYPHS = `
const [size, cellW, cellH] = process.argv.slice(2).map(Number);
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1);
    const glyphs = line.split(",").map(Number).filter((cp) => cp !== 0x1f600).map((cp) => ({
      cp, advance: cp < 128 ? 7 : size, xoff: 0, coverage: Buffer.alloc(cellW * cellH, cp & 255).toString("base64") }));
    process.stdout.write(JSON.stringify({ glyphs }) + "\\n");
  }
});
`;

interface Atlas {
  slot: number;
  density: number;
  cellW: number;
  cellH: number;
  cmap: { cp: number; gid: number; advance: number }[];
  cell(gid: number): Uint8Array;
}

/** A reader of FONT ATLAS v3 (contracts/spec/spec.ts), independent of the packer. */
function readAtlas(bytes: Uint8Array): Atlas {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(view.getUint32(0, true)).toBe(FONT_MAGIC);
  expect(view.getUint16(4, true)).toBe(3);
  const count = view.getUint16(6, true);
  const [cellW, cellH] = [bytes[8], bytes[9]];
  const cmap = Array.from({ length: count }, (_, i) => {
    const at = FONT_HEADER_SIZE + i * FONT_CMAP_ENTRY_SIZE;
    return { cp: view.getUint32(at, true), gid: view.getUint16(at + 4, true), advance: bytes[at + 6] };
  });
  const coverage = FONT_HEADER_SIZE + count * FONT_CMAP_ENTRY_SIZE;
  expect(bytes.length).toBe(coverage + count * cellW * cellH * bytes[14] * bytes[14]);
  return { slot: bytes[12], density: bytes[14], cellW, cellH, cmap, cell: (gid) => bytes.subarray(coverage + gid * cellW * cellH, coverage + (gid + 1) * cellW * cellH) };
}

let fakeCodex = "";
let companion: Companion;
let client: LinkConsoleClient;
const inbox: LinkCtrl[] = [];
/** Every agent message in arrival order (inbox is consumed by next()). */
const arrivals: LinkCtrl[] = [];
const streams = new Map<number, Uint8Array[]>();
const streamBytes = (stream: number) => Buffer.concat(streams.get(stream) ?? []);
/** The atlases sent so far, in order, each with the index of its arrival. */
const atlases = () =>
  arrivals.flatMap((m, index) => (m.t === "agent.glyphs" ? [{ index, message: m, atlas: readAtlas(new Uint8Array(streamBytes(Number(m.stream)))) }] : []));

/** The next message from the companion matching `pick`, waiting up to `ms`. */
async function next(pick: (m: LinkCtrl) => boolean, ms = 5_000): Promise<LinkCtrl> {
  const deadline = Date.now() + ms;
  for (;;) {
    const index = inbox.findIndex(pick);
    if (index >= 0) return inbox.splice(index, 1)[0];
    if (Date.now() > deadline) throw new Error(`no matching message in ${ms} ms; inbox: ${JSON.stringify(inbox.map((m) => m.t))}`);
    await Bun.sleep(5);
  }
}
const of = (t: string, id?: number) => (m: LinkCtrl) => m.t === t && (id === undefined || m.id === id);

async function linkConsole(target: Companion): Promise<LinkConsoleClient> {
  const { uri } = target.openPairing();
  return LinkConsoleClient.pair(uri, DEVICE, { ping: false });
}

beforeAll(async () => {
  fakeCodex = join(tmpRoot, "fake-codex.mjs");
  writeFileSync(fakeCodex, FAKE_CODEX);
  chmodSync(fakeCodex, 0o755);
  const transcriber = join(tmpRoot, "fake-transcriber.ts");
  writeFileSync(transcriber, FAKE_TRANSCRIBER);
  process.env.POCKET_AGENT_TRANSCRIBER = transcriber;
  const glyphs = join(tmpRoot, "fake-glyphs.ts");
  writeFileSync(glyphs, FAKE_GLYPHS);
  process.env.POCKET_AGENT_GLYPHS = glyphs;
  const storeDir = join(tmpRoot, "store");
  mkdirSync(storeDir, { recursive: true });
  companion = new Companion({
    store: new CompanionStore(storeDir),
    name: "Agent Test",
    port: 0,
    host: "127.0.0.1",
    beacon: false,
    pairHosts: ["127.0.0.1"],
    agent: { codexBin: fakeCodex, toolTimeoutMs: 1_500, launchTimeoutMs: 3_000, ownScreenCommand: null },
  });
  await companion.start();
  client = await linkConsole(companion);
  client.onMessage((m) => {
    if (!m.t.startsWith("agent.")) return;
    inbox.push(m);
    arrivals.push(m);
  });
  client.onData((stream, bytes) => {
    const chunks = streams.get(stream) ?? [];
    chunks.push(bytes);
    streams.set(stream, chunks);
  });
});

afterAll(async () => {
  client?.close();
  await companion?.stop();
  delete process.env.POCKET_AGENT_TRANSCRIBER;
  delete process.env.POCKET_AGENT_GLYPHS;
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("agent over the link", () => {
  test("the companion offers the agent feature when codex runs", () => {
    expect(client.features).toContain(AGENT_LINK_FEATURE);
  });

  test("hello is answered with the agent's state", async () => {
    client.sendCtrl({ t: "agent.hello", app: APP, apps: [APP, HN], locale: "zh-CN" });
    const state = await next(of("agent.state"));
    expect(state).toMatchObject({ phase: "idle", turn: 0, screen: "user", app: "home-main" });
  });

  test("hello brings the base atlas: slot 23, ASCII and CJK punctuation, tofu at gid 0", async () => {
    const message = await next(of("agent.glyphs"));
    expect(message.slot).toBe(AGENT_FONT_SLOT);
    expect(Number(message.stream) & AGENT_COMPANION_STREAM).not.toBe(0);
    const deadline = Date.now() + 2_000;
    while (streamBytes(Number(message.stream)).length < Number(message.bytes) && Date.now() < deadline) await Bun.sleep(5);
    const atlas = readAtlas(new Uint8Array(streamBytes(Number(message.stream))));
    expect(atlas).toMatchObject({ slot: AGENT_FONT_SLOT, density: 1, cellW: AGENT_FONT.cellW, cellH: AGENT_FONT.cellH });
    // One cmap entry per glyph, sorted: the base set and U+FFFD for the tofu box.
    expect(atlas.cmap.map((e) => e.cp)).toEqual([...AGENT_BASE_CODEPOINTS, 0xfffd].sort((a, b) => a - b));
    expect(atlas.cmap.find((e) => e.cp === 0xfffd)!.gid).toBe(0);
    expect(atlas.cmap.map((e) => e.gid).sort((a, b) => a - b)).toEqual(atlas.cmap.map((_, i) => i));
    const a = atlas.cmap.find((e) => e.cp === 0x41)!;
    expect(a.advance).toBe(7);
    expect(atlas.cell(a.gid).every((v) => v === 0x41)).toBe(true);
    expect(atlas.cell(0)).toEqual(tofuCell().coverage);
    // The overlay's own words are in every atlas.
    for (const cp of codepointsOf(AGENT_LABEL_GLYPHS)) expect(atlas.cmap.some((e) => e.cp === cp)).toBe(true);
  });

  test("a typed turn: request, a tool call answered with a shot, deltas, usage, done", async () => {
    client.sendCtrl({ t: "agent.turn", id: 0x40000007, text: "observe my screen" });
    expect(await next(of("agent.request", 0x40000007))).toMatchObject({ text: "observe my screen" });
    expect(await next(of("agent.state"))).toMatchObject({ phase: "thinking", turn: 0x40000007 });
    // Commentary becomes a step line, never reply text.
    expect(await next(of("agent.step", 0x40000007))).toMatchObject({ text: "I will look." });
    expect(await next(of("agent.state"))).toMatchObject({ phase: "acting", turn: 0x40000007, screen: "user" });
    expect(await next(of("agent.step", 0x40000007))).toMatchObject({ text: "Looking at the screen" });
    const call = await next(of("agent.tool", 0x40000007));
    expect(call).toMatchObject({ name: "observe", args: { image: true } });
    // The console answers: the shot stream, then the result naming it.
    const shot = client.takeId();
    const pixels = new Uint8Array(AGENT_SHOT_BYTES).fill(0x1f);
    client.sendCtrl({ t: "agent.shot", id: shot, width: 320, height: 240, format: "rgb565", bytes: AGENT_SHOT_BYTES });
    client.sendStream(shot, pixels);
    const report = { app: APP, keyboard: false, texts: [{ text: "Settings", x: 10, y: 20, w: 60, h: 16 }] };
    client.sendCtrl({ t: "agent.result", call: call.call, ok: true, text: JSON.stringify(report), shot });
    const done = await next(of("agent.done", 0x40000007));
    expect(done.text).toContain('seen:{"app":{"id":"dev.pocket-nexus.home"');
    expect(done.text).toContain("image:yes ok:true");
    expect(done.usage).toEqual({ input: 150, cachedInput: 20, output: 10, total: 1050 });
    expect(inbox.some((m) => m.t === "agent.delta" && m.id === 0x40000007)).toBe(true);
    expect(inbox.some((m) => m.t === "agent.usage" && m.id === 0x40000007)).toBe(true);
    expect(await next((m) => m.t === "agent.state" && m.phase === "idle")).toMatchObject({ turn: 0 });
    // English step lines need no glyphs beyond the atlas sent at hello.
    const step = arrivals.findIndex((m) => m.t === "agent.step" && m.text === "Looking at the screen");
    expect(atlases().filter((a) => a.index < step).length).toBe(1);
    inbox.length = 0;
  });

  test("a shot sent with an observe that did not ask for the image is not spent", async () => {
    client.sendCtrl({ t: "agent.turn", id: 9, text: "launch then look" });
    const launch = await next(of("agent.tool", 9));
    client.sendCtrl({ t: "agent.hello", app: APP, apps: [APP, HN], locale: "zh-CN" });
    const observe = await next(of("agent.tool", 9));
    expect(observe.args).toEqual({});
    const shot = client.takeId();
    client.sendCtrl({ t: "agent.shot", id: shot, width: 320, height: 240, format: "rgb565", bytes: AGENT_SHOT_BYTES });
    client.sendStream(shot, new Uint8Array(AGENT_SHOT_BYTES));
    client.sendCtrl({ t: "agent.result", call: observe.call, ok: true, text: "{}", shot });
    expect((await next(of("agent.done", 9))).text).toContain("image:no");
    expect(launch.name).toBe("launch");
    inbox.length = 0;
  });

  test("the thread holds every contract tool", async () => {
    client.sendCtrl({ t: "agent.turn", id: 8, text: "hi" });
    const done = await next(of("agent.done", 8));
    expect(done.text).toBe(`好的，thread thread-1 tools ${AGENT_TOOLS.length}`);
    // Two deltas within the hold window reach the console as one.
    const deltas = arrivals.filter((m) => m.t === "agent.delta" && m.id === 8);
    expect(deltas.map((m) => m.text)).toEqual([done.text]);
    inbox.length = 0;
  });

  test("a spoken turn: partial and final transcripts, then the turn", async () => {
    client.sendCtrl({ t: "agent.audio", id: 21, rate: 16360, format: "s16le" });
    client.sendStream(21, new Uint8Array(3000));
    expect(await next(of("agent.transcript", 21))).toMatchObject({ text: "打开", final: false });
    // The transcript needed glyphs the console lacked: an atlas holding them
    // arrived before it.
    const heard = arrivals.findIndex((m) => m.t === "agent.transcript" && m.text === "打开");
    const before = atlases().filter((a) => a.index < heard).pop()!;
    for (const cp of codepointsOf("打开")) expect(before.atlas.cmap.some((e) => e.cp === cp)).toBe(true);
    client.sendStream(21, new Uint8Array(1000));
    client.sendCtrl({ t: "agent.audio.end", id: 21, send: true });
    expect(await next((m) => m.t === "agent.transcript" && m.id === 21 && m.final === true)).toMatchObject({ text: "打开 Hacker News 4000" });
    expect(await next(of("agent.request", 21))).toMatchObject({ text: "打开 Hacker News 4000" });
    expect((await next(of("agent.done", 21))).text).toStartWith("好的，");
    inbox.length = 0;
  });

  test("silence ends without a turn", async () => {
    client.sendCtrl({ t: "agent.audio", id: 22, rate: 16360, format: "s16le" });
    client.sendCtrl({ t: "agent.audio.end", id: 22, send: true });
    expect(await next((m) => m.t === "agent.transcript" && m.id === 22)).toMatchObject({ text: "", final: true });
    expect(await next(of("agent.error", 22))).toMatchObject({ message: "I didn't catch that. Say it again?" });
    await Bun.sleep(50);
    expect(inbox.some((m) => m.t === "agent.request")).toBe(false);
    inbox.length = 0;
  });

  test("a second request while one runs is refused; cancel ends the first", async () => {
    client.sendCtrl({ t: "agent.turn", id: 30, text: "slow please" });
    await next(of("agent.delta", 30));
    client.sendCtrl({ t: "agent.turn", id: 31, text: "hi" });
    expect(await next(of("agent.error", 31))).toMatchObject({ message: "I'm still working on the last request." });
    client.sendCtrl({ t: "agent.cancel", id: 30 });
    expect(await next(of("agent.done", 30))).toMatchObject({ text: "thinking..." });
    inbox.length = 0;
  });

  test("a tool the console never answers fails after the timeout", async () => {
    client.sendCtrl({ t: "agent.turn", id: 40, text: "observe again" });
    await next(of("agent.tool", 40));
    const done = await next(of("agent.done", 40), 5_000);
    expect(done.text).toContain("did not answer");
    expect(done.text).toContain("ok:false");
    inbox.length = 0;
  });

  test("launch reboots the guest: its hello completes the call and resumes the acting state", async () => {
    client.sendCtrl({ t: "agent.turn", id: 50, text: "launch hn" });
    const launch = await next(of("agent.tool", 50));
    expect(launch).toMatchObject({ name: "launch", args: { app: "hn-main" } });
    expect(await next(of("agent.step", 50))).toMatchObject({ text: "Opening Hacker News" });
    // The console switches apps instead of answering; the new guest says hello.
    client.sendCtrl({ t: "agent.hello", app: HN, apps: [APP, HN], locale: "zh-CN" });
    expect(await next((m) => m.t === "agent.state" && m.app === "hn-main")).toMatchObject({ turn: 50, screen: "user" });
    const observe = await next(of("agent.tool", 50));
    expect(observe.name).toBe("observe");
    client.sendCtrl({ t: "agent.result", call: observe.call, ok: true, text: '{"app":{"output":"hn-main"},"texts":[]}' });
    const done = await next(of("agent.done", 50));
    expect(done.text).toContain("launched:true Launched Hacker News (hn-main)");
    // The new guest got the whole atlas again, earlier glyphs included.
    const hello = arrivals.findIndex((m) => m.t === "agent.state" && m.app === "hn-main");
    const resent = atlases().find((a) => a.index > hello - 2 && a.index < hello + 2)!;
    expect(resent.atlas.cmap.some((e) => e.cp === "好".codePointAt(0))).toBe(true);
    expect(done.text).toContain('then:{"app":{"output":"hn-main"}');
    inbox.length = 0;
  });

  test("reset starts a new conversation", async () => {
    client.sendCtrl({ t: "agent.reset" });
    await next(of("agent.state"));
    client.sendCtrl({ t: "agent.turn", id: 60, text: "hi" });
    expect((await next(of("agent.done", 60))).text).toContain("thread thread-2");
    inbox.length = 0;
  });

  test("a companion without codex offers no agent", async () => {
    const plain = new Companion({ store: new CompanionStore(join(tmpRoot, "plain")), port: 0, host: "127.0.0.1", beacon: false, pairHosts: ["127.0.0.1"], agent: { codexBin: null } });
    await plain.start();
    try {
      const other = await linkConsole(plain);
      expect(other.features).not.toContain(AGENT_LINK_FEATURE);
      other.close();
    } finally {
      await plain.stop();
    }
  });
});

describe("agent helpers", () => {
  test("the feed sends an atlas only for new glyphs, leaves undrawable ones to tofu, and starts over past its cap", async () => {
    const cell = { advance: 13, xoff: 1, coverage: new Uint8Array(AGENT_FONT.cellW * AGENT_FONT.cellH).fill(9) };
    const raster = { cells: async (cps: Iterable<number>) => new Map([...cps].map((cp) => [cp, cp === 0x1f600 ? null : cell] as const)) };
    const feed = new GlyphFeed(raster as unknown as GlyphRasterizer, AGENT_FONT, AGENT_BASE_CODEPOINTS.length + 5);
    const first = readAtlas((await feed.prepare(["甲乙丙😀"]))!);
    expect(first.cmap.length).toBe(AGENT_BASE_CODEPOINTS.length + 4); // three CJK and U+FFFD; 😀 falls to gid 0
    expect(await feed.prepare(["丙乙甲 ok"])).toBeNull();
    feed.newTurn();
    const over = readAtlas((await feed.prepare(["丁戊己庚辛壬"]))!);
    const cps = over.cmap.map((e) => e.cp);
    expect(cps).toContain("壬".codePointAt(0)!);
    expect(cps).not.toContain("甲".codePointAt(0)!);
    feed.dropped();
    expect(await feed.prepare(["ok"])).not.toBeNull();
    expect(codepointsOf("a\nb😀b")).toEqual([0x61, 0x62, 0x1f600]);
  });

  test("the dedicated codex home links the sign-in and turns tool features off", () => {
    const store = join(tmpRoot, "home-store");
    const user = join(tmpRoot, "user-codex");
    mkdirSync(user, { recursive: true });
    writeFileSync(join(user, "auth.json"), "{}");
    writeFileSync(join(user, "config.toml"), 'model = "test-model"\nmodel_reasoning_effort = "xhigh"\n[mcp_servers.x]\ncommand = "y"\n');
    const saved = process.env.CODEX_HOME;
    process.env.CODEX_HOME = user;
    try {
      const home = prepareCodexHome(store);
      expect(home.model).toBe("test-model");
      expect(home.signedIn).toBe(true);
      const config = Bun.file(join(home.home, "config.toml"));
      return config.text().then((text) => {
        expect(text).toContain('model = "test-model"');
        expect(text).toContain('model_reasoning_effort = "low"');
        expect(text).toContain("shell_tool = false");
        expect(text).not.toContain("mcp_servers");
      });
    } finally {
      if (saved === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = saved;
    }
  });

  test("RGB565 round-trips through RGBA and becomes a PNG data URL", () => {
    const rgba = new Uint8Array(4 * 4 * 4);
    for (let i = 0; i < 16; i++) rgba.set([i * 16, 255 - i * 16, (i * 37) & 255, 255], i * 4);
    const back = rgb565ToRgba(rgbaToRgb565(rgba, 4, 4), 4, 4);
    for (let i = 0; i < rgba.length; i++) expect(Math.abs(back[i] - rgba[i])).toBeLessThanOrEqual(7);
    expect(shotDataUrl(rgbaToRgb565(rgba, 4, 4), 4, 4)).toStartWith("data:image/png;base64,iVBORw0KGgo");
  });

  test("screen texts come in reading order, one entry per line, embossed twins once", () => {
    const node = (rect: [number, number, number, number] | null, text = "", children: unknown[] = []) => ({ rect, text, hidden: false, children });
    const root = node([0, 0, 320, 240], "", [
      node([0, 40, 320, 40], "two\nlines"),
      node([8, 11, 60, 15], "Top"),
      node([8, 12, 60, 15], "Top"),
      node([400, 10, 20, 10], "off screen"),
    ]);
    expect(screenTexts(root as never).map((t) => `${t.text}@${t.y}`)).toEqual(["Top@11", "two@40", "lines@60"]);
  });
});
