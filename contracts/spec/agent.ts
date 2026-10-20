// Pocket Agent spec — the system mascot on the top screen and the agent that
// perceives and operates Pocket apps through the companion
// (`globalThis.agent`, capability "system.agent").
//
// A guest that declares the capability gives the top screen to the system.
// The host draws a 3D room there: the mascot, its desk and its monitor, in
// stereo when the 3D slider is up. The guest's primary surface is not shown;
// the app's whole interface lives on the touch screen (the auxiliary surface).
// The mascot's monitor shows one of three sources:
//
//   mirror   the touch screen, copied into a texture every frame
//   own      frames the companion streams from the agent's own screen, a
//            headless copy of a Pocket app on the computer
//   idle     the screensaver: the PocketJS mark, drawn by the host
//
// Summoning. Pressing L and R together (each within AGENT_CHORD_FRAMES of the
// other) is the system chord. The host holds back a shoulder's down edge for
// that window, so a guest sees neither half of the chord; a lone L or R
// reaches the guest AGENT_CHORD_FRAMES late. The chord's down and up edges
// arrive as host events. Holding the chord is push-to-talk; a short press
// opens the keyboard.
//
// The agent runs on the companion (contracts/spec/link.ts): the companion
// owns the model session, spends the tokens and asks the console to act. The
// console streams the microphone to it and answers tool calls on the touch
// screen. Messages are link ctrl frames whose `t` starts with "agent.".
//
// Guest namespace:
//
//   poll() -> string | undefined
//                             JSON array of AgentEvent visible this tick
//   send(json) -> bool        one ctrl message to the companion. `t` must
//                             start with "agent."; false when the link is not
//                             up or the message is longer than LINK_MAX_CTRL
//   stage(mode, screen)       the mascot's AGENT_MODE and its monitor's
//                             AGENT_SCREEN
//   listen(on) -> id | 0      start the microphone and stream it on a new
//                             stream (returns its id), or stop it (returns 0)
//   level() -> 0..100         microphone loudness, 0 while not listening
//   shot() -> id | 0          capture the touch screen once and stream it on
//                             a new stream (returns its id)
//   status() -> string        JSON AgentStatus
//
// The microphone stream opens with
//   {"t":"agent.audio","id":n,"rate":AGENT_MIC_RATE,"format":"s16le"}
// then PCM data frames on stream n, and ends with
//   {"t":"agent.audio.end","id":n}
// A shot opens with
//   {"t":"agent.shot","id":n,"width":320,"height":240,"format":"rgb565","bytes":153600}
// then the pixels, row-major from the top-left, little-endian RGB565, as data
// frames on stream n.

import type { LinkCatalogApp } from "./link.ts";

/** Frames a shoulder's down edge waits for the other shoulder. */
export const AGENT_CHORD_FRAMES = 6;
/** The 3DS microphone's sample rate (MICU_SAMPLE_RATE_16360). */
export const AGENT_MIC_RATE = 16_360;
/** The longest recording the console streams; the host stops at this. */
export const AGENT_MIC_MAX_MS = 30_000;
/** The touch screen shot. */
export const AGENT_SHOT_WIDTH = 320;
export const AGENT_SHOT_HEIGHT = 240;
export const AGENT_SHOT_BYTES = AGENT_SHOT_WIDTH * AGENT_SHOT_HEIGHT * 2;
/** Stream ids the companion opens toward the console have this bit set, so
 *  they never collide with the console's request ids. */
export const AGENT_COMPANION_STREAM = 0x8000_0000;

/** What the mascot is doing. */
export const AGENT_MODE = {
  /** Wanders, looks around, falls asleep after a while. */
  idle: 0,
  /** Summoned: faces the user. */
  attend: 1,
  /** Push-to-talk: leans in, moves with the microphone's level. */
  listen: 2,
  /** Turned to its monitor, typing. */
  think: 3,
  /** Operating an app: watches its monitor, typing faster. */
  act: 4,
  /** Faces the user while the reply arrives. */
  speak: 5,
  /** A hop, then back to idle. */
  happy: 6,
} as const;
export type AgentMode = (typeof AGENT_MODE)[keyof typeof AGENT_MODE];

/** What the mascot's monitor shows. */
export const AGENT_SCREEN = {
  idle: 0,
  mirror: 1,
  own: 2,
} as const;
export type AgentScreen = (typeof AGENT_SCREEN)[keyof typeof AGENT_SCREEN];

export interface AgentStatus {
  /** The link is up and the companion offered the "agent" feature. */
  available: boolean;
  listening: boolean;
  /** Milliseconds recorded on the open microphone stream. */
  recordedMs: number;
  /** The chord is held now. */
  chord: boolean;
  /** The loudest sample since listening began (0..32767), and the
   *  microphone's gain: what a quiet recording is checked against. */
  peak?: number;
  gain?: number;
}

/** Host events from poll(). */
export type AgentEvent =
  | { t: "chord.down" }
  | { t: "chord.up"; heldMs: number }
  /** The microphone stopped by itself (AGENT_MIC_MAX_MS or a fault). */
  | { t: "mic.stop"; id: number; reason: string }
  /** A new atlas for AGENT_FONT_SLOT is loaded: measured widths are stale. */
  | { t: "glyphs" }
  | { t: "link"; available: boolean }
  | AgentServerMessage;

// ---------------------------------------------------------------------------
// Messages (link ctrl frames)
// ---------------------------------------------------------------------------

/** The app a guest is, as the agent sees it. */
export interface AgentApp {
  id: string;
  title: string;
  /** Build output name: what `launch` takes. */
  output: string;
}

/** Console -> companion. */
export type AgentClientMessage =
  /** Sent by every guest once it boots, and again after the link comes up. */
  | { t: "agent.hello"; app: AgentApp; apps: AgentApp[]; locale: string }
  /** A typed request. `id` names the turn in every reply. */
  | { t: "agent.turn"; id: number; text: string }
  /** The microphone's stream (see above). The companion transcribes it; with
   *  `send` the final transcript becomes turn `id`. */
  | { t: "agent.audio"; id: number; rate: number; format: "s16le" }
  | { t: "agent.audio.end"; id: number; send?: boolean }
  /** Stop the turn: the model is interrupted and no further tool runs. */
  | { t: "agent.cancel"; id: number }
  /** Forget the conversation. */
  | { t: "agent.reset" }
  /** A tool call's answer. `shot` names the shot stream sent with it. */
  | { t: "agent.result"; call: string; ok: boolean; text: string; shot?: number };

/** Companion -> console. */
export type AgentServerMessage =
  /** Answer to hello, and on every change: what the agent is doing, and the
   *  request of the turn in progress. A guest that boots mid-turn (after
   *  `launch`) resumes from this. */
  | { t: "agent.state"; phase: AgentPhase; turn: number; screen: "user" | "own"; app: string; request?: string }
  | { t: "agent.transcript"; id: number; text: string; final: boolean }
  /** The user's request as the turn began (the typed text or the transcript). */
  | { t: "agent.request"; id: number; text: string }
  /** Reply text, appended in order. */
  | { t: "agent.delta"; id: number; text: string }
  /** A short line about the step in progress ("Opening Hacker News"). */
  | { t: "agent.step"; id: number; text: string }
  /** Run a tool on the touch screen; answer with agent.result. */
  | { t: "agent.tool"; id: number; call: string; name: AgentToolName; args: Record<string, unknown> }
  | { t: "agent.usage"; id: number; usage: AgentUsage }
  | { t: "agent.done"; id: number; text: string; usage: AgentUsage }
  | { t: "agent.error"; id: number; message: string }
  /** A frame of the agent's own screen follows on stream `stream`. The host
   *  shows it on the mascot's monitor and does not pass the pixels on. */
  | { t: "agent.screen"; stream: number; width: number; height: number; format: "rgb565"; bytes: number }
  /** A FONT ATLAS (contracts/spec/spec.ts, version 3) for AGENT_FONT_SLOT
   *  follows on stream `stream`; the host loads it in place of the slot's
   *  previous atlas and does not pass the bytes on (see "Glyphs" below). */
  | { t: "agent.glyphs"; stream: number; slot: number; bytes: number };

export type AgentPhase = "idle" | "listening" | "thinking" | "acting" | "replying";

// ---------------------------------------------------------------------------
// Glyphs
// ---------------------------------------------------------------------------
//
// A console bakes only the glyphs its bundle's source names, so the agent's
// words (a reply in Chinese, a name with an accent) may have no glyphs on it. The companion rasterizes them:
// it keeps one atlas per console holding printable ASCII, common CJK
// punctuation and every codepoint of the texts it has sent this conversation
// (requests, transcripts, deltas, steps, errors), and sends the whole atlas
// again, as agent.glyphs, BEFORE the first message whose text needs a glyph
// the console does not have. The link keeps order and the host loads the
// atlas when its stream completes, so a message never reaches the guest ahead
// of its glyphs. A guest switch drops the slot: the companion sends the atlas
// again after every agent.hello. Past AGENT_FONT_MAX_GLYPHS it starts over
// with the glyphs the current turn needs.
//
// The guest draws every agent text with `fontSlot: AGENT_FONT_SLOT` and
// `lineHeight: AGENT_FONT.lineHeight`.

export const AGENT_FONT_SLOT = 23;
/** The atlas's cell, in logical px (density 1). */
export const AGENT_FONT = { size: 13, cellW: 15, cellH: 18, baseline: 14, lineHeight: 18 } as const;
export const AGENT_FONT_MAX_GLYPHS = 1200;

/** The overlay's own words. Every atlas the companion sends holds their
 *  glyphs (AGENT_LABEL_GLYPHS), so the overlay can draw them from the same
 *  slot as the conversation. Without a companion there is no atlas, and the
 *  overlay says so in ASCII from the bundle's baked glyphs. */
export const AGENT_LABELS = {
  choose: "How do you want to ask?",
  talk: "Talk",
  type: "Type",
  chooseHints: "B Close",
  placeholder: "What should I do?",
  listening: "Listening…",
  talkHints: "B Cancel",
  thinking: "Thinking…",
  acting: "Using your screen",
  ownScreen: "Using my own screen",
  stop: "B Stop",
  replyHints: "B Close",
  composeHints: "START Send · B Close",
  send: "Send",
  lost: "Lost the link to the Mac",
  stopped: "Stopped",
  ownHints: "B Hide · Y Stop",
  expand: "L+R Open",
  replied: "Reply ready",
} as const;
export const AGENT_LABEL_GLYPHS = [...new Set(Object.values(AGENT_LABELS).join(""))].join("");

export interface AgentUsage {
  /** Tokens this turn. */
  input: number;
  cachedInput: number;
  output: number;
  /** Tokens since the conversation began. */
  total: number;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------
//
// The model operates Pocket apps the way a person does: it reads the screen
// and taps, drags, presses buttons and types. Every tool takes `screen`:
// "user" (default) is the touch screen of the console in the user's hands,
// "own" a headless copy of a Pocket app on the companion that only the agent
// uses, shown on the mascot's monitor. Coordinates are the 320x240 touch
// screen's logical pixels.
//
// After an action the console lets the app settle (AGENT_SETTLE_FRAMES) and
// answers with the screen's texts; `observe` with `image: true` adds the
// screenshot. The console takes a shot only for that call: a 320x240 image
// costs the model about 12k input tokens, the text list under 1k.

export const AGENT_SETTLE_FRAMES = 20;

export type AgentToolName = "observe" | "tap" | "drag" | "press" | "type" | "launch" | "wait";

export const AGENT_BUTTONS = ["A", "B", "X", "Y", "L", "R", "UP", "DOWN", "LEFT", "RIGHT", "START", "SELECT"] as const;
export type AgentButton = (typeof AGENT_BUTTONS)[number];

/** One text the screen shows, in screen order. */
export interface AgentText {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** What `observe` (and every action) reports, as JSON in the result text. */
export interface AgentScreenReport {
  app: AgentApp;
  /** The on-screen keyboard is open: `type` will reach it. */
  keyboard: boolean;
  texts: AgentText[];
}

export interface AgentToolSpec {
  name: AgentToolName;
  description: string;
  inputSchema: Record<string, unknown>;
}

const SCREEN_ARG = {
  type: "string",
  enum: ["user", "own"],
  description: "\"user\": the console in the user's hands (default). \"own\": your own screen on the computer, which the user sees on your monitor.",
} as const;

export const AGENT_TOOLS: readonly AgentToolSpec[] = [
  {
    name: "observe",
    description: "Look at a Pocket app's touch screen (320x240): returns every visible text with its box, and a screenshot when `image` is true.",
    inputSchema: {
      type: "object",
      properties: {
        image: {
          type: "boolean",
          description: "Also return a screenshot. It costs about 12k tokens, the texts under 1k: ask for it only when the texts do not tell you enough (icons, pictures, layout).",
        },
        screen: SCREEN_ARG,
      },
      additionalProperties: false,
    },
  },
  {
    name: "tap",
    description: "Tap the touch screen at (x, y) in logical pixels.",
    inputSchema: {
      type: "object",
      properties: { x: { type: "number" }, y: { type: "number" }, screen: SCREEN_ARG },
      required: ["x", "y"],
      additionalProperties: false,
    },
  },
  {
    name: "drag",
    description: "Drag on the touch screen from (x0, y0) to (x1, y1), e.g. to scroll a list. Dragging up scrolls content up.",
    inputSchema: {
      type: "object",
      properties: {
        x0: { type: "number" },
        y0: { type: "number" },
        x1: { type: "number" },
        y1: { type: "number" },
        screen: SCREEN_ARG,
      },
      required: ["x0", "y0", "x1", "y1"],
      additionalProperties: false,
    },
  },
  {
    name: "press",
    description: "Press a console button. A confirms, B goes back, the d-pad moves a selection.",
    inputSchema: {
      type: "object",
      properties: {
        button: { type: "string", enum: [...AGENT_BUTTONS] },
        times: { type: "integer", minimum: 1, maximum: 20 },
        screen: SCREEN_ARG,
      },
      required: ["button"],
      additionalProperties: false,
    },
  },
  {
    name: "type",
    description: "Type text into the open on-screen keyboard. Fails when no keyboard is open.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" }, submit: { type: "boolean" }, screen: SCREEN_ARG },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "launch",
    description: "Open an installed Pocket app by its output name or title. On the user's screen this switches the console to that app.",
    inputSchema: {
      type: "object",
      properties: { app: { type: "string" }, screen: SCREEN_ARG },
      required: ["app"],
      additionalProperties: false,
    },
  },
  {
    name: "wait",
    description: "Wait for loading to finish, up to 5000 ms.",
    inputSchema: {
      type: "object",
      properties: { ms: { type: "integer", minimum: 100, maximum: 5000 }, screen: SCREEN_ARG },
      required: ["ms"],
      additionalProperties: false,
    },
  },
];

/** The companion offers this feature in `ready` when it can run the agent. */
export const AGENT_LINK_FEATURE = "agent";

/** Installed apps the agent may launch, as a catalog row maps to one. */
export function agentAppOf(app: Pick<LinkCatalogApp, "id" | "title" | "output">): AgentApp {
  return { id: app.id, title: app.title, output: app.output };
}
