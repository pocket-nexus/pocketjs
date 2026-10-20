// The console agent (contracts/spec/agent.ts): the companion side of the
// mascot on a console's top screen. One AgentService per companion owns the
// codex app-server child (tools/companion/codex.ts); one AgentSession per
// paired console holds that console's conversation (a codex thread), its turn
// in progress, the tool calls waiting on the console, its microphone streams
// and its own screen.
//
// A session outlives its link connection: a console that reconnects, or a
// guest that reboots after `launch`, finds its conversation and turn where
// they were. The thread lives until agent.reset or until the codex child
// exits.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  AGENT_COMPANION_STREAM,
  AGENT_FONT,
  AGENT_FONT_SLOT,
  AGENT_MIC_MAX_MS,
  AGENT_SHOT_BYTES,
  AGENT_SHOT_HEIGHT,
  AGENT_SHOT_WIDTH,
  AGENT_TOOLS,
  type AgentApp,
  type AgentPhase,
  type AgentText,
  type AgentToolName,
  type AgentUsage,
} from "../../contracts/spec/agent.ts";
import { LINK_MAX_DATA } from "../../contracts/spec/link.ts";
import { POCKET_SECTION, decodePocketPackage, findSection, findVariant } from "../../contracts/spec/pocket-package.ts";
import { encodePNG } from "../png.ts";
import { CodexClient, findCodex, prepareCodexHome, type CodexNotification, type CodexServerRequest } from "./codex.ts";
import { GlyphFeed, GlyphRasterizer } from "./glyphs.ts";
import { OwnScreen, OWN_SCREEN_SCRIPT, rgb565ToRgba, type OwnScreenAnswer } from "./own-screen.ts";
import type { LinkCtrl } from "./protocol.ts";
import { transcriberCommand, Transcription } from "./transcribe.ts";

/** How long a tool call waits for the console's agent.result. */
export const AGENT_TOOL_TIMEOUT_MS = 20_000;
/** How long a `launch` on the user's screen waits for the new guest's hello. */
export const AGENT_LAUNCH_TIMEOUT_MS = 30_000;
/** The own screen streams a changed frame at most this often during a turn. */
export const AGENT_OWN_FRAME_MS = 500;
/** Reply text waits this long for more deltas, so one atlas covers them all. */
export const AGENT_DELTA_HOLD_MS = 250;

/** What the session needs from a link connection. */
export interface AgentLink {
  readonly device: { id: string; name: string; target: string };
  send(message: LinkCtrl): void;
  /** Bytes on a data stream, in LINK_MAX_DATA chunks; false once the link closed. */
  sendData(stream: number, bytes: Uint8Array): Promise<boolean>;
}

/** The apps the companion can boot on an own screen. */
export interface AgentCatalog {
  entries(target: string): { id: string; title: string; output: string; path: string; hash: string }[];
}

export interface AgentServiceOptions {
  storeDir: string;
  catalog?: AgentCatalog;
  /** The codex binary; findCodex() when undefined, off when null. */
  codexBin?: string | null;
  model?: string;
  effort?: string;
  /** Extra args after `codex app-server` (tests). */
  codexArgs?: string[];
  toolTimeoutMs?: number;
  launchTimeoutMs?: number;
  /** How to start the own-screen child; null turns own screens off. */
  ownScreenCommand?: string[] | null;
  /** false: send agent text without glyph atlases. */
  glyphs?: boolean;
  log?: (line: string) => void;
}

/** The persona and the rules of the job. Replaces codex's coding prompt. */
export const AGENT_INSTRUCTIONS = `You are Claude, a small orange mascot who lives in a cozy 3D room on the top screen of the user's Nintendo 3DS. The user summons you with L+R and talks to you by voice or with the keyboard. You help with Pocket apps (the small apps on the console) by operating them yourself through your tools: observe a screen, then tap, drag, press buttons, type, launch apps and wait.

Screens. "user" is the touch screen of the console in the user's hands: 320x240 logical pixels, origin at the top-left. The user watches you work on it. "own" is your own screen: a copy of a Pocket app on the computer, shown on the monitor on your desk. Use the user's screen unless the user asks you to do something in the background, or the task does not need their screen and doing it there would get in their way.

How to work:
- Observe before you act, and again whenever you need to see what changed. Every action answers with the screen's texts and their boxes. A screenshot (observe with image: true) costs about 12k tokens: ask for one only when the texts do not tell you enough.
- To press something, tap the middle of its text box. Lists scroll by dragging: drag up to see further down. B goes back.
- Do what the request needs and stop when it is done. If the same step fails twice, stop and say so.
- The user's request may come from speech recognition: read through misheard words (an app name spelled oddly is still that app).

Replies are in the user's language (Chinese when they write Chinese). They show on a 320x240 screen: one to four short sentences of plain text, no markdown headings, tables, lists or code, no URLs unless asked. Tell what you found or did; do not narrate every tap.`;

const ZERO_USAGE: AgentUsage = { input: 0, cachedInput: 0, output: 0, total: 0 };

/** Every dynamic tool the model sees: the contract's tools as functions. */
export function codexDynamicTools() {
  return AGENT_TOOLS.map((tool) => ({ type: "function", name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));
}

/** RGB565 little-endian pixels as a PNG data URL for the model. */
export function shotDataUrl(rgb565: Uint8Array, width = AGENT_SHOT_WIDTH, height = AGENT_SHOT_HEIGHT): string {
  return `data:image/png;base64,${encodePNG(rgb565ToRgba(rgb565, width, height), width, height).toString("base64")}`;
}

let macLanguages: string | undefined;

/** "zh-CN" when the Mac lists a Chinese language among its preferred ones. */
function macLocale(): string {
  if (macLanguages === undefined) {
    const read = Bun.spawnSync(["defaults", "read", "-g", "AppleLanguages"], { stdout: "pipe", stderr: "ignore" });
    macLanguages = read.exitCode === 0 ? read.stdout.toString() : "";
  }
  return /"?zh[-_]/i.test(macLanguages) ? "zh-CN" : "en";
}

/** The step lines and errors the console shows: the console's interface is
 *  English, whatever language the request and the reply are in. */
const WORDS = {
  busy: "I'm still working on the last request.",
  misheard: "I didn't catch that. Say it again?",
  noSpeech: "This Mac cannot recognize speech.",
  offline: "Codex on the Mac is not ready.",
  dropped: "The link dropped.",
  look: "Looking at the screen",
  tapAt: (x: number, y: number) => `Tapping (${x}, ${y})`,
  tapText: (text: string) => `Tapping "${text}"`,
  scrollDown: "Scrolling down",
  scrollUp: "Scrolling up",
  drag: "Dragging",
  press: (button: string) => `Pressing ${button}`,
  type: (text: string) => `Typing "${text}"`,
  open: (app: string) => `Opening ${app}`,
  wait: "Waiting",
  own: (line: string) => `On my screen: ${line}`,
};

function short(text: string, max = 16): string {
  const chars = [...text.trim()];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : chars.join("");
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : 0;
}

/** The text a message shows on the console, whose glyphs it needs. */
function messageTexts(message: LinkCtrl): string[] {
  switch (message.t) {
    case "agent.request":
    case "agent.transcript":
    case "agent.delta":
    case "agent.step":
    case "agent.done":
      return typeof message.text === "string" ? [message.text] : [];
    case "agent.error":
      return typeof message.message === "string" ? [message.message] : [];
    case "agent.state":
      return typeof message.request === "string" ? [message.request] : [];
    default:
      return [];
  }
}

/** Texts of a screen report carried in a result text, or []. */
function reportTexts(text: string): AgentText[] {
  try {
    const parsed = JSON.parse(text) as { texts?: AgentText[] };
    return Array.isArray(parsed.texts) ? parsed.texts : [];
  } catch {
    return [];
  }
}

interface ToolResult {
  ok: boolean;
  text: string;
  shot?: number;
}

interface PendingCall {
  name: AgentToolName;
  resolve: (result: ToolResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Shot {
  expected: number;
  received: number;
  chunks: Uint8Array[];
  bytes?: Uint8Array;
  waiters: ((bytes: Uint8Array | undefined) => void)[];
  timer: ReturnType<typeof setTimeout>;
}

interface Recording {
  rate: number;
  bytes: number;
  limit: number;
  transcription?: Transcription;
  /** PCM that arrived while the transcriber was being built. */
  early: Uint8Array[];
  ended: boolean;
  send: boolean;
  /** The whole recording, kept when the owner asked for it (KEEP_AUDIO). */
  kept?: Uint8Array[];
}

/** With this file in `<store>/agent/`, the last recording is saved next to
 *  it as last-recording.wav, for checking what the console's microphone
 *  hears. Nothing is kept otherwise. */
const KEEP_AUDIO = "keep-audio";

function wav(rate: number, pieces: Uint8Array[]): Uint8Array {
  const length = pieces.reduce((sum, piece) => sum + piece.length, 0);
  const out = new Uint8Array(44 + length);
  const view = new DataView(out.buffer);
  out.set(new TextEncoder().encode("RIFF"), 0);
  view.setUint32(4, 36 + length, true);
  out.set(new TextEncoder().encode("WAVEfmt "), 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  out.set(new TextEncoder().encode("data"), 36);
  view.setUint32(40, length, true);
  let at = 44;
  for (const piece of pieces) {
    out.set(piece, at);
    at += piece.length;
  }
  return out;
}

interface Turn {
  id: number;
  /** The user's words that began it. */
  request: string;
  codexTurnId?: string;
  text: string;
  usage: AgentUsage;
  screen: "user" | "own";
  cancelled: boolean;
  error?: string;
  /** Agent message items by id: commentary items become steps. */
  items: Map<string, { phase: string | null; text: string }>;
  ownTimer?: ReturnType<typeof setInterval>;
}

export class AgentService {
  readonly codex: CodexClient | null;
  readonly glyphs: GlyphRasterizer | null;
  readonly model: string | undefined;
  private sessions = new Map<string, AgentSession>();
  private threads = new Map<string, AgentSession>();

  constructor(readonly options: AgentServiceOptions) {
    const bin = options.codexBin === undefined ? findCodex() : options.codexBin;
    let codex: CodexClient | null = null;
    let model: string | undefined;
    if (bin) {
      const home = prepareCodexHome(options.storeDir, { model: options.model, effort: options.effort });
      model = home.model;
      if (home.signedIn || options.codexBin) {
        codex = new CodexClient({ bin, home: home.home, args: options.codexArgs, log: options.log, clientName: "pocket_companion" });
      } else options.log?.("agent: codex is not signed in (no ~/.codex/auth.json); the console agent is off");
    } else options.log?.("agent: no codex binary on PATH; the console agent is off");
    this.codex = codex;
    this.model = model;
    this.glyphs = options.glyphs === false ? null : new GlyphRasterizer(options.storeDir, AGENT_FONT, options.log);
    codex?.onNotification((message) => this.notification(message));
    codex?.handleRequests((request) => this.serverRequest(request));
    codex?.onExit((reason) => {
      this.threads.clear();
      for (const session of this.sessions.values()) session.codexExited(reason);
    });
  }

  get available(): boolean {
    return this.codex !== null;
  }

  log(line: string) {
    this.options.log?.(line);
  }

  /** The session of a console, bound to its newest link. */
  attach(link: AgentLink): AgentSession {
    let session = this.sessions.get(link.device.id);
    if (!session) {
      session = new AgentSession(this, link.device.id);
      this.sessions.set(link.device.id, session);
    }
    session.attach(link);
    return session;
  }

  session(deviceId: string): AgentSession | undefined {
    return this.sessions.get(deviceId);
  }

  bindThread(threadId: string, session: AgentSession) {
    this.threads.set(threadId, session);
  }

  unbindThread(threadId: string) {
    this.threads.delete(threadId);
  }

  private notification(message: CodexNotification) {
    const threadId = message.params.threadId;
    if (typeof threadId !== "string") return;
    this.threads.get(threadId)?.codexNotification(message);
  }

  private async serverRequest(request: CodexServerRequest): Promise<Record<string, unknown>> {
    const threadId = request.params.threadId;
    const session = typeof threadId === "string" ? this.threads.get(threadId) : undefined;
    if (request.method === "item/tool/call" && session) return session.toolCall(request.params);
    if (request.method === "item/commandExecution/requestApproval" || request.method === "item/fileChange/requestApproval") {
      return { decision: "decline" };
    }
    throw new Error(`${request.method} is not available to the console agent`);
  }

  ownScreenCommand(): string[] | null {
    if (this.options.ownScreenCommand !== undefined) return this.options.ownScreenCommand;
    return existsSync(OWN_SCREEN_SCRIPT) ? [process.execPath, OWN_SCREEN_SCRIPT] : null;
  }

  /** Write an app's 3ds-dev bundle out of its package for the own screen. */
  bundleFor(target: string, app: string): { js: string; pak?: string; output: string; title: string } | null {
    const entries = this.options.catalog?.entries(target) ?? [];
    const wanted = app.trim().toLowerCase();
    const entry =
      entries.find((e) => e.output.toLowerCase() === wanted || e.id.toLowerCase() === wanted) ??
      entries.find((e) => e.title.toLowerCase() === wanted) ??
      entries.find((e) => e.title.toLowerCase().includes(wanted) || wanted.includes(e.title.toLowerCase()));
    if (!entry) return null;
    const dir = join(this.options.storeDir, "own");
    mkdirSync(dir, { recursive: true });
    const js = join(dir, `${entry.output}-${entry.hash}.js`);
    const pak = join(dir, `${entry.output}-${entry.hash}.pak`);
    if (!existsSync(js)) {
      const pkg = decodePocketPackage(new Uint8Array(readFileSync(entry.path)));
      const variant = findVariant(pkg, target);
      const source = variant && findSection(variant, POCKET_SECTION.js);
      if (!variant || !source) return null;
      // The js section is NUL-terminated for zero-copy evaluation on devices.
      const end = source[source.length - 1] === 0 ? source.length - 1 : source.length;
      writeFileSync(js, source.subarray(0, end));
      const pack = findSection(variant, POCKET_SECTION.pak);
      if (pack) writeFileSync(pak, pack);
    }
    return { js, pak: existsSync(pak) ? pak : undefined, output: entry.output, title: entry.title };
  }

  stop() {
    for (const session of this.sessions.values()) session.close();
    this.codex?.stop();
    this.glyphs?.close();
  }
}

export class AgentSession {
  private link: AgentLink | undefined;
  private hello: { app: AgentApp; apps: AgentApp[]; locale: string } | undefined;
  private threadId: string | undefined;
  private threadEpoch = 0;
  private threading: Promise<string> | undefined;
  private turn: Turn | undefined;
  private phase: AgentPhase = "idle";
  private screen: "user" | "own" = "user";
  private total = 0;
  private callSeq = 0;
  private calls = new Map<string, PendingCall>();
  private shots = new Map<number, Shot>();
  private recordings = new Map<number, Recording>();
  private lastTexts: { user: AgentText[]; own: AgentText[] } = { user: [], own: [] };
  private own: OwnScreen | undefined;
  private ownTitle = "";
  private screenSeq = 0;
  private screenSending = false;
  private lastScreenHash = "";
  private tools: Promise<void> = Promise.resolve();
  private outbox: Promise<void> = Promise.resolve();
  private held: { id: number; text: string } | undefined;
  private heldTimer: ReturnType<typeof setTimeout> | undefined;
  private feed: GlyphFeed | null;

  constructor(
    private readonly service: AgentService,
    readonly deviceId: string,
  ) {
    this.feed = service.glyphs ? new GlyphFeed(service.glyphs) : null;
  }

  /** The language of the user's last request, which the transcriber
   *  listens for when the console names no locale. */
  private spoken: string | undefined;

  private get locale(): string | undefined {
    return this.hello?.locale || this.spoken || macLocale();
  }

  private get target(): string {
    return this.link?.device.target ?? "3ds-dev";
  }

  attach(link: AgentLink) {
    this.link = link;
  }

  /** The link closed. Calls on the user's screen fail, except a launch,
   *  which waits for the console to come back. */
  detach(link: AgentLink) {
    if (this.link !== link) return;
    this.link = undefined;
    for (const [call, pending] of this.calls) {
      if (pending.name === "launch") continue;
      this.calls.delete(call);
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, text: WORDS.dropped });
    }
    for (const recording of this.recordings.values()) recording.transcription?.kill();
    this.recordings.clear();
    for (const shot of this.shots.values()) clearTimeout(shot.timer);
    this.shots.clear();
  }

  /** Every message to the console goes out in order through the outbox. A
   *  message with text waits for the atlas that covers it; reply deltas are
   *  held AGENT_DELTA_HOLD_MS and merged, so one atlas covers many. */
  private send(message: LinkCtrl) {
    if (message.t === "agent.delta") {
      const id = num(message.id);
      if (this.held && this.held.id !== id) this.release();
      if (this.held) this.held.text += String(message.text);
      else this.held = { id, text: String(message.text) };
      this.heldTimer ??= setTimeout(() => this.release(), AGENT_DELTA_HOLD_MS);
      return;
    }
    this.release();
    this.enqueue(message);
  }

  private release() {
    clearTimeout(this.heldTimer);
    this.heldTimer = undefined;
    const held = this.held;
    this.held = undefined;
    if (held) this.enqueue({ t: "agent.delta", id: held.id, text: held.text });
  }

  private enqueue(message: LinkCtrl | { glyphs: "resend" }) {
    this.outbox = this.outbox.then(() => this.deliver(message)).catch((error) => this.service.log(`agent: send failed: ${(error as Error).message}`));
  }

  private async deliver(message: LinkCtrl | { glyphs: "resend" }) {
    const link = this.link;
    if (!link) return;
    if (this.feed) {
      const force = "glyphs" in message;
      const atlas = await this.feed.prepare(force ? [] : messageTexts(message as LinkCtrl), force);
      if (atlas && this.link === link) {
        const stream = this.companionStream();
        link.send({ t: "agent.glyphs", stream, slot: AGENT_FONT_SLOT, bytes: atlas.length });
        if (!(await link.sendData(stream, atlas))) return;
      }
    }
    if ("glyphs" in message || this.link !== link) return;
    link.send(message);
  }

  private companionStream(): number {
    this.screenSeq = (this.screenSeq + 1) & 0x7fffffff;
    return (AGENT_COMPANION_STREAM | this.screenSeq) >>> 0;
  }

  private setPhase(phase: AgentPhase, screen = this.screen) {
    if (phase === this.phase && screen === this.screen) return;
    this.phase = phase;
    this.screen = screen;
    this.sendState();
  }

  private sendState() {
    this.send({
      t: "agent.state",
      phase: this.phase,
      turn: this.turn?.id ?? 0,
      screen: this.screen,
      app: this.hello?.app.output ?? "",
      request: this.turn?.request ?? "",
    });
  }

  // -------------------------------------------------------------------------
  // Console messages
  // -------------------------------------------------------------------------

  /** One `agent.*` ctrl message from the console. */
  handle(message: LinkCtrl) {
    switch (message.t) {
      case "agent.hello":
        return this.onHello(message);
      case "agent.turn": {
        const id = num(message.id);
        const text = typeof message.text === "string" ? message.text.trim() : "";
        if (!text) return this.send({ t: "agent.error", id, message: WORDS.misheard });
        return void this.startTurn(id, text);
      }
      case "agent.audio":
        return this.onAudio(num(message.id), num(message.rate));
      case "agent.audio.end":
        return void this.onAudioEnd(num(message.id), message.send === true);
      case "agent.cancel":
        return this.cancel(num(message.id));
      case "agent.reset":
        return this.reset();
      case "agent.result":
        return this.onResult(message);
      case "agent.shot":
        return this.onShot(message);
      default:
        return; // unknown agent messages are ignored
    }
  }

  /** A data frame on one of this session's streams; false when it is not one. */
  data(stream: number, bytes: Uint8Array): boolean {
    const shot = this.shots.get(stream);
    if (shot && !shot.bytes) {
      shot.chunks.push(bytes);
      shot.received += bytes.length;
      if (shot.received >= shot.expected) {
        const all = new Uint8Array(shot.received);
        let off = 0;
        for (const chunk of shot.chunks) {
          all.set(chunk, off);
          off += chunk.length;
        }
        shot.bytes = all.subarray(0, shot.expected);
        shot.chunks = [];
        for (const wake of shot.waiters.splice(0)) wake(shot.bytes);
      }
      return true;
    }
    const recording = this.recordings.get(stream);
    if (recording) {
      if (recording.ended || recording.bytes >= recording.limit) return true;
      const room = recording.limit - recording.bytes;
      const piece = bytes.length > room ? bytes.subarray(0, room) : bytes;
      recording.bytes += piece.length;
      recording.kept?.push(piece.slice());
      if (recording.transcription) recording.transcription.write(piece);
      else recording.early.push(piece.slice());
      return true;
    }
    return false;
  }

  private onHello(message: LinkCtrl) {
    const app = message.app as AgentApp | undefined;
    if (!app || typeof app.output !== "string") return;
    const apps = Array.isArray(message.apps) ? (message.apps as AgentApp[]).filter((a) => a && typeof a.output === "string") : [];
    this.hello = { app: { id: String(app.id ?? ""), title: String(app.title ?? app.output), output: app.output }, apps, locale: typeof message.locale === "string" ? message.locale : "" };
    // A launch on the user's screen ends when the launched guest says hello.
    for (const [call, pending] of this.calls) {
      if (pending.name !== "launch") continue;
      this.calls.delete(call);
      clearTimeout(pending.timer);
      pending.resolve({ ok: true, text: `Launched ${this.hello.app.title} (${this.hello.app.output}) on the user's screen. Observe it before acting.` });
    }
    // The new guest holds no agent glyphs: the whole atlas goes again.
    this.feed?.dropped();
    this.release();
    this.enqueue({ glyphs: "resend" });
    this.sendState();
    // Warm up: the thread and the speech helper are ready before the first request.
    if (this.service.codex) void this.ensureThread().catch((error) => this.service.log(`agent: thread warm-up failed: ${(error as Error).message}`));
    void transcriberCommand(this.service.options.storeDir, (line) => this.service.log(line));
  }

  private onResult(message: LinkCtrl) {
    const pending = this.calls.get(String(message.call));
    if (!pending) return;
    this.calls.delete(String(message.call));
    clearTimeout(pending.timer);
    pending.resolve({
      ok: message.ok === true,
      text: typeof message.text === "string" ? message.text : "",
      shot: typeof message.shot === "number" ? message.shot : undefined,
    });
  }

  private onShot(message: LinkCtrl) {
    const id = num(message.id);
    const bytes = num(message.bytes);
    if (!id || bytes <= 0 || bytes > AGENT_SHOT_BYTES) return;
    const timer = setTimeout(() => {
      const shot = this.shots.get(id);
      this.shots.delete(id);
      for (const wake of shot?.waiters.splice(0) ?? []) wake(undefined);
    }, 60_000);
    timer.unref?.();
    this.shots.set(id, { expected: bytes, received: 0, chunks: [], waiters: [], timer });
  }

  private waitShot(id: number, ms: number): Promise<Uint8Array | undefined> {
    const shot = this.shots.get(id);
    if (!shot) return Promise.resolve(undefined);
    const take = (bytes: Uint8Array | undefined) => {
      clearTimeout(shot.timer);
      this.shots.delete(id);
      return bytes;
    };
    if (shot.bytes) return Promise.resolve(take(shot.bytes));
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(take(undefined)), ms);
      shot.waiters.push((bytes) => {
        clearTimeout(timer);
        resolve(take(bytes));
      });
    });
  }

  // -------------------------------------------------------------------------
  // Speech
  // -------------------------------------------------------------------------

  private onAudio(id: number, rate: number) {
    if (!id || rate < 8000 || rate > 48000) return;
    this.recordings.get(id)?.transcription?.kill();
    const recording: Recording = { rate, bytes: 0, limit: Math.ceil((rate * 2 * AGENT_MIC_MAX_MS) / 1000), early: [], ended: false, send: false };
    if (existsSync(join(this.service.options.storeDir, "agent", KEEP_AUDIO))) recording.kept = [];
    this.recordings.set(id, recording);
    if (!this.turn) this.setPhase("listening");
    void transcriberCommand(this.service.options.storeDir, (line) => this.service.log(line)).then((command) => {
      if (this.recordings.get(id) !== recording) return;
      if (!command) {
        this.recordings.delete(id);
        this.send({ t: "agent.error", id, message: WORDS.noSpeech });
        if (!this.turn) this.setPhase("idle");
        return;
      }
      let latest = "";
      const transcription = new Transcription(
        command,
        rate,
        this.locale || undefined,
        (text) => {
          if (text === latest || this.recordings.get(id) !== recording) return;
          latest = text;
          this.send({ t: "agent.transcript", id, text, final: false });
        },
        (line) => this.service.log(line),
      );
      recording.transcription = transcription;
      for (const piece of recording.early.splice(0)) transcription.write(piece);
      if (recording.ended) transcription.end();
    });
  }

  private async onAudioEnd(id: number, send: boolean) {
    const recording = this.recordings.get(id);
    if (!recording) return;
    recording.ended = true;
    recording.send = send;
    const started = Date.now();
    // Wait for the helper when it was still being built.
    while (!recording.transcription && this.recordings.get(id) === recording) await Bun.sleep(50);
    if (this.recordings.get(id) !== recording || !recording.transcription) return;
    recording.transcription.end();
    const text = (await recording.transcription.done).trim();
    if (this.recordings.get(id) !== recording) return;
    this.recordings.delete(id);
    const seconds = (recording.bytes / 2 / recording.rate).toFixed(1);
    if (recording.kept) writeFileSync(join(this.service.options.storeDir, "agent", "last-recording.wav"), wav(recording.rate, recording.kept));
    this.service.log(`agent: heard ${seconds} s -> "${short(text, 40)}" (${Date.now() - started} ms after the end)`);
    this.send({ t: "agent.transcript", id, text, final: true });
    if (!text) {
      this.send({ t: "agent.error", id, message: WORDS.misheard });
      if (!this.turn) this.setPhase("idle");
      return;
    }
    if (send) await this.startTurn(id, text);
    else if (!this.turn) this.setPhase("idle");
  }

  // -------------------------------------------------------------------------
  // Turns
  // -------------------------------------------------------------------------

  private ensureThread(): Promise<string> {
    const codex = this.service.codex;
    if (!codex) return Promise.reject(new Error("codex is off"));
    if (this.threadId && this.threadEpoch === codex.epoch && codex.running) return Promise.resolve(this.threadId);
    this.threading ??= (async () => {
      const cwd = join(this.service.options.storeDir, "agent-work");
      mkdirSync(cwd, { recursive: true });
      const started = await codex.request("thread/start", {
        ephemeral: true,
        cwd,
        approvalPolicy: "never",
        sandbox: "read-only",
        serviceName: "pocket_companion",
        baseInstructions: AGENT_INSTRUCTIONS,
        dynamicTools: codexDynamicTools(),
      });
      const thread = started.thread as { id: string };
      if (this.threadId) this.service.unbindThread(this.threadId);
      this.threadId = thread.id;
      this.threadEpoch = codex.epoch;
      this.service.bindThread(thread.id, this);
      return thread.id;
    })().finally(() => {
      this.threading = undefined;
    });
    return this.threading;
  }

  private context(): string {
    const hello = this.hello;
    const app = hello ? `${hello.app.title} (${hello.app.output})` : "unknown";
    const apps = hello?.apps.length ? hello.apps.map((a) => `${a.title} (${a.output})`).join(", ") : "unknown";
    const own = this.own?.booted ? `${this.ownTitle} (${this.own.app})` : "off";
    return `[Console] The user's screen shows: ${app}. Installed apps: ${apps}. Your own screen: ${own}. Locale: ${hello?.locale || "unknown"}.`;
  }

  async startTurn(id: number, text: string) {
    if (/[\u3400-\u9fff]/.test(text)) this.spoken = "zh-CN";
    else if (/[a-z]/i.test(text)) this.spoken = "en";
    const w = WORDS;
    if (this.turn) {
      this.send({ t: "agent.error", id, message: w.busy });
      return;
    }
    const codex = this.service.codex;
    if (!codex) {
      this.send({ t: "agent.error", id, message: w.offline });
      return;
    }
    const turn: Turn = { id, request: text, text: "", usage: { ...ZERO_USAGE, total: this.total }, screen: "user", cancelled: false, items: new Map() };
    this.turn = turn;
    this.feed?.newTurn();
    this.send({ t: "agent.request", id, text });
    this.setPhase("thinking", "user");
    const started = Date.now();
    try {
      const threadId = await this.ensureThread();
      if (turn.cancelled) return this.finishTurn(turn, "interrupted");
      const result = await codex.request("turn/start", {
        threadId,
        input: [
          { type: "text", text: this.context(), text_elements: [] },
          { type: "text", text, text_elements: [] },
        ],
      });
      turn.codexTurnId = (result.turn as { id: string }).id;
      this.service.log(`agent: turn ${id} "${short(text, 40)}" started in ${Date.now() - started} ms`);
      if (turn.cancelled) void this.interrupt(turn);
    } catch (error) {
      turn.error = (error as Error).message;
      this.finishTurn(turn, "failed");
    }
  }

  private finishTurn(turn: Turn, status: string) {
    if (this.turn !== turn) return;
    this.turn = undefined;
    clearInterval(turn.ownTimer);
    for (const [call, pending] of this.calls) {
      this.calls.delete(call);
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, text: "the turn ended" });
    }
    if (status === "failed") this.send({ t: "agent.error", id: turn.id, message: turn.error ?? "the turn failed" });
    else this.send({ t: "agent.done", id: turn.id, text: turn.text, usage: turn.usage });
    this.service.log(`agent: turn ${turn.id} ${status}, ${turn.usage.input} in (${turn.usage.cachedInput} cached) / ${turn.usage.output} out, ${turn.usage.total} in the conversation`);
    this.setPhase("idle", turn.screen);
  }

  private async interrupt(turn: Turn) {
    const codex = this.service.codex;
    if (codex && this.threadId && turn.codexTurnId) {
      await codex.request("turn/interrupt", { threadId: this.threadId, turnId: turn.codexTurnId }).catch(() => {});
    }
    // codex answers with turn/completed (interrupted); end it here if it does not.
    setTimeout(() => this.finishTurn(turn, "interrupted"), 3_000).unref?.();
  }

  private cancel(id: number) {
    const turn = this.turn;
    if (!turn || (id && turn.id !== id) || turn.cancelled) return;
    turn.cancelled = true;
    for (const [call, pending] of this.calls) {
      this.calls.delete(call);
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, text: "the user stopped you" });
    }
    if (turn.codexTurnId) void this.interrupt(turn);
  }

  private reset() {
    if (this.turn) this.cancel(this.turn.id);
    if (this.threadId) this.service.unbindThread(this.threadId);
    this.threadId = undefined;
    this.total = 0;
    this.own?.close();
    this.own = undefined;
    this.lastTexts = { user: [], own: [] };
    this.setPhase("idle", "user");
    this.sendState();
  }

  codexExited(reason: string) {
    this.threadId = undefined;
    const turn = this.turn;
    if (turn) {
      turn.error = reason;
      this.finishTurn(turn, "failed");
    }
  }

  codexNotification(message: CodexNotification) {
    const turn = this.turn;
    const params = message.params;
    switch (message.method) {
      case "item/started": {
        const item = params.item as { type?: string; id?: string; phase?: string | null };
        if (turn && item?.type === "agentMessage" && typeof item.id === "string") turn.items.set(item.id, { phase: item.phase ?? null, text: "" });
        return;
      }
      case "item/agentMessage/delta": {
        if (!turn || turn.cancelled) return;
        const delta = String(params.delta ?? "");
        const item = turn.items.get(String(params.itemId));
        if (item?.phase === "commentary") {
          item.text += delta;
          return;
        }
        if (!delta) return;
        turn.text += delta;
        if (this.phase !== "replying") this.setPhase("replying");
        this.send({ t: "agent.delta", id: turn.id, text: delta });
        return;
      }
      case "item/completed": {
        const item = params.item as { type?: string; id?: string; text?: string };
        const tracked = turn && typeof item?.id === "string" ? turn.items.get(item.id) : undefined;
        if (turn && tracked?.phase === "commentary") {
          const line = (tracked.text || item.text || "").trim();
          if (line) this.send({ t: "agent.step", id: turn.id, text: short(line, 60) });
        }
        return;
      }
      case "thread/tokenUsage/updated": {
        const usage = params.tokenUsage as { total?: { totalTokens?: number }; last?: { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number } } | undefined;
        this.total = usage?.total?.totalTokens ?? this.total;
        if (!turn) return;
        if (turn.codexTurnId && params.turnId !== turn.codexTurnId) return;
        turn.usage = {
          input: turn.usage.input + (usage?.last?.inputTokens ?? 0),
          cachedInput: turn.usage.cachedInput + (usage?.last?.cachedInputTokens ?? 0),
          output: turn.usage.output + (usage?.last?.outputTokens ?? 0),
          total: this.total,
        };
        this.send({ t: "agent.usage", id: turn.id, usage: turn.usage });
        return;
      }
      case "error": {
        if (!turn || params.willRetry === true) return;
        const error = params.error as { message?: string } | undefined;
        turn.error = error?.message ?? "the model failed";
        return;
      }
      case "turn/completed": {
        const completed = params.turn as { id?: string; status?: string; error?: { message?: string } | null } | undefined;
        if (!turn || (turn.codexTurnId && completed?.id !== turn.codexTurnId)) return;
        if (completed?.error?.message) turn.error = completed.error.message;
        this.finishTurn(turn, completed?.status ?? "completed");
        return;
      }
      default:
        return;
    }
  }

  // -------------------------------------------------------------------------
  // Tools
  // -------------------------------------------------------------------------

  private stepLine(name: AgentToolName, args: Record<string, unknown>, screen: "user" | "own"): string {
    const w = WORDS;
    let line: string;
    switch (name) {
      case "observe":
        line = w.look;
        break;
      case "tap": {
        const x = num(args.x);
        const y = num(args.y);
        const hit = this.lastTexts[screen].find((t) => x >= t.x - 4 && x <= t.x + t.w + 4 && y >= t.y - 4 && y <= t.y + t.h + 4);
        line = hit ? w.tapText(short(hit.text)) : w.tapAt(x, y);
        break;
      }
      case "drag": {
        const dy = num(args.y1) - num(args.y0);
        line = Math.abs(dy) < 20 ? w.drag : dy < 0 ? w.scrollDown : w.scrollUp;
        break;
      }
      case "press":
        line = w.press(String(args.button ?? "").toUpperCase());
        break;
      case "type":
        line = w.type(short(String(args.text ?? "")));
        break;
      case "launch": {
        const wanted = String(args.app ?? "").toLowerCase();
        const app = this.hello?.apps.find((a) => a.output.toLowerCase() === wanted || a.title.toLowerCase() === wanted);
        line = w.open(app?.title ?? String(args.app ?? ""));
        break;
      }
      default:
        line = w.wait;
    }
    return screen === "own" ? w.own(line) : line;
  }

  /** One `item/tool/call`: answered with a DynamicToolCallResponse. Calls
   *  run one at a time, in arrival order: the model may issue several at
   *  once, and a screen does one thing at a time. */
  toolCall(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const run = this.tools.then(() => this.runTool(params));
    this.tools = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async runTool(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const turn = this.turn;
    const name = String(params.tool) as AgentToolName;
    const args = { ...((params.arguments ?? {}) as Record<string, unknown>) };
    const fail = (text: string) => ({ success: false, contentItems: [{ type: "inputText", text }] });
    if (!turn || turn.cancelled) return fail("The user stopped you. Do not act any further.");
    if (!AGENT_TOOLS.some((tool) => tool.name === name)) return fail(`unknown tool ${name}`);
    const screen = args.screen === "own" ? "own" : "user";
    delete args.screen;
    turn.screen = screen;
    this.setPhase("acting", screen);
    this.send({ t: "agent.step", id: turn.id, text: this.stepLine(name, args, screen) });
    const started = Date.now();
    const response = screen === "own" ? await this.ownTool(turn, name, args) : await this.userTool(turn, name, args);
    this.service.log(`agent: ${screen} ${name} ${JSON.stringify(args)} -> ${response.success ? "ok" : "failed"} in ${Date.now() - started} ms`);
    return response;
  }

  private async userTool(turn: Turn, name: AgentToolName, args: Record<string, unknown>): Promise<{ success: boolean; contentItems: Record<string, unknown>[] }> {
    if (!this.link && name !== "launch") return { success: false, contentItems: [{ type: "inputText", text: WORDS.dropped }] };
    const call = String(++this.callSeq);
    const timeout = name === "launch" ? (this.service.options.launchTimeoutMs ?? AGENT_LAUNCH_TIMEOUT_MS) : (this.service.options.toolTimeoutMs ?? AGENT_TOOL_TIMEOUT_MS);
    const result = await new Promise<ToolResult>((resolve) => {
      const timer = setTimeout(() => {
        this.calls.delete(call);
        resolve({ ok: false, text: `the console did not answer in ${Math.round(timeout / 1000)} s` });
      }, timeout);
      this.calls.set(call, { name, resolve, timer });
      this.send({ t: "agent.tool", id: turn.id, call, name, args });
    });
    const texts = reportTexts(result.text);
    if (texts.length) this.lastTexts.user = texts;
    const content: Record<string, unknown>[] = [{ type: "inputText", text: result.text || (result.ok ? "done" : "failed") }];
    if (result.shot !== undefined) {
      const bytes = await this.waitShot(result.shot, 8_000);
      // Only an observe that asked for the image spends the image's tokens.
      if (name === "observe" && args.image === true && bytes && bytes.length === AGENT_SHOT_BYTES) {
        content.push({ type: "inputImage", imageUrl: shotDataUrl(bytes) });
      }
    }
    return { success: result.ok, contentItems: content };
  }

  private async ensureOwn(app?: string): Promise<OwnScreenAnswer> {
    const command = this.service.ownScreenCommand();
    if (!command) throw new Error("this companion cannot run an own screen (no PocketJS checkout)");
    const wanted = app ?? (this.own?.booted ? undefined : this.hello?.app.output);
    if (!wanted) return this.own!.frame();
    const bundle = this.service.bundleFor(this.target, wanted);
    if (!bundle) throw new Error(`no Pocket app named ${wanted} is offered for ${this.target}`);
    this.own ??= new OwnScreen(command, (line) => this.service.log(line));
    this.ownTitle = bundle.title;
    const answer = await this.own.boot(bundle);
    return answer;
  }

  private async ownTool(turn: Turn, name: AgentToolName, args: Record<string, unknown>): Promise<{ success: boolean; contentItems: Record<string, unknown>[] }> {
    let answer: OwnScreenAnswer;
    try {
      if (name === "launch") answer = await this.ensureOwn(String(args.app ?? ""));
      else {
        if (!this.own?.booted) await this.ensureOwn();
        answer = await this.own!.act(name, args);
      }
    } catch (error) {
      return { success: false, contentItems: [{ type: "inputText", text: (error as Error).message }] };
    }
    this.lastTexts.own = answer.texts;
    void this.pushScreen(answer.rgb565);
    if (!turn.ownTimer && this.turn === turn) {
      turn.ownTimer = setInterval(() => {
        if (this.turn !== turn || !this.own?.booted) return clearInterval(turn.ownTimer);
        void this.own.frame().then((frame) => this.pushScreen(frame.rgb565), () => {});
      }, AGENT_OWN_FRAME_MS);
      turn.ownTimer.unref?.();
    }
    const report = {
      app: { id: "", title: this.ownTitle, output: this.own?.app ?? "" },
      keyboard: false,
      texts: answer.texts,
      ...(answer.error ? { error: answer.error } : {}),
    };
    const content: Record<string, unknown>[] = [{ type: "inputText", text: JSON.stringify(report) }];
    if (name === "observe" && args.image === true && answer.rgb565.length === AGENT_SHOT_BYTES) {
      content.push({ type: "inputImage", imageUrl: shotDataUrl(answer.rgb565) });
    }
    return { success: answer.ok, contentItems: content };
  }

  /** Stream a changed own-screen frame to the console's monitor. */
  private async pushScreen(rgb565: Uint8Array) {
    const link = this.link;
    if (!link || this.screenSending || rgb565.length !== AGENT_SHOT_BYTES) return;
    const hash = Bun.hash(rgb565).toString(16);
    if (hash === this.lastScreenHash) return;
    this.screenSending = true;
    try {
      const stream = this.companionStream();
      link.send({ t: "agent.screen", stream, width: AGENT_SHOT_WIDTH, height: AGENT_SHOT_HEIGHT, format: "rgb565", bytes: rgb565.length });
      for (let at = 0; at < rgb565.length; at += LINK_MAX_DATA) {
        if (!(await link.sendData(stream, rgb565.subarray(at, at + LINK_MAX_DATA)))) return;
      }
      this.lastScreenHash = hash;
    } finally {
      this.screenSending = false;
    }
  }

  close() {
    clearTimeout(this.heldTimer);
    if (this.turn) this.cancel(this.turn.id);
    this.own?.close();
    for (const recording of this.recordings.values()) recording.transcription?.kill();
    this.recordings.clear();
  }
}

export { AGENT_LINK_FEATURE } from "../../contracts/spec/agent.ts";
