// The system agent's overlay on the touch screen (contracts/spec/agent.ts).
//
// The build adds this module to every app that declares "system.agent"
// (tools/build.ts), and render() mounts it above the app's auxiliary surface
// (system-layers.ts). It is the same for every app:
//
//   L+R       opens the overlay on a choice of Talk (A) or Type (X); L+R
//             again, or B, closes it
//   Talk      the microphone streams to the companion until A or Send sends
//             the recording (B drops it)
//   Type      the keyboard opens for a typed request; START sends it
//
// A reply offers the same two choices for the next request.
//
// While the overlay is open the app under it is paused: its frame callbacks
// and button handlers stop (frame.ts suspendApp), its gestures are cancelled
// and a scrim takes the stylus. When the agent operates the app on the
// user's screen, the overlay shrinks to a banner, the app runs again, and
// the agent's taps, drags and presses replace the user's input until the
// turn ends (B stops it). When the agent works on its own screen, B tucks
// the overlay into the same banner and the user keeps the app; L+R brings
// the overlay back, with the reply once it is there.
//
// The agent's words come with their own glyphs: the companion sends an atlas
// for AGENT_FONT_SLOT before the words that need it, and every text here that
// can hold them draws from that slot.

import { batch, createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js";
import {
  AGENT_FONT,
  AGENT_FONT_SLOT,
  AGENT_LABELS,
  AGENT_MODE,
  AGENT_SCREEN,
  AGENT_SETTLE_FRAMES,
  type AgentApp,
  type AgentEvent,
  type AgentPhase,
  type AgentScreenReport,
  type AgentUsage,
} from "../../contracts/spec/agent.ts";
import { BTN, ENUMS } from "../../contracts/spec/spec.ts";
import {
  agentHost,
  agentStatus,
  BUTTON_BITS,
  dragFrames,
  idleFrames,
  isAgentButton,
  parseCapturedTexts,
  playedTouches,
  pressFrames,
  sendAgent,
  takeAgentEvents,
  tapFrames,
  type AgentHostOps,
  type PlayedFrame,
} from "./agent.ts";
import { animate, jump } from "./anim.ts";
import { after } from "./clock.ts";
import { FocusScope, Text, View } from "./components.ts";
import { getAuxiliarySurfaceRoots, hasAuxiliarySurface } from "./display.ts";
import { onButtonPress, onFrame, pushButtonHandlerBlock, suspendApp, SystemFrameContext } from "./frame.ts";
import { pushTouchBlock } from "./gesture.ts";
import type { HostOps } from "./host.ts";
import { appTable, launchApp } from "./launcher.ts";
import { createOsk, Osk, oskHeight } from "./osk.tsx";
import { openOsk } from "./osk-controller.ts";
import { createElement, detachNode, insertNode, render as rendererRender, setProp, type NodeMirror } from "./renderer.ts";
import { registerSystemLayer, setFrameInputFilter } from "./system-layers.ts";
import { auxiliaryTouches } from "./touch.ts";

const W = 320;
const H = 240;
const LINE = AGENT_FONT.lineHeight;

const INK = "#3d3929";
const MUTED = "#8c8476";
const PAPER = "#f7f3eb";
const EDGE = "#e2d8c6";
const ORANGE = "#d97757";
const BUBBLE = "#efdccb";
const NIGHT = "#2b2722";

const CARD = { x: 8, y: 8, w: 304, h: 224 };
const BANNER = { x: 8, y: 206, w: 304, h: 28 };
/** The chooser's card and its two tiles, in screen pixels. */
const CHOOSER = { x: 8, y: 40, w: 304, h: 160 };
const TALK_TILE = { x: CHOOSER.x + 12, y: CHOOSER.y + 50, w: 134, h: 82 };
const TYPE_TILE = { x: CHOOSER.x + 158, y: CHOOSER.y + 50, w: 134, h: 82 };
/** Pills in a card's footer: Talk and Type under a reply, Send while
 *  listening. */
const PILL_Y = CARD.y + CARD.h - 25;
const TALK_PILL = { x: CARD.x + 10, y: PILL_Y, w: 66, h: 20 };
const TYPE_PILL = { x: CARD.x + 82, y: PILL_Y, w: 66, h: 20 };
const SEND_PILL = { x: CARD.x + CARD.w - 76, y: PILL_Y, w: 66, h: 20 };
/** Typed turns carry this bit; audio turns use the console's stream id. */
const TYPED_TURN = 0x4000_0000;

type Phase = "closed" | "offline" | "choose" | "compose" | "listening" | "working" | "reply";
type Rect = { x: number; y: number; w: number; h: number };
type Target = "talk" | "type" | "send";

const inside = (rect: Rect, x: number, y: number) => x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h;

registerSystemLayer(mountAgentLayer);

function mountAgentLayer(ops: HostOps): (() => void) | null {
  const host = agentHost();
  if (!host || !hasAuxiliarySurface()) return null;
  const roots = getAuxiliarySurfaceRoots();
  const layer = createElement("view");
  setProp(layer, "style", {
    width: W,
    height: H,
    posType: ENUMS.PosType.Absolute,
    insetT: 0,
    insetL: 0,
    hitPass: 1,
  }, undefined);
  insertNode(roots.native, layer);
  const dispose = rendererRender(
    () => (
      <SystemFrameContext.Provider value={true}>
        <AgentLayer host={host} ops={ops} appRoot={roots.app} />
      </SystemFrameContext.Provider>
    ) as unknown as NodeMirror,
    layer,
  );
  return () => {
    dispose();
    setFrameInputFilter(null);
    suspendApp(false);
    if (layer.parent) detachNode(layer.parent, layer);
    ops.destroyNode(layer.id);
  };
}

// ---------------------------------------------------------------------------
// Text in the agent's slot
// ---------------------------------------------------------------------------

/** Closing punctuation hangs at a line's end rather than opening the next. */
const CLOSING = new Set(Array.from("，。！？：；、）》」』”’…,.!?:;)]"));
const HANG = AGENT_FONT.cellW;

function isWide(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return code >= 0x2e80;
}

/** Greedy wrap for a line box `width` px wide: wide characters break
 *  anywhere, Latin words at spaces, a word longer than a line by character.
 *  Closing punctuation may hang one glyph past `width`, so callers wrap a
 *  glyph narrower than their box (HANG). */
function wrapText(text: string, width: number, advance: (ch: string) => number, maxLines = 999): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    let lineWidth = 0;
    const tokens = paragraph.match(/[⺀-￿]|[^\s⺀-￿]+|\s+/gu) ?? [];
    for (const token of tokens) {
      let tokenWidth = 0;
      for (const ch of token) tokenWidth += advance(ch);
      if (lineWidth + tokenWidth <= width || line === "") {
        if (tokenWidth > width && !isWide(token)) {
          for (const ch of token) {
            const w = advance(ch);
            if (lineWidth + w > width && line !== "") {
              lines.push(line);
              line = "";
              lineWidth = 0;
            }
            line += ch;
            lineWidth += w;
          }
          continue;
        }
        line += token;
        lineWidth += tokenWidth;
        continue;
      }
      if (/^\s+$/.test(token)) {
        lines.push(line);
        line = "";
        lineWidth = 0;
        continue;
      }
      if (CLOSING.has(token)) {
        line += token;
        lineWidth += tokenWidth;
        continue;
      }
      lines.push(line.trimEnd());
      line = token;
      lineWidth = tokenWidth;
    }
    lines.push(line.trimEnd());
  }
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = `${kept[maxLines - 1]!.slice(0, -1)}…`;
    return kept;
  }
  return lines;
}

function AgentText(props: { text: string; color?: string; x: number; y: number; w?: number; align?: "left" | "center" | "right" }) {
  return (
    <Text
      style={{
        posType: ENUMS.PosType.Absolute,
        insetL: props.x,
        insetT: props.y,
        ...(props.w !== undefined ? { width: props.w } : {}),
        fontSlot: AGENT_FONT_SLOT,
        lineHeight: LINE,
        textColor: props.color ?? INK,
        ...(props.align === "right" ? { textAlign: ENUMS.TextAlign.Right } : props.align === "center" ? { textAlign: ENUMS.TextAlign.Center } : {}),
      }}
    >
      {props.text || " "}
    </Text>
  );
}

/** Claude's spark: four bars about one centre. */
function Spark(props: { x: number; y: number; size: number; color?: string }) {
  const bar = (angle: number) => (
    <View
      style={{
        posType: ENUMS.PosType.Absolute,
        insetL: props.x + props.size / 2 - 1,
        insetT: props.y,
        width: 2,
        height: props.size,
        radius: 1,
        bgColor: props.color ?? ORANGE,
        rotate: angle,
      }}
    />
  );
  return (
    <>
      {bar(0)}
      {bar(45)}
      {bar(90)}
      {bar(135)}
    </>
  );
}

/** The microphone: a capsule on a stand, centred at (cx, y). */
function Mic(props: { cx: number; y: number; color: string }) {
  const at = (x: number, y: number, w: number, h: number, radius = 0) => ({
    posType: ENUMS.PosType.Absolute,
    insetL: props.cx + x,
    insetT: props.y + y,
    width: w,
    height: h,
    radius,
    bgColor: props.color,
  });
  return (
    <>
      <View style={at(-5, 0, 10, 16, 5)} />
      <View style={at(-1, 18, 2, 4)} />
      <View style={at(-6, 22, 12, 2, 1)} />
    </>
  );
}

/** A keyboard, 30x20 from (cx - 15, y): a slab with two rows of five keys
 *  and a space bar, a 3 px margin around the keys. */
function Keys(props: { cx: number; y: number; color: string; keyColor: string }) {
  const key = (x: number, y: number, w: number) => (
    <View
      style={{
        posType: ENUMS.PosType.Absolute,
        insetL: props.cx - 15 + x,
        insetT: props.y + y,
        width: w,
        height: 3,
        radius: 1,
        bgColor: props.keyColor,
      }}
    />
  );
  return (
    <>
      <View
        style={{
          posType: ENUMS.PosType.Absolute,
          insetL: props.cx - 15,
          insetT: props.y,
          width: 30,
          height: 20,
          radius: 3,
          bgColor: props.color,
        }}
      />
      {key(4, 4, 3)}
      {key(9, 4, 3)}
      {key(14, 4, 3)}
      {key(19, 4, 3)}
      {key(24, 4, 3)}
      {key(4, 9, 3)}
      {key(9, 9, 3)}
      {key(14, 9, 3)}
      {key(19, 9, 3)}
      {key(24, 9, 3)}
      {key(9, 14, 13)}
    </>
  );
}

function formatTokens(usage: AgentUsage | null): string {
  if (!usage) return "";
  const n = usage.input + usage.output;
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k tokens` : `${n} tokens`;
}

// ---------------------------------------------------------------------------
// Tools on the user's screen
// ---------------------------------------------------------------------------

interface ToolJob {
  call: string;
  name: string;
  args: Record<string, unknown>;
  /** Frames to play; the job waits for them, then settles, then reads. */
  frames: PlayedFrame[];
  settle: number;
  image: boolean;
  stage: "play" | "settle" | "capture" | "done";
}

// ---------------------------------------------------------------------------
// The layer
// ---------------------------------------------------------------------------

function AgentLayer(props: { host: AgentHostOps; ops: HostOps; appRoot: NodeMirror }) {
  const { host, ops } = props;
  const [phase, setPhase] = createSignal<Phase>("closed");
  const [available, setAvailable] = createSignal(agentStatus(host).available);
  const [request, setRequest] = createSignal("");
  const [transcript, setTranscript] = createSignal("");
  const [reply, setReply] = createSignal("");
  const [step, setStep] = createSignal("");
  const [usage, setUsage] = createSignal<AgentUsage | null>(null);
  const [remote, setRemote] = createSignal<{ phase: AgentPhase; screen: "user" | "own" }>({ phase: "idle", screen: "user" });
  const [acting, setActing] = createSignal(false);
  const [draft, setDraft] = createSignal("");
  const [glyphs, setGlyphs] = createSignal(0);
  const [scroll, setScroll] = createSignal(0);
  /** A finished turn: the mascot hops before it turns back to the user. */
  const [celebrate, setCelebrate] = createSignal(false);
  /** Tucked into the banner while the agent works on its own screen. */
  const [tucked, setTucked] = createSignal(false);

  let turn = 0;
  let listenId = 0;
  let typedTurns = 0;
  let replyArea: NodeMirror | undefined;
  let banner: NodeMirror | undefined;
  let level: NodeMirror | undefined;

  // -- glyph widths in the agent's slot, dropped when a new atlas arrives --
  const widths = new Map<string, number>();
  const advance = (ch: string): number => {
    let w = widths.get(ch);
    if (w === undefined) {
      w = ops.measureText(ch, AGENT_FONT_SLOT);
      widths.set(ch, w);
    }
    return w;
  };
  /** The companion's atlas is loaded: its words (and these labels) draw. */
  const fontReady = createMemo(() => {
    glyphs();
    return ops.measureText("A", AGENT_FONT_SLOT) > 0;
  });

  const app = (): AgentApp => {
    const table = appTable();
    const current = table?.current ?? "";
    const entry = table?.apps.find((candidate) => candidate.output === current);
    return entry ? { id: entry.id, title: entry.title, output: entry.output } : { id: current, title: "Pocket Home", output: current };
  };
  const hello = () => {
    const table = appTable();
    const apps = (table?.apps ?? []).map((entry) => ({ id: entry.id, title: entry.title, output: entry.output }));
    sendAgent(host, { t: "agent.hello", app: app(), apps, locale: "" });
  };
  if (available()) hello();

  // -- the stage: what the mascot does follows the phase --------------------
  createEffect(() => {
    const p = phase();
    const r = remote();
    const own = r.screen === "own";
    if (p === "closed") host.stage(AGENT_MODE.idle, AGENT_SCREEN.idle);
    else if (p === "offline" || p === "choose" || p === "compose") host.stage(AGENT_MODE.attend, AGENT_SCREEN.mirror);
    else if (p === "listening") host.stage(AGENT_MODE.listen, AGENT_SCREEN.mirror);
    else if (p === "reply") host.stage(celebrate() ? AGENT_MODE.happy : AGENT_MODE.attend, AGENT_SCREEN.mirror);
    else if (p === "working") {
      const mode = r.phase === "replying" ? AGENT_MODE.speak : acting() || r.phase === "acting" ? AGENT_MODE.act : AGENT_MODE.think;
      host.stage(mode, own ? AGENT_SCREEN.own : AGENT_SCREEN.mirror);
    }
  });

  // -- pausing the app while the overlay is open ----------------------------
  const modal = createMemo(() => phase() !== "closed" && !tucked() && !(phase() === "working" && acting()));
  const ownScreen = () => remote().screen === "own" && !acting();
  createEffect(() => {
    if (!modal()) return;
    suspendApp(true);
    const unblockButtons = pushButtonHandlerBlock();
    const unblockTouches = pushTouchBlock();
    onCleanup(() => {
      suspendApp(false);
      unblockButtons();
      unblockTouches();
    });
  });

  // -- input: pass through while open, the agent's own while it acts --------
  let played: PlayedFrame[] = [];
  let previousRaw = 0;
  let stopAsked = false;
  setFrameInputFilter((input) => {
    const raw = input.buttons;
    const edge = raw & ~previousRaw;
    previousRaw = raw;
    if (!(phase() === "working" && acting())) return;
    if (edge & BTN.CROSS) stopAsked = true;
    const frame = played.shift() ?? IDLE_FRAME;
    const contact = playedTouches(frame);
    input.buttons = frame.buttons;
    input.touches = contact?.touches;
    input.hits = undefined;
    input.surfaces = contact?.surfaces;
  });

  // -- opening and closing ---------------------------------------------------
  const osk = createOsk({
    value: draft,
    setValue: setDraft,
    onCommit: (text) => submit(text),
    onClose: () => {
      if (phase() === "compose") choose();
    },
  });

  const resetTurn = () => {
    setRequest("");
    setTranscript("");
    setReply("");
    setStep("");
    setScroll(0);
  };

  const close = () => {
    if (osk.isOpen()) osk.close();
    batch(() => {
      setPhase("closed");
      setActing(false);
      setTucked(false);
    });
    played = [];
    jobs.length = 0;
    job = null;
  };

  /** L+R: the choice of Talk or Type, or offline. */
  const choose = () => {
    if (osk.isOpen()) osk.close();
    setPhase(available() ? "choose" : "offline");
  };

  const compose = () => {
    if (!available()) {
      setPhase("offline");
      return;
    }
    setDraft("");
    setPhase("compose");
    osk.open();
  };

  const submit = (text: string) => {
    const clean = text.trim();
    if (!clean) return;
    typedTurns += 1;
    turn = TYPED_TURN | typedTurns;
    resetTurn();
    setRequest(clean);
    if (!sendAgent(host, { t: "agent.turn", id: turn, text: clean })) {
      setReply(AGENT_LABELS.lost);
      setPhase("reply");
      return;
    }
    setPhase("working");
  };

  const startListening = () => {
    if (!available()) {
      setPhase("offline");
      return;
    }
    if (osk.isOpen()) osk.close();
    const id = host.listen(1);
    if (id === 0) {
      compose();
      return;
    }
    listenId = id;
    resetTurn();
    setPhase("listening");
  };

  const finishListening = (send: boolean) => {
    if (phase() !== "listening") return;
    host.listen(send ? 0 : -1);
    if (!send) {
      choose();
      return;
    }
    turn = listenId;
    setRequest(transcript());
    setPhase("working");
  };

  const stopTurn = () => {
    if (turn !== 0) sendAgent(host, { t: "agent.cancel", id: turn });
    played = [];
    jobs.length = 0;
    job = null;
    batch(() => {
      setActing(false);
      if (!reply()) setReply(AGENT_LABELS.stopped);
      setPhase("reply");
    });
  };

  // -- tools -----------------------------------------------------------------
  const jobs: ToolJob[] = [];
  let job: ToolJob | null = null;
  let bannerHiddenUntil = -1;
  let frameCount = 0;

  const answer = (call: string, ok: boolean, text: string, shot?: number) => {
    sendAgent(host, { t: "agent.result", call, ok, text, ...(shot ? { shot } : {}) });
  };

  const startJob = (next: ToolJob) => {
    const { args } = next;
    switch (next.name) {
      case "observe":
        next.image = args.image === true;
        next.settle = 1;
        break;
      case "tap":
        if (typeof args.x !== "number" || typeof args.y !== "number") return answer(next.call, false, "tap needs x and y");
        next.frames = tapFrames(args.x, args.y);
        break;
      case "drag":
        if (![args.x0, args.y0, args.x1, args.y1].every((v) => typeof v === "number")) {
          return answer(next.call, false, "drag needs x0, y0, x1 and y1");
        }
        next.frames = dragFrames(args.x0 as number, args.y0 as number, args.x1 as number, args.y1 as number);
        break;
      case "press": {
        if (!isAgentButton(args.button)) return answer(next.call, false, `unknown button ${String(args.button)}`);
        const times = typeof args.times === "number" ? Math.max(1, Math.min(20, Math.floor(args.times))) : 1;
        next.frames = pressFrames(BUTTON_BITS[args.button], times);
        break;
      }
      case "type": {
        const keyboard = openOsk();
        if (!keyboard || keyboard === osk) return answer(next.call, false, "no keyboard is open: tap a text field first");
        keyboard.insert(String(args.text ?? ""));
        if (args.submit === true) keyboard.commit();
        break;
      }
      case "wait": {
        const ms = typeof args.ms === "number" ? Math.max(100, Math.min(5000, args.ms)) : 1000;
        next.frames = idleFrames(Math.round(ms / (1000 / 60)));
        next.settle = 0;
        break;
      }
      case "launch": {
        const name = String(args.app ?? "").toLowerCase();
        const table = appTable();
        // The launcher is not among the apps; "home" names it too.
        const launcher = (JSON.parse(ops.appTable?.() ?? "{}") as { launcher?: string }).launcher ?? "";
        const target = table?.apps.find(
          (entry) => entry.output.toLowerCase() === name || entry.title.toLowerCase() === name || entry.id.toLowerCase() === name,
        ) ?? (launcher && (name === launcher.toLowerCase() || name === "home") ? { output: launcher }
          : name && table && name === table.current.toLowerCase() ? { output: table.current } : undefined);
        if (!target) return answer(next.call, false, `no installed app called ${String(args.app)}`);
        if (target.output === table?.current) break;
        // The guest is replaced after this frame; the companion answers the
        // call when the new guest says hello.
        if (!launchApp(target.output)) return answer(next.call, false, "the console refused to switch apps");
        return;
      }
      default:
        return answer(next.call, false, `unknown tool ${next.name}`);
    }
    played = next.frames.slice();
    job = next;
  };

  const stepJob = (current: ToolJob) => {
    if (current.stage === "play") {
      if (played.length > 0) return;
      current.stage = "settle";
    }
    if (current.stage === "settle") {
      if (current.settle-- > 0) return;
      ops.captureTexts?.(1, props.appRoot.id);
      current.stage = "capture";
      return;
    }
    if (current.stage === "capture") {
      const report: AgentScreenReport = {
        app: app(),
        keyboard: openOsk() !== null,
        texts: parseCapturedTexts(ops.capturedTexts?.(1) ?? ""),
      };
      let shot = 0;
      if (current.image) {
        // The banner leaves the picture for the frame the shot reads.
        if (banner) jump(banner, "opacity", 0);
        bannerHiddenUntil = frameCount + 3;
        shot = host.shot();
      }
      answer(current.call, true, JSON.stringify(report), shot || undefined);
      current.stage = "done";
      job = null;
    }
  };

  // -- events ----------------------------------------------------------------
  const onEvent = (event: AgentEvent) => {
    switch (event.t) {
      case "chord.down": {
        const p = phase();
        if (tucked()) setTucked(false);
        else if (p === "closed") choose();
        else if (p === "listening") finishListening(true);
        else if (p !== "working") close();
        return;
      }
      case "chord.up":
        return;
      case "mic.stop":
        if (event.id === listenId) finishListening(true);
        return;
      case "glyphs":
        widths.clear();
        setGlyphs(glyphs() + 1);
        return;
      case "link":
        setAvailable(event.available);
        if (event.available) hello();
        else if (phase() === "working" || phase() === "listening") {
          batch(() => {
            setActing(false);
            setReply(AGENT_LABELS.lost);
            setPhase("reply");
          });
        }
        return;
      case "agent.state":
        setRemote({ phase: event.phase, screen: event.screen });
        // A guest that booted mid-turn (the agent launched it) picks it up.
        if (event.phase !== "idle" && event.turn !== 0 && (phase() === "closed" || turn === event.turn)) {
          turn = event.turn;
          batch(() => {
            if (phase() === "closed") resetTurn();
            if (event.request && !request()) setRequest(event.request);
            setActing(event.phase === "acting" && event.screen === "user");
            setPhase("working");
          });
        }
        return;
      case "agent.transcript":
        if (event.id === listenId || event.id === turn) {
          setTranscript(event.text);
          if (phase() === "working" && event.final) setRequest(event.text);
        }
        return;
      case "agent.request":
        if (event.id === turn) setRequest(event.text);
        return;
      case "agent.delta":
        if (event.id === turn) setReply(reply() + event.text);
        return;
      case "agent.step":
        if (event.id === turn) setStep(event.text);
        return;
      case "agent.usage":
        if (event.id === turn) setUsage(event.usage);
        return;
      case "agent.tool":
        if (event.id !== turn && turn !== 0) return;
        if (phase() !== "working") {
          resetTurn();
          setPhase("working");
        }
        turn = event.id;
        setActing(true);
        jobs.push({ call: event.call, name: event.name, args: event.args ?? {}, frames: [], settle: AGENT_SETTLE_FRAMES, image: false, stage: "play" });
        return;
      case "agent.done":
        if (event.id !== turn) return;
        batch(() => {
          if (event.text) setReply(event.text);
          setUsage(event.usage);
          setActing(false);
          setCelebrate(true);
          setPhase("reply");
        });
        after(1.6, () => setCelebrate(false));
        return;
      case "agent.error":
        if (event.id !== turn && event.id !== listenId) return;
        batch(() => {
          setReply(event.message);
          setActing(false);
          setPhase("reply");
        });
        return;
    }
  };

  onFrame(() => {
    frameCount += 1;
    for (const event of takeAgentEvents(host)) onEvent(event);
    if (stopAsked) {
      stopAsked = false;
      if (phase() === "working") stopTurn();
    }
    if (!job && jobs.length > 0) startJob(jobs.shift()!);
    if (job) stepJob(job);
    if (banner && bannerHiddenUntil >= 0 && frameCount >= bannerHiddenUntil) {
      jump(banner, "opacity", 1);
      bannerHiddenUntil = -1;
    }
    if (level && phase() === "listening") jump(level, "scale", 1 + host.level() / 220);
  });

  // -- buttons and the stylus while the overlay is open ----------------------
  const ALL = 0xffff;
  onButtonPress(
    ALL,
    (pressed) => {
      const p = phase();
      if (p === "closed" || (p === "working" && acting())) return;
      if (osk.isOpen()) return; // the keyboard owns its chords
      if (pressed & BTN.CROSS) {
        if (p === "listening") finishListening(false);
        else if (p === "reply") close();
        else if (p === "working" && ownScreen()) setTucked(true);
        else if (p === "working") stopTurn();
        else close();
        return;
      }
      if (pressed & BTN.SQUARE && p === "working") {
        stopTurn();
        return;
      }
      if (pressed & BTN.CIRCLE) {
        if (p === "choose" || p === "reply") startListening();
        else if (p === "listening") finishListening(true);
        else if (p === "offline") close();
        return;
      }
      if (pressed & BTN.TRIANGLE && (p === "choose" || p === "reply")) {
        compose();
        return;
      }
      if (p === "reply" && pressed & (BTN.UP | BTN.DOWN)) {
        setScroll(Math.max(0, scroll() + (pressed & BTN.DOWN ? LINE * 3 : -LINE * 3)));
      }
    },
    { allowWhenBlocked: true },
  );

  // A target darkens under the stylus and acts when it lifts there.
  const [pressedTarget, setPressedTarget] = createSignal<Target | null>(null);
  const targetAt = (x: number, y: number): Target | null => {
    const p = phase();
    if (p === "choose") return inside(TALK_TILE, x, y) ? "talk" : inside(TYPE_TILE, x, y) ? "type" : null;
    if (p === "reply") return inside(TALK_PILL, x, y) ? "talk" : inside(TYPE_PILL, x, y) ? "type" : null;
    if (p === "listening") return inside(SEND_PILL, x, y) ? "send" : null;
    return null;
  };
  const act = (target: Target) => {
    if (target === "talk") startListening();
    else if (target === "type") compose();
    else finishListening(true);
  };

  let downAt: { x: number; y: number } | null = null;
  let travelled = 0;
  const keyboardTop = H - oskHeight("auxiliary", "light");
  onFrame(() => {
    if (!modal()) {
      downAt = null;
      if (pressedTarget()) setPressedTarget(null);
      return;
    }
    const contact = auxiliaryTouches()[0];
    if (contact) {
      if (!downAt) {
        downAt = { x: contact.x, y: contact.y };
        travelled = 0;
        setPressedTarget(targetAt(contact.x, contact.y));
      } else {
        travelled = Math.max(travelled, Math.abs(contact.x - downAt.x) + Math.abs(contact.y - downAt.y));
        if (travelled > 10 && pressedTarget()) setPressedTarget(null);
      }
      return;
    }
    if (!downAt) return;
    const at = downAt;
    const target = pressedTarget();
    downAt = null;
    setPressedTarget(null);
    if (travelled > 10) return;
    if (target) {
      act(target);
      return;
    }
    const p = phase();
    if (p === "compose") {
      if (at.y >= keyboardTop) return;
      if (at.x >= CARD.x + CARD.w - 64 && at.y >= keyboardTop - 40) submit(draft());
      return;
    }
    const inCard = inside(CARD, at.x, at.y);
    if (p === "choose") {
      if (!inside(CHOOSER, at.x, at.y)) close();
      return;
    }
    if (p === "working") {
      if (inCard && at.y >= CARD.y + CARD.h - 30) {
        if (ownScreen()) setTucked(true);
        else stopTurn();
      }
      return;
    }
    if (p === "reply") {
      if (!inCard) close();
      return;
    }
    if (p === "offline") close();
  });

  // -- the panel's text, wrapped in the agent's slot -------------------------
  const BODY_W = CARD.w - 28;
  const requestLines = createMemo(() => {
    glyphs();
    const text = request() || transcript();
    return text ? wrapText(text, 210, advance, 3) : [];
  });
  const replyLines = createMemo(() => {
    glyphs();
    return reply() ? wrapText(reply(), BODY_W - HANG, advance) : [];
  });
  const transcriptLines = createMemo(() => {
    glyphs();
    return transcript() ? wrapText(transcript(), BODY_W - HANG, advance, 5) : [];
  });
  const requestWidth = createMemo(() => {
    let widest = 0;
    for (const line of requestLines()) {
      let w = 0;
      for (const ch of line) w += advance(ch);
      widest = Math.max(widest, w);
    }
    return widest;
  });

  const bubbleTop = CARD.y + 32;
  const bubbleHeight = () => (requestLines().length > 0 ? requestLines().length * LINE + 10 : 0);
  const statusTop = () => bubbleTop + bubbleHeight() + (bubbleHeight() > 0 ? 8 : 0);
  const replyTop = () => statusTop() + (phase() === "working" ? LINE + 6 : 0);
  const replyBottom = CARD.y + CARD.h - 32;
  const replyHeight = () => Math.max(LINE, replyBottom - replyTop());

  // Keep the newest reply line in view while it streams; the d-pad scrolls
  // a finished one.
  createEffect(() => {
    const lines = replyLines().length;
    const overflow = Math.max(0, lines * LINE - replyHeight());
    const offset = phase() === "reply" ? Math.min(scroll(), overflow) : overflow;
    if (phase() === "reply" && scroll() > overflow) setScroll(overflow);
    if (replyArea) jump(replyArea, "translateY", -offset);
  });

  const status = () => {
    if (step()) return step();
    if (remote().screen === "own" && remote().phase === "acting") return AGENT_LABELS.ownScreen;
    if (acting() || remote().phase === "acting") return AGENT_LABELS.acting;
    return AGENT_LABELS.thinking;
  };

  /** One line of `text` that fits `width`, with an ellipsis when cut. */
  const oneLine = (text: string, width: number) => {
    glyphs();
    return wrapText(text, width - HANG, advance, 1)[0] ?? "";
  };

  const footer = () => (ownScreen() ? AGENT_LABELS.ownHints : AGENT_LABELS.stop);

  const absolute = (x: number, y: number, w: number, h: number) => ({
    posType: ENUMS.PosType.Absolute,
    insetL: x,
    insetT: y,
    width: w,
    height: h,
  });

  /** A fixed label: the agent's slot once its atlas is in, the bundle's
   *  baked face until then. */
  const Label = (labelProps: { text: string; color?: string; x: number; y: number; w?: number; align?: "left" | "center" | "right" }) => (
    <Show
      when={fontReady()}
      fallback={
        <Text
          class="text-xs"
          style={{
            posType: ENUMS.PosType.Absolute,
            insetL: labelProps.x,
            insetT: labelProps.y + 1,
            ...(labelProps.w !== undefined ? { width: labelProps.w } : {}),
            textColor: labelProps.color ?? INK,
            ...(labelProps.align === "right"
              ? { textAlign: ENUMS.TextAlign.Right }
              : labelProps.align === "center"
                ? { textAlign: ENUMS.TextAlign.Center }
                : {}),
          }}
        >
          {labelProps.text}
        </Text>
      }
    >
      <AgentText {...labelProps} />
    </Show>
  );

  /** A footer pill in card coordinates: a button's letter in a disc, then
   *  the action. */
  const Pill = (pillProps: { rect: Rect; button: string; text: string; target: Target; primary?: boolean }) => {
    const down = () => pressedTarget() === pillProps.target;
    const fill = () => (pillProps.primary ? (down() ? "#b85f42" : ORANGE) : down() ? "#e4d7c3" : "#ffffff");
    const ink = () => (pillProps.primary ? "#ffffff" : INK);
    return (
      <View
        style={{
          ...absolute(pillProps.rect.x - CARD.x, pillProps.rect.y - CARD.y, pillProps.rect.w, pillProps.rect.h),
          bgColor: fill(),
          radius: 10,
          ...(pillProps.primary ? {} : { borderColor: EDGE, borderWidth: 1 }),
        }}
      >
        <View style={{ ...absolute(3, 3, 14, 14), radius: 7, bgColor: pillProps.primary ? "#ffffff" : INK }} />
        <Label text={pillProps.button} color={pillProps.primary ? ORANGE : "#ffffff"} x={3} y={1} w={14} align="center" />
        <Label text={pillProps.text} color={ink()} x={21} y={1} />
      </View>
    );
  };

  /** One of the chooser's two tiles, in the chooser's coordinates. */
  const Tile = (tileProps: { rect: Rect; button: string; text: string; target: Target }) => {
    const down = () => pressedTarget() === tileProps.target;
    return (
      <View
        style={{
          ...absolute(tileProps.rect.x - CHOOSER.x, tileProps.rect.y - CHOOSER.y, tileProps.rect.w, tileProps.rect.h),
          bgColor: down() ? "#efe6d8" : "#ffffff",
          radius: 12,
          borderColor: down() ? ORANGE : EDGE,
          borderWidth: 1,
        }}
      >
        <View style={{ ...absolute(tileProps.rect.w / 2 - 22, 8, 44, 44), radius: 22, bgColor: down() ? "#b85f42" : ORANGE }} />
        {tileProps.target === "talk" ? (
          <Mic cx={tileProps.rect.w / 2} y={18} color="#ffffff" />
        ) : (
          <Keys cx={tileProps.rect.w / 2} y={20} color="#ffffff" keyColor={ORANGE} />
        )}
        <View style={{ ...absolute(tileProps.rect.w / 2 - 30, 58, 16, 16), radius: 8, bgColor: INK }} />
        <Label text={tileProps.button} color="#ffffff" x={tileProps.rect.w / 2 - 30} y={57} w={16} align="center" />
        <Label text={tileProps.text} x={tileProps.rect.w / 2 - 8} y={57} />
      </View>
    );
  };

  return (
    <>
      <Show when={modal()}>
        <View
          ref={(node: NodeMirror) => {
            jump(node, "opacity", 0);
            animate(node, "opacity", 1, { dur: 160, easing: "out" });
          }}
          style={{ ...absolute(0, 0, W, H), bgColor: "#000000a0" }}
        />
      </Show>

      <Show when={phase() === "offline"}>
        <FocusScope style={{ ...absolute(CARD.x, 70, CARD.w, 100), bgColor: PAPER, radius: 10, borderColor: EDGE, borderWidth: 1 }}>
          <Spark x={14} y={14} size={14} />
          <Text class="text-sm font-bold" style={{ posType: ENUMS.PosType.Absolute, insetL: 36, insetT: 12, textColor: INK }}>
            Claude is offline
          </Text>
          <Text class="text-xs" style={{ posType: ENUMS.PosType.Absolute, insetL: 14, insetT: 40, width: CARD.w - 28, textColor: MUTED }}>
            Open Pocket Companion on your Mac.
          </Text>
          <Text class="text-xs" style={{ posType: ENUMS.PosType.Absolute, insetL: 14, insetT: 72, textColor: MUTED }}>
            B to close
          </Text>
        </FocusScope>
      </Show>

      <Show when={phase() === "choose"}>
        <FocusScope
          style={{ ...absolute(CHOOSER.x, CHOOSER.y, CHOOSER.w, CHOOSER.h), bgColor: PAPER, radius: 10, borderColor: EDGE, borderWidth: 1 }}
        >
          <Spark x={12} y={9} size={14} />
          <Label text="Claude" x={34} y={7} />
          <Label text={reply() ? oneLine(reply(), CHOOSER.w - 28) : AGENT_LABELS.choose} color={MUTED} x={14} y={28} w={CHOOSER.w - 28} />
          <Tile rect={TALK_TILE} button="A" text={AGENT_LABELS.talk} target="talk" />
          <Tile rect={TYPE_TILE} button="X" text={AGENT_LABELS.type} target="type" />
          <Label text={AGENT_LABELS.chooseHints} color={MUTED} x={14} y={CHOOSER.h - 22} />
        </FocusScope>
      </Show>

      <Show when={phase() === "compose"}>
        <FocusScope
          style={{ ...absolute(CARD.x, 6, CARD.w, keyboardTop - 10), bgColor: PAPER, radius: 10, borderColor: EDGE, borderWidth: 1 }}
        >
          <Spark x={12} y={9} size={14} />
          <Label text="Claude" x={34} y={7} />
          <Show when={fontReady() && keyboardTop - 10 > 96}>
            <AgentText
              text={reply() ? wrapText(reply(), CARD.w - 28 - HANG, advance, 2).join("\n") : AGENT_LABELS.composeHints}
              color={MUTED}
              x={14}
              y={30}
            />
          </Show>
          <View
            style={{
              ...absolute(10, keyboardTop - 10 - 34, CARD.w - 84, 26),
              bgColor: "#ffffff",
              radius: 6,
              borderColor: EDGE,
              borderWidth: 1,
            }}
          >
            <AgentText
              text={draft() ? osk.display("|") : AGENT_LABELS.placeholder}
              color={draft() ? INK : MUTED}
              x={8}
              y={4}
            />
          </View>
          <View style={{ ...absolute(CARD.w - 68, keyboardTop - 10 - 34, 58, 26), bgColor: ORANGE, radius: 13 }}>
            <AgentText text={AGENT_LABELS.send} color="#ffffff" x={0} y={4} w={58} align="center" />
          </View>
        </FocusScope>
        <View style={absolute(0, keyboardTop, W, H - keyboardTop)}>
          <Osk osk={osk} surface="auxiliary" theme="light" />
        </View>
      </Show>

      <Show when={phase() === "listening"}>
        <FocusScope style={{ ...absolute(CARD.x, CARD.y, CARD.w, CARD.h), bgColor: PAPER, radius: 10, borderColor: EDGE, borderWidth: 1 }}>
          <Spark x={12} y={9} size={14} />
          <Label text="Claude" x={34} y={7} />
          <View
            ref={(node: NodeMirror) => (level = node)}
            style={{ ...absolute(CARD.w / 2 - 26, 44, 52, 52), radius: 26, bgColor: ORANGE }}
          />
          <View style={{ ...absolute(CARD.w / 2 - 5, 58, 10, 18), radius: 5, bgColor: "#ffffff" }} />
          <View style={{ ...absolute(CARD.w / 2 - 1, 78, 2, 6), bgColor: "#ffffff" }} />
          <AgentText
            text={transcriptLines().length > 0 ? transcriptLines().join("\n") : AGENT_LABELS.listening}
            color={transcriptLines().length > 0 ? INK : MUTED}
            x={14}
            y={108}
            w={CARD.w - 28}
          />
          <View style={{ ...absolute(10, CARD.h - 30, CARD.w - 20, 1), bgColor: EDGE }} />
          <Label text={AGENT_LABELS.talkHints} color={MUTED} x={14} y={CARD.h - 24} />
          <Pill rect={SEND_PILL} button="A" text={AGENT_LABELS.send} target="send" primary />
        </FocusScope>
      </Show>

      <Show when={!tucked() && ((phase() === "working" && !acting()) || phase() === "reply")}>
        <FocusScope
          style={{ ...absolute(CARD.x, CARD.y, CARD.w, CARD.h), bgColor: PAPER, radius: 10, borderColor: EDGE, borderWidth: 1 }}
        >
          <Spark x={12} y={9} size={14} />
          <Label text="Claude" x={34} y={7} />
          <Show when={usage()}>
            <AgentText text={formatTokens(usage())} color={MUTED} x={CARD.w - 112} y={7} w={100} align="right" />
          </Show>
          <Show when={requestLines().length > 0}>
            <View
              style={{
                ...absolute(CARD.w - 12 - requestWidth() - 16, bubbleTop - CARD.y, requestWidth() + 16, bubbleHeight()),
                bgColor: BUBBLE,
                radius: 9,
              }}
            >
              <AgentText text={requestLines().join("\n")} x={8} y={5} />
            </View>
          </Show>
          <Show when={phase() === "working"}>
            <View style={{ ...absolute(14, statusTop() - CARD.y + 6, 6, 6), radius: 3, bgColor: ORANGE }} />
            <AgentText text={oneLine(status(), CARD.w - 40)} color={MUTED} x={26} y={statusTop() - CARD.y} w={CARD.w - 40} />
          </Show>
          <View style={{ ...absolute(14, replyTop() - CARD.y, BODY_W, replyHeight()), overflow: ENUMS.Overflow.Hidden }}>
            <View ref={(node: NodeMirror) => (replyArea = node)} style={absolute(0, 0, BODY_W, Math.max(LINE, replyLines().length * LINE))}>
              <AgentText text={replyLines().join("\n")} x={0} y={0} />
            </View>
          </View>
          <View style={{ ...absolute(10, CARD.h - 30, CARD.w - 20, 1), bgColor: EDGE }} />
          <Show
            when={phase() === "reply"}
            fallback={<Label text={footer()} color={ORANGE} x={14} y={CARD.h - 24} />}
          >
            <Pill rect={TALK_PILL} button="A" text={AGENT_LABELS.talk} target="talk" />
            <Pill rect={TYPE_PILL} button="X" text={AGENT_LABELS.type} target="type" />
            <Label text={AGENT_LABELS.replyHints} color={MUTED} x={CARD.w - 112} y={CARD.h - 24} w={100} align="right" />
          </Show>
        </FocusScope>
      </Show>

      <Show when={(phase() === "working" && acting()) || (tucked() && (phase() === "working" || phase() === "reply"))}>
        <View
          ref={(node: NodeMirror) => {
            banner = node;
            jump(node, "translateY", 40);
            animate(node, "translateY", 0, { dur: 200, easing: "out" });
          }}
          style={{ ...absolute(BANNER.x, BANNER.y, BANNER.w, BANNER.h), bgColor: `${NIGHT}ee`, radius: 14 }}
        >
          <Spark x={10} y={7} size={14} />
          <AgentText
            text={phase() === "reply" ? AGENT_LABELS.replied : oneLine(status(), BANNER.w - 120)}
            color={PAPER}
            x={32}
            y={5}
            w={BANNER.w - 120}
          />
          <AgentText
            text={acting() ? AGENT_LABELS.stop : AGENT_LABELS.expand}
            color={ORANGE}
            x={BANNER.w - 82}
            y={5}
            w={72}
            align="right"
          />
        </View>
      </Show>
    </>
  );
}

const IDLE_FRAME: PlayedFrame = { buttons: 0, touch: null };
