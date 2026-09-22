import { copy, type ModelRegion } from "./model-reactive.ts";
import { virtualFrame, virtualNow } from "./clock.ts";

export interface TaskId { region: number; function: number; call: number }
export interface RequestId { task: TaskId; wait: number; member: number }
export type Join<T> = { kind: "done"; value: T } | { kind: "cancelled" };
export type Wait =
  | { kind: "frames"; count: number }
  | { kind: "after"; ms: number }
  | { kind: "until"; predicate: () => boolean }
  | { kind: "join"; task?: TaskHandle; start?: () => TaskHandle; wrapped: boolean }
  | { kind: "service"; service: string; call: string; args: unknown[] }
  | { kind: "animate"; args: unknown[] }
  | { kind: "all" | "any"; members: (Wait | (() => Wait))[] };
type Awaitable<T> = PromiseLike<T> & Wait;
const awaitable = <T>(wait: Wait): Awaitable<T> => wait as Awaitable<T>;
export const frames = (count: number): Awaitable<void> => awaitable({ kind: "frames", count });
export const after = (ms: number): Awaitable<void> => awaitable({ kind: "after", ms });
export const until = (predicate: () => boolean): Awaitable<void> => awaitable({ kind: "until", predicate });
export const join = <T>(task: PromiseLike<T>): PromiseLike<Join<T>> => awaitable({ kind: "join", task: task as unknown as TaskHandle, wrapped: true });
export const all = <T extends readonly unknown[]>(members: { [K in keyof T]: PromiseLike<T[K]> }): PromiseLike<T> => awaitable({ kind: "all", members: members as unknown as Wait[] });
type VoidToUndefined<T> = T extends void ? undefined : T;
export const any = <const T extends readonly PromiseLike<unknown>[]>(members: T): PromiseLike<VoidToUndefined<Awaited<T[number]>>> => awaitable({ kind: "any", members: members as unknown as Wait[] });
export function cancel(_fn: (...args: any[]) => Promise<unknown>): void { throw new Error("cancel requires the compiled model transform"); }
export interface TaskHandle { id: TaskId; status: "live" | "done" | "cancelled"; value?: unknown }
interface RegisteredWait { source: Wait; request?: RequestId; at?: number; members?: RegisteredWait[]; result?: unknown; ready?: boolean; cancelled?: boolean; released?: boolean; delivered?: boolean; reserved?: boolean; hostIssued?: boolean; cancel?: () => void }
export interface TaskStep { next?: number; suspend?: Wait; bind?: number; result?: unknown; done?: boolean }
interface Task extends TaskHandle { state: number; order: number; wait: number; pending?: RegisteredWait; locals: Record<number, unknown>; step: (state: number, locals: Record<number, unknown>) => TaskStep; bind?: number }
interface Service {
  capacity: number;
  available(): boolean;
  validate(value: unknown): boolean;
  request(call: string, args: unknown[], id: RequestId, deliver: (value: unknown) => void): (() => void) | void;
}
const services = new Map<string, Service>();
export function registerModelService(name: string, service: Service): () => void {
  const previous = services.get(name); services.set(name, service);
  return () => { if (services.get(name) !== service) return; if (previous) services.set(name, previous); else services.delete(name); };
}
let deliveries: { request: RequestId; value: unknown }[] = [];
export function deliverModelResult(request: RequestId, value: unknown): void { deliveries.push({ request, value }); }
const key = (r: RequestId) => `${r.task.region}:${r.task.function}:${r.task.call}:${r.wait}:${r.member}`;
const taskRuntimes = new Set<ModelTasks>();
let lastBoundary: { frame: number; now: number } | undefined;
const pendingRequests = new Map<string, { runtime: ModelTasks; wait: RegisteredWait; task: Task }>();
let commands: (() => void)[] = [];
type ModelCommandHandler = (region: ModelRegion, op: string, args: unknown[], request?: RequestId) => void | (() => void);
let commandHandler: ModelCommandHandler | undefined;
export function registerModelCommandHandler(handler: ModelCommandHandler): () => void {
  const previous = commandHandler; commandHandler = handler;
  return () => { if (commandHandler === handler) commandHandler = previous; };
}
/** The input bridge drains host requests after the view update. */
export function drainModelCommands(): void { const queue = commands; commands = []; for (const command of queue) command(); }


export class ModelTasks {
  private tasks = new Map<number, Task>();
  private generations = new Map<number, number>();
  private order = 0;
  frame: number;
  now: number;
  constructor(readonly region: ModelRegion) {
    const boundary = [...taskRuntimes].some(runtime => !runtime.region.disposed) ? lastBoundary : undefined;
    this.frame = boundary?.frame ?? virtualFrame(); this.now = boundary?.now ?? virtualNow() * 1000;
    taskRuntimes.add(this);
  }
  resetClock(): void {
    if ([...this.tasks.values()].some(task => task.status === "live")) return;
    this.frame = 0; this.now = 0;
  }
  command(op: string, args: unknown[]): void {
    if (op === "log" && !this.region.development) return;
    const values = copy(args);
    this.region.emit("command", { op, args: values });
    commands.push(() => { commandHandler?.(this.region, op, copy(values)); });
  }
  start(fn: number, args: unknown[], step: Task["step"], parameters: number[] = []): TaskHandle {
    this.cancel(fn, "restart");
    const call = (this.generations.get(fn) ?? 0) + 1; this.generations.set(fn, call);
    const task: Task = { id: { region: this.region.instance, function: fn, call }, status: "live", state: 0, wait: 0, order: this.order++, locals: Object.fromEntries(parameters.map((id, i) => [id, copy(args[i])])), step };
    this.tasks.set(fn, task); this.region.emit("task-start", { task: task.id, state: 0 });
    this.segment(task);
    return task;
  }
  cancel(fn: number, reason = "cancel"): void {
    const task = this.tasks.get(fn);
    if (!task || task.status !== "live") return;
    task.status = "cancelled"; if (task.pending) this.release(task.pending);
    task.pending = undefined; task.locals = {};
    this.region.emit("task-cancel", { task: task.id, reason });
    for (const runtime of taskRuntimes) for (const parent of runtime.tasks.values()) if (parent.status === "live" && parent.pending && runtime.awaitingCancelled(parent.pending, task)) runtime.cancel(parent.id.function, "awaited task cancelled");
  }
  dispose(): void {
    for (const fn of this.tasks.keys()) this.cancel(fn, "unmount");
    taskRuntimes.delete(this);
  }
  private awaitingCancelled(wait: RegisteredWait, task: Task): boolean {
    return !wait.released && (wait.source.kind === "join" && wait.source.task === task && !wait.source.wrapped || !!wait.members?.some(member => this.awaitingCancelled(member, task)));
  }
  private hasCancelledJoin(wait: RegisteredWait): boolean {
    return !wait.released && (wait.source.kind === "join" && !wait.source.wrapped && wait.source.task?.status === "cancelled" || !!wait.members?.some(member => this.hasCancelledJoin(member)));
  }
  private release(wait: RegisteredWait): void {
    if (wait.released) return;
    wait.released = true;
    for (const member of wait.members ?? []) this.release(member);
    if (wait.request) pendingRequests.delete(key(wait.request));
    wait.cancelled = true;
    if (wait.reserved && !wait.delivered && wait.source.kind === "service") {
      this.region.emit("request-cancel", { request: wait.request, service: wait.source.service });
      commands.push(() => { wait.cancel?.(); });
    } else if (wait.source.kind === "animate" && !wait.delivered) commands.push(() => { wait.cancel?.(); });
  }
  private register(source: Wait, task: Task, member: { value: number }): RegisteredWait {
    if (source.kind === "all" || source.kind === "any") return { source, members: source.members.map(wait => this.register(typeof wait === "function" ? wait() : wait, task, member)) };
    const request = { task: task.id, wait: task.wait, member: member.value++ };
    const wait: RegisteredWait = { source, request };
    pendingRequests.set(key(request), { runtime: this, wait, task });
    this.region.emit("wait", { request, awaitable: source.kind });
    if (source.kind === "join" && !source.task) source.task = source.start!();
    if (source.kind === "frames") wait.at = this.frame + Math.max(1, source.count);
    if (source.kind === "after") wait.at = this.now + source.ms;
    if (source.kind === "service") {
      const service = services.get(source.service);
      const active = [...pendingRequests.values()].filter(p => p.runtime === this && p.wait !== wait && p.wait.source.kind === "service" && p.wait.source.service === source.service && p.wait.reserved && !p.wait.delivered).length;
      if (!service?.available()) { wait.ready = true; wait.result = { kind: "unavailable" }; }
      else if (active >= service.capacity) { wait.ready = true; wait.result = { kind: "busy" }; }
      else {
        wait.reserved = true;
        const call = source.call, args = copy(source.args);
        this.region.emit("request", { module: source.service, call, args: copy(args), request });
        commands.push(() => {
          wait.hostIssued = true;
          const cleanup = service.request(call, copy(args), request, value => deliverModelResult(request, value));
          wait.cancel = typeof cleanup === "function" ? cleanup : undefined;
        });
      }
    }
    if (source.kind === "animate") {
      const args = copy(source.args);
      this.region.emit("command", { op: "animate", args, request });
      commands.push(() => {
        wait.hostIssued = true;
        const cleanup = commandHandler?.(this.region, "animate", copy(args), request);
        wait.cancel = typeof cleanup === "function" ? cleanup : undefined;
      });
    }
    return wait;
  }
  private segment(task: Task): void {
    this.region.dirty = true;
    while (task.status === "live") {
      const step = task.step(task.state, task.locals);
      if (step.done || step.next === undefined) {
        task.status = "done"; task.value = copy(step.result); task.locals = {};
        this.region.emit("task-complete", { task: task.id, value: task.value }); return;
      }
      task.state = step.next;
      if (step.suspend) { task.locals = copy(task.locals); task.wait++; task.bind = step.bind; task.pending = this.register(step.suspend, task, { value: 0 }); if (this.hasCancelledJoin(task.pending)) this.cancel(task.id.function, "awaited task cancelled"); return; }
    }
  }
  private ready(wait: RegisteredWait, results: Map<string, unknown>): { ready: boolean; value?: unknown; cancelled?: boolean } {
    if (wait.ready) return { ready: true, value: wait.result, cancelled: wait.cancelled };
    const result = this.inspectReady(wait, results);
    if (result.ready) { wait.ready = true; wait.result = copy(result.value); wait.cancelled = result.cancelled; }
    return result;
  }
  private inspectReady(wait: RegisteredWait, results: Map<string, unknown>): { ready: boolean; value?: unknown; cancelled?: boolean } {
    const source = wait.source;
    if (source.kind === "all" || source.kind === "any") {
      const values = wait.members!.map(member => this.ready(member, results));
      const winner = values.findIndex(value => value.ready);
      if (source.kind === "any") {
        if (winner < 0) return { ready: false };
        for (let index = 0; index < wait.members!.length; index++) if (index !== winner) this.release(wait.members![index]!);
        return values[winner]!;
      }
      return values.every(v => v.ready) ? { ready: true, value: values.map(v => v.value), cancelled: values.some(v => v.cancelled) } : { ready: false };
    }
    if (source.kind === "frames") return { ready: this.frame >= wait.at! };
    if (source.kind === "after") return { ready: this.now >= wait.at! };
    if (source.kind === "until") return { ready: source.predicate() };
    if (source.kind === "join") {
      const target = source.task!;
      if (target.status === "live") return { ready: false };
      return source.wrapped ? { ready: true, value: target.status === "done" ? { kind: "done", value: copy(target.value) } : { kind: "cancelled" } } : { ready: true, value: copy(target.value), cancelled: target.status === "cancelled" };
    }
    if (!results.has(key(wait.request!))) return { ready: false };
    let value = results.get(key(wait.request!));
    if (source.kind === "service" && !services.get(source.service)?.validate(value)) value = { kind: "malformed" };
    wait.ready = true; wait.result = copy(value); wait.delivered = true;
    return { ready: true, value };
  }
  snapshot(frame: number, now: number, results: Map<string, unknown>): (() => void)[] {
    this.frame = frame; this.now = now;
    if (this.region.disposed) { this.dispose(); return []; }
    return [...this.tasks.values()].filter(task => task.status === "live" && task.pending).sort((a, b) => a.order - b.order).flatMap(task => {
      const result = this.ready(task.pending!, results);
      if (!result.ready) return [];
      return [() => {
        if (task.status !== "live") return;
        if (result.cancelled) { this.cancel(task.id.function, "awaited task cancelled"); return; }
        this.release(task.pending!); task.pending = undefined;
        if (task.bind !== undefined) task.locals[task.bind] = copy(result.value);
        this.region.emit("task-resume", { task: task.id, state: task.state });
        this.segment(task);
      }];
    });
  }
}
/** Reset the boundary when a host starts a fresh application clock. */
export function resetModelTaskClock(): void {
  lastBoundary = undefined;
  for (const runtime of taskRuntimes) runtime.resetClock();
}
/** Region cleanup cancels host requests before another frame can run. */
export function disposeModelTasks(region: ModelRegion): void {
  for (const runtime of taskRuntimes) if (runtime.region === region) runtime.dispose();
}
export function resumeModelTasks(frame = virtualFrame() + 1, now = virtualNow() * 1000): void {
  lastBoundary = { frame, now };
  const incoming = deliveries; deliveries = [];
  const values = new Map<string, unknown>();
  for (const item of incoming) {
    const pending = pendingRequests.get(key(item.request));
    if (pending && pending.task.status === "live" && !pending.runtime.region.disposed) {
      const source = pending.wait.source;
      const value = source.kind === "service" && !services.get(source.service)?.validate(item.value) ? { kind: "malformed" } : copy(item.value);
      pending.wait.ready = true; pending.wait.result = value; pending.wait.delivered = true;
      values.set(key(item.request), value);
      pending.runtime.region.emit("delivery", { request: item.request, value });
    } else ([...taskRuntimes].find(runtime => runtime.region.instance === item.request.task.region) ?? taskRuntimes.values().next().value)?.region.emit("delivery-drop", { request: item.request });
  }
  const ready = [...taskRuntimes].sort((a, b) => a.region.instance - b.region.instance).flatMap(runtime => runtime.snapshot(frame, now, values));
  for (const run of ready) run();
}
