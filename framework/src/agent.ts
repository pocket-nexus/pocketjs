// @pocketjs/framework/agent — the guest side of the system agent
// (`globalThis.agent`, contracts/spec/agent.ts). Framework neutral: the host
// namespace, the messages to and from the companion, the input the agent
// plays into an app, and the screen report it reads back.
//
// Apps do not use this module: an app that declares "system.agent" gets the
// agent's overlay (agent-layer.tsx) from the build, and the overlay uses it.

import {
  AGENT_BUTTONS,
  AGENT_MODE,
  AGENT_SCREEN,
  type AgentButton,
  type AgentClientMessage,
  type AgentEvent,
  type AgentMode,
  type AgentScreen,
  type AgentStatus,
  type AgentText,
} from "../../contracts/spec/agent.ts";
import { BTN } from "../../contracts/spec/spec.ts";
import { __packTouch } from "./touch.ts";

export { AGENT_MODE, AGENT_SCREEN };
export type { AgentEvent, AgentStatus, AgentText };

export interface AgentHostOps {
  poll(): string | undefined;
  send(json: string): boolean;
  stage(mode: number, screen: number): void;
  listen(command: number): number;
  level(): number;
  shot(): number;
  status(): string;
}

export function agentHost(): AgentHostOps | null {
  const ns = (globalThis as { agent?: unknown }).agent;
  if (!ns || typeof ns !== "object") return null;
  const ops = ns as Partial<AgentHostOps>;
  return typeof ops.poll === "function" && typeof ops.send === "function" && typeof ops.stage === "function" &&
      typeof ops.listen === "function" && typeof ops.level === "function" && typeof ops.shot === "function" &&
      typeof ops.status === "function"
    ? (ops as AgentHostOps)
    : null;
}

const OFFLINE: AgentStatus = { available: false, listening: false, recordedMs: 0, chord: false };

export function agentStatus(host: AgentHostOps | null = agentHost()): AgentStatus {
  if (!host) return OFFLINE;
  try {
    return { ...OFFLINE, ...(JSON.parse(host.status()) as Partial<AgentStatus>) };
  } catch {
    return OFFLINE;
  }
}

export function sendAgent(host: AgentHostOps, message: AgentClientMessage): boolean {
  return host.send(JSON.stringify(message));
}

/** Every event the host holds this tick, in order. */
export function takeAgentEvents(host: AgentHostOps): AgentEvent[] {
  const batch = host.poll();
  if (!batch) return [];
  try {
    const parsed = JSON.parse(batch) as AgentEvent[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function setStage(host: AgentHostOps, mode: AgentMode, screen: AgentScreen): void {
  host.stage(mode, screen);
}

// ---------------------------------------------------------------------------
// Input the agent plays into an app
// ---------------------------------------------------------------------------

/** One frame of played input: held buttons and at most one touch-screen
 *  contact. */
export interface PlayedFrame {
  buttons: number;
  touch: { x: number; y: number } | null;
}

export const BUTTON_BITS: Readonly<Record<AgentButton, number>> = {
  A: BTN.CIRCLE,
  B: BTN.CROSS,
  X: BTN.TRIANGLE,
  Y: BTN.SQUARE,
  L: BTN.LTRIGGER,
  R: BTN.RTRIGGER,
  UP: BTN.UP,
  DOWN: BTN.DOWN,
  LEFT: BTN.LEFT,
  RIGHT: BTN.RIGHT,
  START: BTN.START,
  SELECT: BTN.SELECT,
};

export function isAgentButton(name: unknown): name is AgentButton {
  return typeof name === "string" && (AGENT_BUTTONS as readonly string[]).includes(name);
}

const SCREEN_W = 320;
const SCREEN_H = 240;
const clampX = (x: number) => Math.max(0, Math.min(SCREEN_W - 1, Math.round(x)));
const clampY = (y: number) => Math.max(0, Math.min(SCREEN_H - 1, Math.round(y)));

/** A tap: the stylus down for four frames, then up. */
export function tapFrames(x: number, y: number): PlayedFrame[] {
  const touch = { x: clampX(x), y: clampY(y) };
  return [
    { buttons: 0, touch },
    { buttons: 0, touch },
    { buttons: 0, touch },
    { buttons: 0, touch },
    { buttons: 0, touch: null },
  ];
}

/** A drag in `steps` frames, held still for two frames at each end so a
 *  scroller reads it as a drag and not a fling. */
export function dragFrames(x0: number, y0: number, x1: number, y1: number, steps = 16): PlayedFrame[] {
  const frames: PlayedFrame[] = [];
  const at = (t: number) => ({ x: clampX(x0 + (x1 - x0) * t), y: clampY(y0 + (y1 - y0) * t) });
  frames.push({ buttons: 0, touch: at(0) }, { buttons: 0, touch: at(0) });
  for (let step = 1; step <= steps; step += 1) frames.push({ buttons: 0, touch: at(step / steps) });
  frames.push({ buttons: 0, touch: at(1) }, { buttons: 0, touch: at(1) }, { buttons: 0, touch: null });
  return frames;
}

/** `times` presses: down one frame, up two, so every press is an edge. */
export function pressFrames(bits: number, times = 1): PlayedFrame[] {
  const frames: PlayedFrame[] = [];
  for (let press = 0; press < times; press += 1) {
    frames.push({ buttons: bits, touch: null }, { buttons: 0, touch: null }, { buttons: 0, touch: null });
  }
  return frames;
}

export function idleFrames(count: number): PlayedFrame[] {
  return Array.from({ length: count }, () => ({ buttons: 0, touch: null }));
}

/** The contact id played touches use. */
const PLAYED_TOUCH_ID = 9;
const AUXILIARY = [1] as const;

/** The packed contact words and surfaces of a played frame. */
export function playedTouches(frame: PlayedFrame): { touches: readonly number[]; surfaces: readonly number[] } | null {
  if (!frame.touch) return null;
  return { touches: [__packTouch(PLAYED_TOUCH_ID, frame.touch.x, frame.touch.y)], surfaces: AUXILIARY };
}

// ---------------------------------------------------------------------------
// The screen as text
// ---------------------------------------------------------------------------

/** Parse ui.capturedTexts(): "x,y,w,h<TAB>text" per line. Runs the same box
 *  holds twice (an embossed label) are listed once. */
export function parseCapturedTexts(raw: string): AgentText[] {
  const texts: AgentText[] = [];
  for (const line of raw.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const [x, y, w, h] = line.slice(0, tab).split(",").map(Number);
    const text = line.slice(tab + 1).trim();
    if (!text || ![x, y, w, h].every(Number.isFinite)) continue;
    const previous = texts[texts.length - 1];
    if (previous && previous.text === text && Math.abs(previous.x - x!) <= 2 && Math.abs(previous.y - y!) <= 2) continue;
    texts.push({ text, x: x!, y: y!, w: w!, h: h! });
  }
  return texts;
}
