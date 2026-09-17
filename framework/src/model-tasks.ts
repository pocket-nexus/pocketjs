import { copy, type ModelRegion } from "./model-reactive.ts";
import { virtualFrame, virtualNow } from "./clock.ts";

export interface TaskId { region: number; function: number; call: number }
export interface RequestId { task: TaskId; wait: number; member: number }
export type Join<T> = { kind: "done"; value: T } | { kind: "cancelled" };
export type Wait =
  | { kind: "frames"; count: number }
  | { kind: "after"; ms: number }
  | { kind: "until"; predicate: () => boolean }
  | { kind: "join"; task: TaskHandle; wrapped: boolean }
  | { kind: "service"; service: string; call: string; args: unknown[] }
  | { kind: "animate"; args: unknown[] }
  | { kind: "all" | "any"; members: Wait[] };
type Awaitable<T> = PromiseLike<T> & Wait;
const awaitable = <T>(wait: Wait): Awaitable<T> => wait as Awaitable<T>;
export const frames = (count: number): Awaitable<void> => awaitable({ kind: "frames", count });
export const after = (ms: number): Awaitable<void> => awaitable({ kind: "after", ms });
export const until = (predicate: () => boolean): Awaitable<void> => awaitable({ kind: "until", predicate });
export const join = <T>(task: PromiseLike<T>): PromiseLike<Join<T>> => awaitable({ kind: "join", task: task as unknown as TaskHandle, wrapped: true });
export const all = <T extends readonly unknown[]>(members: { [K in keyof T]: PromiseLike<T[K]> }): PromiseLike<T> => awaitable({ kind: "all", members: members as unknown as Wait[] });
export const any = <T>(members: readonly PromiseLike<T>[]): PromiseLike<T> => awaitable({ kind: "any", members: members as unknown as Wait[] });
export function cancel(_fn: (...args: any[]) => Promise<unknown>): void { throw new Error("cancel requires the compiled model transform"); }
export interface TaskHandle { id: TaskId; status: "live" | "done" | "cancelled"; value?: unknown }
interface RegisteredWait { source: Wait; request?: RequestId; at?: number; members?: RegisteredWait[]; result?: unknown; ready?: boolean; cancel?: () => void }
export interface TaskStep { next?: number; suspend?: Wait; bind?: number; result?: unknown; done?: boolean }
interface Task extends TaskHandle { state: number; order: number; wait: number; pending?: RegisteredWait; locals: Record<number, unknown>; step: (state: number, locals: Record<number, unknown>) => TaskStep; bind?: number }
interface Service {
  capacity: number;
  available(): boolean;
  validate(value: unknown): boolean;
  request(call: string, args: unknown[], id: RequestId, deliver: (value: unknown) => void): (() => void) | void;
}
const services = new Map<string, Service>();
export function registerModelService(name: string, service: Service): void { services.set(name, service); }
let deliveries: { request: RequestId; value: unknown }[] = [];
export function deliverModelResult(request: RequestId, value: unknown): void { deliveries.push({ request, value }); }
const key = (r: RequestId) => `${r.task.region}:${r.task.function}:${r.task.call}:${r.wait}:${r.member}`;
const taskRuntimes = new Set<ModelTasks>();

export class ModelTasks {
  private tasks = new Map<number, Task>();
  private generations = new Map<number, number>();
  private order = 0;
  frame = 0;
  now = 0;
  constructor(readonly region: ModelRegion) { taskRuntimes.add(this); }
  start(fn: number, args: unknown[], step: Task["step"], parameters: number[] = []): TaskHandle {
    this.cancel(fn);
    const call = (this.generations.get(fn) ?? 0) + 1; this.generations.set(fn, call);
    const task: Task = { id: { region: this.region.instance, function: fn, call }, status: "live", state: 0, wait: 0, order: this.order++, locals: Object.fromEntries(parameters.map((id, i) => [id, copy(args[i])])), step };
    this.tasks.set(fn, task); this.region.emit("task-start", { task: task.id });
    this.segment(task);
    return task;
  }
  cancel(fn: number): void {
    const task = this.tasks.get(fn);
    if (!task || task.status !== "live") return;
    task.status = "cancelled"; if (task.pending) this.release(task.pending);
    task.pending = undefined; task.locals = {};
    this.region.emit("task-cancel", { task: task.id });
  }
  private release(wait: RegisteredWait): void {
    for (const member of wait.members ?? []) this.release(member);
    if (wait.request && ["service", "animate"].includes(wait.source.kind)) this.region.emit("command", { op: "cancel", request: wait.request });
    wait.cancel?.();
  }
  private register(source: Wait, task: Task, member: { value: number }): RegisteredWait {
    if (source.kind === "all" || source.kind === "any") return { source, members: source.members.map(wait => this.register(wait, task, member)) };
    const request = { task: task.id, wait: task.wait, member: member.value++ };
    const wait: RegisteredWait = { source, request };
    if (source.kind === "frames") wait.at = this.frame + Math.max(1, source.count);
    if (source.kind === "after") wait.at = this.now + source.ms;
    if (source.kind === "service") {
      const service = services.get(source.service);
      const active = [...this.tasks.values()].reduce((count, task) => count + this.countRequests(task.pending, source.service), 0);
      if (!service?.available()) { wait.ready = true; wait.result = { kind: "unavailable" }; }
      else if (active >= service.capacity) { wait.ready = true; wait.result = { kind: "busy" }; }
      else {
        this.region.emit("command", { op: "request", service: source.service, call: source.call, args: copy(source.args), request });
        wait.cancel = service.request(source.call, copy(source.args), request, value => deliverModelResult(request, value)) ?? undefined;
      }
    }
    if (source.kind === "animate") this.region.emit("command", { op: "animate", args: source.args, request });
    return wait;
  }
  private countRequests(wait: RegisteredWait | undefined, service: string): number {
    if (!wait) return 0;
    return (wait.source.kind === "service" && wait.source.service === service && !wait.ready ? 1 : 0) + (wait.members ?? []).reduce((sum, w) => sum + this.countRequests(w, service), 0);
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
      if (step.suspend) { task.wait++; task.bind = step.bind; task.pending = this.register(step.suspend, task, { value: 0 }); return; }
    }
  }
  private ready(wait: RegisteredWait, results: Map<string, unknown>): { ready: boolean; value?: unknown; cancelled?: boolean } {
    if (wait.ready) return { ready: true, value: wait.result };
    const source = wait.source;
    if (source.kind === "all" || source.kind === "any") {
      const values = wait.members!.map(member => this.ready(member, results));
      const winner = values.findIndex(value => value.ready);
      if (source.kind === "any") return winner < 0 ? { ready: false } : values[winner]!;
      return values.every(v => v.ready) ? { ready: true, value: values.map(v => v.value), cancelled: values.some(v => v.cancelled) } : { ready: false };
    }
    if (source.kind === "frames") return { ready: this.frame >= wait.at! };
    if (source.kind === "after") return { ready: this.now >= wait.at! };
    if (source.kind === "until") return { ready: source.predicate() };
    if (source.kind === "join") {
      if (source.task.status === "live") return { ready: false };
      return source.wrapped ? { ready: true, value: source.task.status === "done" ? { kind: "done", value: copy(source.task.value) } : { kind: "cancelled" } } : { ready: true, value: copy(source.task.value), cancelled: source.task.status === "cancelled" };
    }
    if (!results.has(key(wait.request!))) return { ready: false };
    let value = results.get(key(wait.request!));
    if (source.kind === "service" && !services.get(source.service)?.validate(value)) value = { kind: "malformed" };
    wait.ready = true; wait.result = copy(value);
    return { ready: true, value };
  }
  snapshot(frame: number, now: number, results: Map<string, unknown>): (() => void)[] {
    this.frame = frame; this.now = now;
    if (this.region.disposed) { for (const fn of this.tasks.keys()) this.cancel(fn); taskRuntimes.delete(this); return []; }
    return [...this.tasks.values()].filter(task => task.status === "live" && task.pending).sort((a, b) => a.order - b.order).flatMap(task => {
      const result = this.ready(task.pending!, results);
      if (!result.ready) return [];
      return [() => {
        if (task.status !== "live") return;
        if (result.cancelled) { this.cancel(task.id.function); return; }
        this.release(task.pending!); task.pending = undefined;
        if (task.bind !== undefined) task.locals[task.bind] = copy(result.value);
        this.region.emit("task-resume", { task: task.id, state: task.state });
        this.segment(task);
      }];
    });
  }
}
export function resumeModelTasks(frame = virtualFrame(), now = virtualNow() * 1000): void {
  const incoming = deliveries; deliveries = [];
  const values = new Map(incoming.map(item => [key(item.request), item.value]));
  const ready = [...taskRuntimes].sort((a, b) => a.region.instance - b.region.instance).flatMap(runtime => runtime.snapshot(frame, now, values));
  for (const run of ready) run();
}
