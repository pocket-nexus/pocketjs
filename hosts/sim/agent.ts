// hosts/sim/agent.ts — a fake `globalThis.agent` (contracts/spec/agent.ts)
// for the 3DS console sim: the companion's messages are what a test pushes,
// the guest's are recorded, the stage keeps its last mode and screen, and the
// microphone and the shot are counters.
//
//   const agent = createSimAgentHost();
//   agent.chord(400);                      // hold L+R 400 ms
//   agent.push({ t: "agent.delta", id, text: "Hi" });
//   agent.sent                             // every message the guest sent

import type { AgentClientMessage, AgentEvent, AgentStatus } from "../../contracts/spec/agent.ts";

export interface SimAgentHost {
  ns: Record<string, (...args: never[]) => unknown>;
  /** Queue host events or companion messages for the guest's next poll. */
  push(...events: AgentEvent[]): void;
  /** Press the chord now and release it `heldMs` later (two polls apart). */
  chordDown(): void;
  chordUp(heldMs: number): void;
  setAvailable(available: boolean): void;
  /** Messages the guest sent, parsed, in order. */
  sent: AgentClientMessage[];
  /** The stage's mode and screen after every change. */
  stages: [number, number][];
  /** Open microphone stream id, 0 when closed; and how each closed. */
  listening: number;
  listenEnds: { id: number; send: boolean }[];
  shots: number;
  level: number;
}

export function createSimAgentHost(options: { available?: boolean } = {}): SimAgentHost {
  let available = options.available ?? true;
  let queue: AgentEvent[] = [];
  let nextStream = 100;
  const host: SimAgentHost = {
    ns: {},
    push(...events) {
      queue.push(...events);
    },
    chordDown() {
      queue.push({ t: "chord.down" });
    },
    chordUp(heldMs) {
      queue.push({ t: "chord.up", heldMs });
    },
    setAvailable(next) {
      if (next === available) return;
      available = next;
      queue.push({ t: "link", available: next });
    },
    sent: [],
    stages: [],
    listening: 0,
    listenEnds: [],
    shots: 0,
    level: 0,
  };
  host.ns = {
    poll: () => {
      if (queue.length === 0) return undefined;
      const batch = JSON.stringify(queue);
      queue = [];
      return batch;
    },
    send: ((json: string) => {
      if (!available) return false;
      host.sent.push(JSON.parse(json) as AgentClientMessage);
      return true;
    }) as never,
    stage: ((mode: number, screen: number) => {
      const last = host.stages[host.stages.length - 1];
      if (!last || last[0] !== mode || last[1] !== screen) host.stages.push([mode, screen]);
    }) as never,
    listen: ((command: number) => {
      if (command === 1) {
        if (!available || host.listening !== 0) return 0;
        host.listening = nextStream++;
        return host.listening;
      }
      if (host.listening !== 0) host.listenEnds.push({ id: host.listening, send: command === 0 });
      host.listening = 0;
      return 0;
    }) as never,
    level: () => (host.listening !== 0 ? host.level : 0),
    shot: () => {
      if (!available) return 0;
      host.shots += 1;
      return nextStream++;
    },
    status: () => {
      const status: AgentStatus = { available, listening: host.listening !== 0, recordedMs: 0, chord: false };
      return JSON.stringify(status);
    },
  };
  return host;
}
