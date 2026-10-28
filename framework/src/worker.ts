import { FactKind, ResourceStatus, type WorkerDeclaration } from "../../contracts/spec/worker.ts";

import { ByteView } from "./byte-view.ts";
import { assertDomain } from "./domain.ts";

export { FactKind, ResourceStatus, ByteView };
export type { WorkerDeclaration, WorkerChannelDeclaration } from "../../contracts/spec/worker.ts";

assertDomain("worker", "@pocketjs/framework/worker");

export interface WallClock {
  readonly utcMicros: number;
  readonly generation: number;
  readonly errorMicros: number;
  readonly source: string;
}
export interface TurnContext {
  readonly generation: number;
  readonly sequence: number;
  readonly nowMicros: number;
  readonly wallClock?: WallClock;
}
export interface WorkerHost {
  open(kind: number, node: string, config: Uint8Array): number;
  submit(handle: number, opcode: number, payload: Uint8Array, resultCapacity: number): number;
  cancel(request: number): number;
  close(handle: number): number;
  write(handle: number, data: Uint8Array): number;
  publish(channel: number, data: Uint8Array): number;
  timer(id: number, deadlineMicros: number, periodMicros: number): number;
  declareChannel(id: number, snapshot: number, maxBytes: number, capacity: number, direction: number): number;
}
export interface HostFact {
  readonly kind: number;
  readonly handle: number;
  readonly request: number;
  readonly status: number;
  readonly offset: number;
  readonly data: Uint8Array;
}
type WorkerGlobal = typeof globalThis & {
  __pocketWorker?: WorkerHost;
  __pocketWorkerTurn?: (context: TurnContext, facts: readonly HostFact[]) => void;
};
let epoch = 0;
let activeContext: TurnContext | undefined;
const snapshots = new Map<number, Uint8Array>();
declare const __POCKET_WORKER_DECLARATION__: WorkerDeclaration | undefined;
let declaration: WorkerDeclaration | undefined = typeof __POCKET_WORKER_DECLARATION__ === "undefined" ? undefined : __POCKET_WORKER_DECLARATION__;

/** Host operations never fall back to a UI timer or the ambient browser APIs. */
export function workerHost(): WorkerHost {
  const host = (globalThis as WorkerGlobal).__pocketWorker;
  if (!host) throw new Error("No worker host in this realm: the worker runtime installs __pocketWorker before evaluating the bundle");
  return host;
}

export function workerContext(): TurnContext | undefined { return activeContext; }
export function workerDeclaration(): WorkerDeclaration | undefined { return declaration; }
/** Monotonic microseconds latched for the current turn; absent outside a turn. */
export function nowMicros(): number | undefined { return activeContext?.nowMicros; }
/** The host's read-only UTC clock identity latched for the current turn, if it has one. */
export function wallClock(): WallClock | undefined { return activeContext?.wallClock; }

export class FactView {
  readonly data: ByteView;
  private taken = false;
  constructor(private readonly fact: HostFact, private readonly valid: () => void) {
    this.data = new ByteView(fact.data, valid);
  }
  get kind(): number { this.valid(); return this.fact.kind; }
  get handle(): number { this.valid(); return this.fact.handle; }
  get request(): number { this.valid(); return this.fact.request; }
  get status(): number { this.valid(); return this.fact.status; }
  get offset(): number { this.valid(); return this.fact.offset; }
  /** A completion can be taken once; copying does not change its terminal status. */
  take(): Uint8Array | undefined {
    this.valid();
    if (this.taken) return undefined;
    this.taken = true;
    return this.data.copy();
  }
}

export class Inbox {
  private readonly facts: readonly FactView[];
  private readonly valid: () => void;
  constructor(facts: readonly HostFact[], generation = epoch) {
    this.valid = () => { if (generation !== epoch) throw new Error("Worker view expired; copy bytes before the next turn"); };
    this.facts = facts.map(fact => new FactView(fact, this.valid));
  }
  get length(): number { this.valid(); return this.facts.length; }
  at(index: number): FactView | undefined { this.valid(); return this.facts[index]; }
  events(resource?: number | { readonly handle: number }): readonly FactView[] {
    this.valid();
    const handle = typeof resource === "number" ? resource : resource?.handle;
    return handle === undefined ? this.facts : this.facts.filter(fact =>
      fact.handle === handle && fact.kind !== FactKind.timer && fact.kind !== FactKind.channel);
  }
  completion(request: number): FactView | undefined {
    this.valid();
    if (request < 0) return undefined;
    return this.facts.find(fact => fact.kind === FactKind.complete && fact.request === request);
  }
  timer(id: number): FactView | undefined {
    this.valid();
    return this.facts.find(fact => fact.kind === FactKind.timer && fact.handle === id);
  }
  channel(name: string): readonly FactView[] {
    this.valid();
    const id = declaration?.channels?.findIndex(channel => channel.name === name) ?? -1;
    if (id < 0) throw new Error(`Undeclared worker channel: ${name}`);
    return this.facts.filter(fact => fact.kind === FactKind.channel && fact.handle === id + 1);
  }
  snapshot(name: string): ByteView | undefined {
    this.valid();
    const id = declaration?.channels?.findIndex(channel => channel.name === name) ?? -1;
    const channel = declaration?.channels?.[id];
    if (!channel || channel.kind !== "snapshot" || channel.direction !== "ui-to-worker") throw new Error(`No inbound snapshot channel: ${name}`);
    const bytes = snapshots.get(id + 1);
    return bytes ? new ByteView(bytes, this.valid) : undefined;
  }
}

/** The compiler installs this entry in the worker's own realm. */
export function bindWorker(turn: (context: TurnContext, inbox: Inbox) => void, config?: WorkerDeclaration): void {
  workerHost();
  if (typeof turn !== "function") throw new TypeError("Worker entry must export turn(context, inbox)");
  declaration = config;
  snapshots.clear();
  for (const [index, channel] of (config?.channels ?? []).entries()) {
    const status = workerHost().declareChannel(index + 1, channel.kind === "snapshot" ? 1 : 0,
      channel.recordBytes, channel.capacity, channel.direction === "ui-to-worker" ? 1 : 0);
    if (status !== ResourceStatus.ok) throw new Error(`Cannot declare worker channel ${channel.name}: ${status}`);
  }
  (globalThis as WorkerGlobal).__pocketWorkerTurn = (context, facts) => {
    ++epoch;
    if (activeContext && activeContext.generation !== context.generation) snapshots.clear();
    for (const fact of facts) {
      if (fact.kind === FactKind.channel && declaration?.channels?.[fact.handle - 1]?.kind === "snapshot") snapshots.set(fact.handle, fact.data.slice());
    }
    activeContext = Object.freeze({ ...context, ...(context.wallClock ? { wallClock: Object.freeze({ ...context.wallClock }) } : {}) });
    const result: unknown = turn(activeContext, new Inbox(facts));
    if (result && typeof (result as { then?: unknown }).then === "function") {
      throw new TypeError("Worker turn must finish synchronously; schedule work for a subsequent turn");
    }
  };
}
