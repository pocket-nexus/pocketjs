// The worker realm's scheduler. The host calls __pocketWorkerTurn(context,
// facts) once per runner iteration (a turn) and executes the pending Promise
// jobs after it returns. This module turns facts into settled Promises and
// async iterators: application code awaits a completion, a deadline or a
// stream record and resumes in the turn that carries it. No Promise settles
// between turns, because the host executes no JS between turns, so the job
// order is a function of the turn's context and facts alone.
import { FactKind, ResourceStatus, WORKER_LIMITS, type WorkerDeclaration } from "../../contracts/spec/worker.ts";

export interface WallClock {
  readonly utcMicros: number;
  readonly generation: number;
  readonly errorMicros: number;
  readonly source: string;
}
/** The host's latched values for one turn. */
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
/** One observed fact as the host hands it over; its data expires with the turn. */
export interface HostFact {
  readonly kind: number;
  readonly handle: number;
  readonly request: number;
  readonly status: number;
  readonly offset: number;
  readonly data: Uint8Array;
  readonly timer: number;
  readonly channel: number;
  readonly deadline: number;
  readonly missed: number;
}
/** A retained copy of one fact. Resource facts fill handle, status, offset
 *  and data; a completion also fills request. Unused fields are zero. */
export interface FactRecord {
  readonly kind: number;
  readonly handle: number;
  readonly request: number;
  readonly status: number;
  readonly offset: number;
  readonly data: Uint8Array;
}
/** One period of a timer: its planned deadline and the periods that passed
 *  unobserved before it, as the latched turn time measured them. */
export interface TimerTick {
  readonly deadline: number;
  readonly missed: number;
}
/** A request that the host did not accept, or that ended with a status other
 *  than ok. `request` is -1 when nothing was accepted. */
export class ResourceError extends Error {
  constructor(readonly status: number, readonly request: number, message: string) {
    super(message);
    this.name = "ResourceError";
  }
}

type WorkerGlobal = typeof globalThis & {
  __pocketWorker?: WorkerHost;
  __pocketWorkerTurn?: (context: TurnContext, facts: readonly HostFact[]) => void;
};
declare const __POCKET_WORKER_DECLARATION__: WorkerDeclaration | undefined;

/** The host timer the scheduler owns; every deadline in this realm maps onto it. */
const SCHEDULER_TIMER = 1;
/** Unread records an observer holds before the realm faults. The host keeps
 *  at most 8 event slots per core, so a reader this far behind has stopped. */
export const OBSERVER_LIMIT = 64;

interface Alarm {
  at: number;
  readonly period: number;
  readonly deliver: (deadline: number, missed: number) => void;
}

let activeContext: TurnContext | undefined;
let declaration: WorkerDeclaration | undefined =
  typeof __POCKET_WORKER_DECLARATION__ === "undefined" ? undefined : __POCKET_WORKER_DECLARATION__;
const snapshots = new Map<number, Uint8Array>();
const settlers = new Map<number, ((record: FactRecord) => void)[]>();
/** Completions nobody has settled yet, bounded by the host's request slots. */
const unclaimed = new Map<number, FactRecord>();
const resourceObservers = new Map<number, Observer<FactRecord>>();
const channelObservers = new Map<number, Observer<Uint8Array>>();
/** Sorted by `at`; equal deadlines keep registration order. */
const alarms: Alarm[] = [];
/** Deadlines registered before the first turn, relative to its latched time. */
let bootstrapAlarms: { readonly delay: number; readonly alarm: Alarm }[] = [];
let armedAt = 0;

/** Host operations never fall back to a UI timer or the ambient browser APIs. */
export function workerHost(): WorkerHost {
  const host = (globalThis as WorkerGlobal).__pocketWorker;
  if (!host) throw new Error("No worker host in this realm: the worker runtime installs __pocketWorker before evaluating the bundle");
  return host;
}
export function workerContext(): TurnContext | undefined { return activeContext; }
export function workerDeclaration(): WorkerDeclaration | undefined { return declaration; }
/** Monotonic microseconds latched for the current turn; absent during bootstrap. */
export function nowMicros(): number | undefined { return activeContext?.nowMicros; }
/** The host's read-only UTC clock identity latched for the current turn, if it has one. */
export function wallClock(): WallClock | undefined { return activeContext?.wallClock; }

/** An async iterator with one reader. A record pushed while the reader is
 *  between reads is buffered; a record pushed while nothing reads expires
 *  with its turn, like the host view it was copied from. */
class Observer<T> implements AsyncIterable<T>, AsyncIterator<T> {
  private readonly buffer: T[] = [];
  private pull: ((result: IteratorResult<T>) => void) | undefined;
  private reading = false;
  private ended = false;
  constructor(private readonly label: string) {}
  push(value: T): void {
    if (this.ended) return;
    if (this.pull) { const pull = this.pull; this.pull = undefined; pull({ value, done: false }); return; }
    if (!this.reading) return;
    if (this.buffer.length >= OBSERVER_LIMIT) throw new Error(`${this.label} holds ${OBSERVER_LIMIT} unread records; its reader fell behind`);
    this.buffer.push(value);
  }
  end(): void {
    this.ended = true;
    this.buffer.length = 0;
    const pull = this.pull; this.pull = undefined;
    pull?.({ value: undefined, done: true });
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    if (this.reading) throw new Error(`${this.label} already has a reader`);
    this.reading = true;
    return this;
  }
  next(): Promise<IteratorResult<T>> {
    if (this.buffer.length) return Promise.resolve({ value: this.buffer.shift()!, done: false });
    if (this.ended) { this.reading = false; return Promise.resolve({ value: undefined, done: true }); }
    if (this.pull) return Promise.reject(new Error(`${this.label} has a read in progress`));
    return new Promise(resolve => { this.pull = resolve; });
  }
  return(): Promise<IteratorResult<T>> {
    this.reading = false;
    this.buffer.length = 0;
    const pull = this.pull; this.pull = undefined;
    pull?.({ value: undefined, done: true });
    return Promise.resolve({ value: undefined, done: true });
  }
}

/** A periodic deadline. Ticks coalesce: a period that passes while the reader
 *  is between reads adds to the next tick's `missed` instead of queueing. */
export class Timer implements AsyncIterable<TimerTick>, AsyncIterator<TimerTick> {
  private slot: TimerTick | undefined;
  private pull: ((result: IteratorResult<TimerTick>) => void) | undefined;
  private closed = false;
  private readonly alarm: Alarm;
  constructor(periodMicros: number, firstMicros: number) {
    this.alarm = { at: 0, period: periodMicros, deliver: (deadline, missed) => this.deliver(deadline, missed) };
    schedule(firstMicros, this.alarm);
  }
  private deliver(deadline: number, missed: number): void {
    if (this.closed) return;
    const tick = this.slot ? { deadline, missed: missed + this.slot.missed + 1 } : { deadline, missed };
    if (this.pull) { const pull = this.pull; this.pull = undefined; this.slot = undefined; pull({ value: tick, done: false }); }
    else this.slot = tick;
  }
  /** Cancels the deadline; a pending read ends. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    cancel(this.alarm);
    const pull = this.pull; this.pull = undefined; this.slot = undefined;
    pull?.({ value: undefined, done: true });
  }
  [Symbol.asyncIterator](): AsyncIterator<TimerTick> { return this; }
  next(): Promise<IteratorResult<TimerTick>> {
    if (this.slot) { const tick = this.slot; this.slot = undefined; return Promise.resolve({ value: tick, done: false }); }
    if (this.closed) return Promise.resolve({ value: undefined, done: true });
    if (this.pull) return Promise.reject(new Error("Timer has a read in progress"));
    return new Promise(resolve => { this.pull = resolve; });
  }
  return(): Promise<IteratorResult<TimerTick>> { this.close(); return Promise.resolve({ value: undefined, done: true }); }
}

function insert(alarm: Alarm): void {
  let index = alarms.length;
  while (index > 0 && alarms[index - 1]!.at > alarm.at) --index;
  alarms.splice(index, 0, alarm);
}
/** Points the host timer at the earliest deadline, or cancels it. */
function arm(): void {
  const at = alarms.length ? Math.max(1, alarms[0]!.at) : 0;
  if (at === armedAt) return;
  armedAt = at;
  workerHost().timer(SCHEDULER_TIMER, at, 0);
}
function schedule(delay: number, alarm: Alarm): void {
  if (!Number.isInteger(delay) || delay < 0 || delay > Number.MAX_SAFE_INTEGER) throw new RangeError("Deadline must be a non-negative integer of microseconds");
  if (!activeContext) { bootstrapAlarms.push({ delay, alarm }); return; }
  alarm.at = activeContext.nowMicros + delay;
  insert(alarm);
  arm();
}
function cancel(alarm: Alarm): void {
  bootstrapAlarms = bootstrapAlarms.filter(item => item.alarm !== alarm);
  const index = alarms.indexOf(alarm);
  if (index < 0) return;
  alarms.splice(index, 1);
  if (activeContext) arm();
}
/** Every deadline at or before the latched time fires, in deadline order. */
function fire(now: number): void {
  while (alarms.length && alarms[0]!.at <= now) {
    const alarm = alarms.shift()!;
    const deadline = alarm.at;
    const missed = alarm.period ? Math.floor((now - deadline) / alarm.period) : 0;
    if (alarm.period) { alarm.at = deadline + (missed + 1) * alarm.period; insert(alarm); }
    alarm.deliver(deadline, missed);
  }
  arm();
}

/** Resolves in the turn whose latched time reaches now + micros. During
 *  bootstrap, now is the first turn's latched time. */
export function sleep(micros: number): Promise<void> {
  return new Promise(resolve => { schedule(micros, { at: 0, period: 0, deliver: () => resolve() }); });
}
/** A periodic timer; the first tick is due after `firstMicros` (default: one period). */
export function createTimer(periodMicros: number, firstMicros = periodMicros): Timer {
  if (!Number.isInteger(periodMicros) || periodMicros < 1 || periodMicros > Number.MAX_SAFE_INTEGER) throw new RangeError("Timer period must be a positive integer of microseconds");
  return new Timer(periodMicros, firstMicros);
}
/** Resolves with the request's completion in the turn that carries it, or at
 *  once when the completion arrived before this call. A completion settles
 *  whatever its status; `cancel` produces a cancelled or unknown status. */
export function settle(request: number): Promise<FactRecord> {
  if (!Number.isInteger(request) || request <= 0) return Promise.reject(new ResourceError(ResourceStatus.invalid, -1, "No request was accepted"));
  const record = unclaimed.get(request);
  if (record) { unclaimed.delete(request); return Promise.resolve(record); }
  return new Promise(resolve => { settlers.set(request, [...(settlers.get(request) ?? []), resolve]); });
}
export function observeResource(handle: number, label: string): AsyncIterable<FactRecord> {
  let observer = resourceObservers.get(handle);
  if (!observer) { observer = new Observer<FactRecord>(label); resourceObservers.set(handle, observer); }
  return observer;
}
export function releaseResource(handle: number): void {
  resourceObservers.get(handle)?.end();
  resourceObservers.delete(handle);
}
export function observeChannel(id: number, label: string): AsyncIterable<Uint8Array> {
  let observer = channelObservers.get(id);
  if (!observer) { observer = new Observer<Uint8Array>(label); channelObservers.set(id, observer); }
  return observer;
}
export function snapshotOf(id: number): Uint8Array | undefined { return snapshots.get(id); }

function retain(fact: HostFact): FactRecord {
  return Object.freeze({ kind: fact.kind, handle: fact.handle, request: fact.request, status: fact.status, offset: fact.offset, data: fact.data.slice() });
}
function deliver(fact: HostFact): void {
  if (fact.kind === FactKind.complete) {
    const record = retain(fact);
    const waiting = settlers.get(fact.request);
    if (waiting) { settlers.delete(fact.request); for (const resolve of waiting) resolve(record); return; }
    if (unclaimed.size >= WORKER_LIMITS.requests) unclaimed.delete(unclaimed.keys().next().value!);
    unclaimed.set(fact.request, record);
  } else if (fact.kind === FactKind.timer) {
    // The scheduler owns the host timer; due deadlines fire by the latched time.
    // The fact consumed the host's one-shot timer, so the next arm() programs
    // it again even for the same deadline: the host checks deadlines against
    // a clock read after the turn latched its time, and an alarm due between
    // the two stays queued here.
    if (fact.timer === SCHEDULER_TIMER) armedAt = 0;
  } else if (fact.kind === FactKind.channel) {
    const bytes = fact.data.slice();
    if (declaration?.channels?.[fact.channel - 1]?.kind === "snapshot") snapshots.set(fact.channel, bytes);
    channelObservers.get(fact.channel)?.push(bytes);
  } else {
    resourceObservers.get(fact.handle)?.push(retain(fact));
  }
}
function turn(context: TurnContext, facts: readonly HostFact[]): void {
  if (activeContext && activeContext.generation !== context.generation) snapshots.clear();
  activeContext = Object.freeze({ ...context, ...(context.wallClock ? { wallClock: Object.freeze({ ...context.wallClock }) } : {}) });
  if (bootstrapAlarms.length) {
    for (const { delay, alarm } of bootstrapAlarms) { alarm.at = context.nowMicros + delay; insert(alarm); }
    bootstrapAlarms = [];
  }
  for (const fact of facts) deliver(fact);
  fire(context.nowMicros);
}

/** Installs the scheduler for this realm: declares the channels to the host
 *  and installs the turn entry. The compiled bundle runs this before the
 *  application entry; a test harness calls it after installing a host. */
export function bindWorker(config?: WorkerDeclaration): void {
  const host = workerHost();
  declaration = config;
  activeContext = undefined;
  snapshots.clear(); settlers.clear(); unclaimed.clear();
  for (const observer of resourceObservers.values()) observer.end();
  for (const observer of channelObservers.values()) observer.end();
  resourceObservers.clear(); channelObservers.clear();
  alarms.length = 0; bootstrapAlarms = []; armedAt = 0;
  for (const [index, channel] of (config?.channels ?? []).entries()) {
    const status = host.declareChannel(index + 1, channel.kind === "snapshot" ? 1 : 0,
      channel.recordBytes, channel.capacity, channel.direction === "ui-to-worker" ? 1 : 0);
    if (status !== ResourceStatus.ok) throw new Error(`Cannot declare worker channel ${channel.name}: ${status}`);
  }
  (globalThis as WorkerGlobal).__pocketWorkerTurn = turn;
}

if (declaration && (globalThis as WorkerGlobal).__pocketWorker) bindWorker(declaration);
