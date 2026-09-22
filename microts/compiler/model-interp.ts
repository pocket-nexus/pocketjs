/** Executable frame contract for Model IR; independent of native and browser emitters. */
import { parseMicroTsColor } from "../../contracts/spec/microts.ts";
import type { AotType } from "./aot-ir.ts";
import { assertModelProgram } from "./aot-model-tasks.ts";
import type { ModelAwaitable, ModelBinder, ModelBlock, ModelExpr, ModelFunction, ModelMemo, ModelModule, ModelProgram, ModelTask, ModelTaskState } from "./aot-model-ir.ts";

export interface TaskId { region: number; fn: number; generation: number }
export interface RequestId { task: TaskId; generation: number; member: number }
export interface ModelDelivery { request: RequestId; value: unknown }
export interface ModelDispatch { fn: number | string; args?: unknown[]; region?: number }
export interface ModelFrameInput { dispatch?: ModelDispatch[]; clock?: number; deliveries?: ModelDelivery[]; invalidate?: boolean; buttons?: number }
export interface ModelTraceEvent { kind: string; [key: string]: any }
export interface ModelFrame { frame: number; state: Record<string, any>; regions: Record<number, Record<string, any>>; trace: ModelTraceEvent[]; counts: ModelWorkCounts }
export interface ModelWorkCounts { scheduledMemos: number; demandMemos: number; effects: number; taskSegments: number; loopIterations: number }
export interface ModelService { available?: boolean; capacity?: number; validate?: (value: unknown) => boolean }
export interface ModelInterpreterOptions {
  development?: boolean; recursionLimit?: number; deferInitial?: boolean;
  services?: Record<string, ModelService>;
  update?: (interpreter: ModelInterpreter) => void;
  dispatch?: (interpreter: ModelInterpreter, input: ModelFrameInput) => boolean;
  mount?: (interpreter: ModelInterpreter, region: number) => void;
  cleanup?: (interpreter: ModelInterpreter) => boolean;
}
type Value = any;
type Env = Map<number, Value>;
interface Cell { value: Value; version: number; changed: boolean; seen?: number[] }
interface Region {
  id: number; module: ModelModule; cells: Map<number, Cell>; fields: Env; params: Env;
  generations: Map<number, number>; tasks: Map<number, RunningTask>; startSequence: number;
  initial: boolean; watch: Map<number, Value>;
}
interface RunningTask { id: TaskId; region: Region; definition: ModelTask; state: number; env: Env; sequence: number; generation: number; wait?: Wait; status: "live" | "done" | "cancelled"; value?: Value }
interface Wait {
  kind: ModelAwaitable["kind"]; request?: RequestId; members?: Wait[]; due?: number; source?: ModelAwaitable;
  env?: Env; task?: RunningTask; value?: Value; ready?: boolean; delivered?: boolean; cancelled?: boolean; released?: boolean; service?: string; issued?: boolean;
}
interface Ready { task: RunningTask; value?: Value; cancel?: boolean }
class Returned { constructor(readonly value: Value) {} }
const clone = <T>(value: T): T => value === undefined ? value : structuredClone(value);
const key = (id: RequestId) => `${id.task.region}:${id.task.fn}:${id.task.generation}:${id.generation}:${id.member}`;
const bound = (value: {capacity?:number;type:AotType}) => value.capacity ?? ("capacity" in value.type ? value.type.capacity : undefined);
const primitive = (value: Value) => value === null || typeof value !== "object";
const freshCounts = (): ModelWorkCounts => ({ scheduledMemos: 0, demandMemos: 0, effects: 0, taskSegments: 0, loopIterations: 0 });

export class ModelInterpreter {
  readonly program: ModelProgram;
  readonly options: ModelInterpreterOptions;
  trace: ModelTraceEvent[] = [];
  private regions = new Map<number, Region>();
  private sequence = 0;
  private instant = 0;
  private clock = 0;
  private depth = 0;
  private invalidated = false;
  private requests = new Map<string, { task: RunningTask; wait: Wait }>();
  private counts = freshCounts();
  private initializing = false;

  constructor(program: ModelProgram, options: ModelInterpreterOptions = {}) {
    this.program = program;
    assertModelProgram(this.program);
    this.options = options;
    const root = program.modules.find(m => m.kind === "root");
    if (!root) throw new Error("Model IR has no root module");
    this.mount(root.name, [], options.deferInitial ?? false);
    this.trace = []; this.counts = freshCounts();
  }

  /** A mount owns seeds, memo caches and a fresh task identity namespace. */
  mount(module: string | number, args: Value[] = [], defer = false): number {
    const definition = typeof module === "number" ? this.program.modules[module] : this.program.modules.find(m => m.name === module || m.factory === module);
    if (!definition || definition.kind === "pure") throw new Error(`Unknown model region ${module}`);
    const region: Region = { id: ++this.sequence, module: definition, cells: new Map(), fields: new Map(), params: new Map(definition.params.map((p, i) => [p.id, clone(args[i])])), generations: new Map(), tasks: new Map(), startSequence: 0, initial: true, watch: new Map() };
    this.regions.set(region.id, region);
    for (const s of definition.signals) region.cells.set(s.id, { value: this.capacity(this.expr(s.seed, region, region.params, s.name), bound(s), s.name), version: 1, changed: false });
    for (const f of definition.fields) region.fields.set(f.id, this.capacity(this.expr(f.seed, region, region.params, f.name), bound(f), f.name));
    for (const memo of definition.memos) region.cells.set(memo.id, { value: undefined, version: 0, changed: false, seen: [] });
    this.emit({ kind: "region-create", region: region.id, module: definition.name });
    for (const id of definition.schedule) { const memo = definition.memos.find(m => m.id === id); if (memo) this.memo(memo, region, "construction"); }
    for (const cell of region.cells.values()) cell.changed = false;
    for(const effect of definition.effects)if(effect.defer&&effect.watch){
      const values=effect.watch.sources.map(id=>this.read(id,region.id));
      region.watch.set(effect.id,clone(values.length===1?values[0]:values));
    }
    // View adapters can mount during update; caches are already available at the first read.
    if (!this.initializing && !defer) {
      this.react(region, true); region.initial = false;
      if (this.options.mount) { this.options.mount(this, region.id); this.react(region); }
      this.settle(region);
    }
    return region.id;
  }

  unmount(id: number): void {
    const region = this.region(id);
    for (const task of [...region.tasks.values()]) this.cancelTask(task, "unmount");
    this.regions.delete(id);
    this.emit({ kind: "region-destroy", region: id });
  }

  invalidate(): void { this.invalidated = true; }

  state(id = 1): Record<string, Value> {
    const region = this.region(id), result: Record<string, Value> = {};
    for (const s of [...region.module.signals, ...region.module.memos]) result[s.name] = clone(region.cells.get(s.id)!.value);
    for (const f of region.module.fields) result[f.name] = clone(region.fields.get(f.id));
    return result;
  }

  /** View callbacks call model functions with arguments evaluated at dispatch. */
  call(id: number | string, args: Value[] = [], regionId = 1, handler = false): Value {
    const region = this.region(regionId), fn = this.findFunction(id, region);
    if (handler) this.emit({ kind: "handler", region: region.id, fn: fn.id, name: fn.name, args: clone(args) });
    return this.invoke(fn.id, clone(args), region);
  }
  write(id: number | string, input: Value, regionId = 1): void {
    const region = this.region(regionId), signal = region.module.signals.find(signal => signal.id === id || signal.name === id || signal.setter === id);
    if (!signal) throw new Error(`Unknown model signal ${id}`);
    const cell = region.cells.get(signal.id)!, value = this.capacity(this.numeric(input,signal.type), bound(signal), signal.name);
    const changed = !this.primitiveType(signal.type) || value !== cell.value;
    if (changed) { cell.value = clone(value); cell.version++; cell.changed = true; }
    this.emit({ kind: "set", region: region.id, id: signal.id, name: signal.name, value: clone(value), changed, version: cell.version });
  }

  /** Dispatch-time view expressions must use this entry point; state() reads settled caches. */
  read(id: number, regionId = 1): Value {
    const region = this.region(regionId), memo = region.module.memos.find(m => m.id === id);
    return clone(memo ? this.memo(memo, region, "demand") : region.cells.get(id)?.value ?? region.fields.get(id));
  }

  frame(input: ModelFrameInput = {}): ModelFrame {
    this.trace = []; this.counts = freshCounts(); this.instant++;
    if (input.clock !== undefined) this.clock = input.clock;
    for (const delivery of input.deliveries ?? []) {
      const pending = this.requests.get(key(delivery.request));
      if (!pending || pending.task.status !== "live") { this.emit({ kind: "delivery-drop", request: delivery.request }); continue; }
      const service = pending.wait.service && this.options.services?.[pending.wait.service];
      pending.wait.value = service && service.validate && !service.validate(delivery.value) ? { kind: "malformed" } : clone(delivery.value);
      pending.wait.ready = true; pending.wait.delivered = true;
      this.emit({ kind: "delivery", request: delivery.request, value: clone(pending.wait.value) });
    }
    // Evaluate every wait before running any continuation: until sees one boundary state.
    const ready: Ready[] = [];
    for (const region of this.regions.values()) for (const task of [...region.tasks.values()].sort((a, b) => a.sequence - b.sequence)) {
      if (task.status !== "live" || !task.wait) continue;
      const result = this.ready(task.wait, region);
      if (result.ready) ready.push({ task, value: result.value, cancel: result.cancelled });
    }
    let dirty = ready.length > 0 || !!input.dispatch?.length || input.invalidate || this.invalidated;
    this.invalidated = false;
    for (const item of ready) {
      const task = item.task;
      if (task.status !== "live") continue;
      if (item.cancel) { this.cancelTask(task, "awaited task cancelled"); continue; }
      const state = this.taskState(task);
      this.release(task.wait!); task.wait = undefined;
      if (state.resume) task.env.set(state.resume.id, clone(item.value));
      task.state = state.next ?? -1;
      this.emit({ kind: "task-resume", task: clone(task.id), state: task.state });
      this.segment(task);
    }
    for (const dispatch of input.dispatch ?? []) {
      const region = this.region(dispatch.region ?? 1), fn = this.findFunction(dispatch.fn, region);
      this.emit({ kind: "handler", region: region.id, fn: fn.id, name: fn.name, args: clone(dispatch.args ?? []) });
      this.invoke(fn.id, dispatch.args ?? [], region);
    }
    if (this.options.dispatch?.(this, input)) dirty = true;
    if (dirty) {
      for (const region of this.regions.values()) this.react(region);
      for (const region of this.regions.values()) this.settle(region);
      this.initializing = true;
      try { this.options.update?.(this); } finally { this.initializing = false; }
      this.initialize();
    }
    for (const region of this.regions.values()) for (const cell of region.cells.values()) cell.changed = false;
    return { frame: this.instant, state: this.regions.has(1) ? this.state() : {}, regions: Object.fromEntries([...this.regions.keys()].map(id => [id, this.state(id)])), trace: clone(this.trace), counts: { ...this.counts } };
  }

  /** Mount rounds run after the view has created every region for an update. */
  initialize(): void {
    let rounds = 0, cleanup = this.options.cleanup?.(this) ?? false;
    while (cleanup || [...this.regions.values()].some(region => region.initial)) {
      if (++rounds > 8 && this.options.development !== false) throw new Error("Model mount rounds exceeded 8");
      for (const region of [...this.regions.values()]) if (region.initial) {
        this.react(region, true); region.initial = false; this.options.mount?.(this, region.id);
      }
      for (const region of this.regions.values()) { this.react(region); this.settle(region); }
      this.initializing = true;
      try { this.options.update?.(this); } finally { this.initializing = false; }
      cleanup = this.options.cleanup?.(this) ?? false;
    }
  }

  private region(id: number): Region { const region = this.regions.get(id); if (!region) throw new Error(`Region ${id} is not mounted`); return region; }
  private emit(event: ModelTraceEvent): void { this.trace.push(event); }
  private findFunction(id: number | string, region: Region): ModelFunction {
    const fn = region.module.functions.find(f => f.id === id || f.name === id) ?? this.program.modules.filter(m => m.kind === "pure").flatMap(m => m.functions).find(f => f.id === id || f.name === id);
    if (!fn) throw new Error(`Unknown model function ${id}`); return fn;
  }
  private invoke(id: number, args: Value[], region: Region): Value {
    const fn = this.findFunction(id, region);
    if (fn.async) return this.start(id, args, region);
    if (this.options.development !== false && this.depth >= (this.options.recursionLimit ?? this.program.recursionLimit ?? 256)) throw new Error(`Model recursion limit exceeded in ${fn.name}`);
    this.depth++;
    try { this.block(fn.body, region, new Map([...region.params, ...fn.params.map((p, i) => [p.id, this.capacity(args[i], bound(p), p.name)] as const)])); }
    catch (result) { if (result instanceof Returned) return clone(result.value); throw result; }
    finally { this.depth--; }
  }

  private memo(memo: ModelMemo, region: Region, mode: "scheduled" | "demand" | "settle" | "construction"): Value {
    const cell = region.cells.get(memo.id)!;
    for (const id of memo.inputs) { const input = region.module.memos.find(m => m.id === id); if (input) this.memo(input, region, mode === "construction" ? "construction" : "demand"); }
    const versions = memo.inputs.map(id => region.cells.get(id)!.version);
    if (!cell.version || versions.some((v, i) => cell.seen![i] !== v)) {
      const value = this.expr(memo.body, region, new Map(region.params), memo.name);
      const changed = !cell.version || !this.primitiveType(memo.type) || value !== cell.value;
      cell.seen = versions;
      if (changed) { cell.value = clone(value); cell.version++; cell.changed = true; }
      if (mode === "demand") this.counts.demandMemos++;
      this.emit({ kind: "memo", region: region.id, id: memo.id, name: memo.name, mode, value: clone(value), changed, version: cell.version });
    }
    return cell.value;
  }
  private react(region: Region, initial = false): void {
    for (const id of region.module.schedule) {
      const memo = region.module.memos.find(m => m.id === id);
      if (memo) { this.counts.scheduledMemos++; this.memo(memo, region, "scheduled"); continue; }
      const effect = region.module.effects.find(e => e.id === id)!;
      if (!(initial ? !effect.defer : effect.subscriptions.some(input => region.cells.get(input)!.changed))) continue;
      this.counts.effects++;
      this.emit({ kind: "effect", region: region.id, id, initial });
      const env = new Map(region.params);
      if (effect.watch) {
        const values = effect.watch.sources.map(id => this.read(id, region.id)), value = values.length === 1 ? values[0] : values;
        if (effect.watch.value) env.set(effect.watch.value.id, clone(value));
        if (effect.watch.previous) env.set(effect.watch.previous.id, clone(region.watch.get(id)));
        region.watch.set(id, clone(value));
      }
      try { this.block(effect.body, region, env); } catch (result) { if (!(result instanceof Returned)) throw result; }
    }
    for (const cell of region.cells.values()) cell.changed = false;
  }
  private settle(region: Region): void { for (const id of region.module.schedule) { const memo = region.module.memos.find(m => m.id === id); if (memo) this.memo(memo, region, "settle"); } }

  private capacity(value: Value, limit: number | undefined, name: string): Value {
    if (limit === undefined) return clone(value);
    const size = typeof value === "string" ? new TextEncoder().encode(value).length : value.length;
    if (size <= limit) return clone(value);
    if (this.options.development !== false) throw new Error(`Capacity ${limit} exceeded for ${name}`);
    if (typeof value !== "string") return clone(value.slice(0, limit));
    let result = "", length = 0;
    for (const ch of value) { const bytes = new TextEncoder().encode(ch).length; if (length + bytes > limit) break; result += ch; length += bytes; }
    return result;
  }
  private primitiveType(type:AotType):boolean {
    if(type.kind==="option")return false;
    if(type.kind==="named"){const declaration=this.program.types.find(value=>value.name===type.name);return declaration?.kind==="enum"||declaration?.kind==="newtype"&&this.primitiveType(declaration.base);}
    return ["number","boolean","string","undefined","void","style"].includes(type.kind);
  }
  numeric(value: Value, type: AotType): Value {
    if(type.kind==="option")return value===undefined?undefined:this.numeric(value,type.value);
    if(type.kind==="named"){
      const declaration=this.program.types.find(declaration=>declaration.name===type.name);
      if(declaration?.kind==="newtype"){
        if(declaration.unit==="Color"){const bits=parseMicroTsColor(value);return "#"+[bits&255,(bits>>>8)&255,(bits>>>16)&255,bits>>>24].map(byte=>byte.toString(16).padStart(2,"0")).join("");}
        return this.numeric(value,declaration.base);
      }
    }
    if (type.kind !== "number") return value;
    switch (type.name) { case "i32": return value | 0; case "u32": return value >>> 0; case "i8": return value << 24 >> 24; case "u8": return value & 255; case "i16": return value << 16 >> 16; case "u16": return value & 65535; case "f32": return Math.fround(value); default: return value; }
  }
  private defaultValue(type: AotType): Value {
    switch (type.kind) { case "number": return 0; case "string": return ""; case "boolean": return false; case "array": return []; case "tuple": return type.elements.map(t => this.defaultValue(t)); case "option": case "undefined": case "void": return undefined; case "named": {
      const definition = this.program.types?.find(t => t.name === type.name);
      if(definition?.kind==="enum")return definition.variants[0];
      if(definition?.kind==="newtype")return definition.unit==="Color"?"#00000000":this.defaultValue(definition.base);
      if(definition?.kind==="struct")return Object.fromEntries(definition.fields.map(f=>[f.name,this.defaultValue(f.type)]));
      if(definition?.kind==="union"){const variant=definition.variants[0]!;return{[definition.discriminant]:variant.name,...Object.fromEntries(variant.fields.map(f=>[f.name,this.defaultValue(f.type)]))};}
      return undefined;
    } default: return undefined; }
  }

  private expr(expr: ModelExpr, region: Region, env: Env, name = "expression"): Value {
    if (expr.kind === "lambda") return this.rawExpr(expr, region, env);
    const value = this.numeric(this.rawExpr(expr, region, env), expr.type), limit = "capacity" in expr.type ? expr.type.capacity : undefined;
    return limit === undefined ? value : this.capacity(value, limit, name);
  }
  private rawExpr(expr: ModelExpr, region: Region, env: Env): Value {
    const evaluate = (e: ModelExpr) => this.expr(e, region, env);
    switch (expr.kind) {
      case "literal": return expr.value;
      case "undefined": return undefined;
      case "local": return env.has(expr.id) ? env.get(expr.id) : region.params.get(expr.id);
      case "signal": return region.cells.get(expr.id)!.value;
      case "memo": return this.memo(region.module.memos.find(m => m.id === expr.id)!, region, "demand");
      case "field": return region.fields.get(expr.id);
      case "array": return expr.items.map(evaluate);
      case "struct": return Object.fromEntries(expr.fields.map(f => [f.name, this.expr(f.value, region, env, f.name)]));
      case "member": return evaluate(expr.object)?.[expr.name];
      case "index": { const object = evaluate(expr.object), index = evaluate(expr.index); return Number.isInteger(index) && index >= 0 && index < object.length ? object[index] : this.defaultValue(expr.type); }
      case "copy": return clone(evaluate(expr.value));
      case "cast": return this.numeric(evaluate(expr.value), expr.type);
      case "template": return expr.parts.map(part => typeof part === "string" ? part : String(evaluate(part))).join("");
      case "unary": { const value = evaluate(expr.operand); return expr.operator === "!" ? !value : this.numeric(expr.operator === "-" ? -value : +value, expr.type); }
      case "conditional": return evaluate(expr.condition) ? evaluate(expr.consequent) : evaluate(expr.alternate);
      case "binary": {
        const left = evaluate(expr.left);
        if (expr.operator === "&&") return left && evaluate(expr.right);
        if (expr.operator === "||") return left || evaluate(expr.right);
        if (expr.operator === "??") return left ?? evaluate(expr.right);
        const right = evaluate(expr.right); let value: Value;
        switch (expr.operator) {
          case "+": value = left + right; break; case "-": value = left - right; break;
          case "*": value = expr.type.kind === "number" && expr.type.name === "i32" ? Math.imul(left, right) : left * right; break;
          case "/": value = left / right; break; case "%": value = left % right; break; case "**": value = left ** right; break;
          case "===": return left === right; case "!==": return left !== right; case "<": return left < right; case "<=": return left <= right; case ">": return left > right; case ">=": return left >= right;
          case "&": value = left & right; break; case "|": value = left | right; break; case "^": value = left ^ right; break; case "<<": value = left << right; break; case ">>": value = left >> right; break; case ">>>": value = left >>> right; break;
          default: throw new Error(`Unsupported Model IR operator ${expr.operator}`);
        }
        return this.numeric(value, expr.type);
      }
      case "invoke": return this.invoke(expr.callee, expr.args.map(evaluate), region);
      case "builtin": return this.builtin(expr.name, expr.args.map(evaluate), expr.type);
      case "lambda": return (...args: Value[]) => { const inner = new Map(env); expr.params.forEach((b, i) => inner.set(b.id, clone(args[i]))); try { this.block(expr.body, region, inner); } catch (result) { if (result instanceof Returned) return result.value; throw result; } };
      case "sequence": try { this.block(expr.body, region, env); return evaluate(expr.value); } catch (result) { if (result instanceof Returned) return result.value; throw result; }
    }
  }
  builtin(name: string, args: Value[], type: AotType): Value {
    const [a, b, c] = args;
    switch (name) {
      case "String": case "display": return String(a); case "Number": return this.numeric(Number(a), type); case "len": return typeof a === "string" ? [...a].length : a.length;
      case "copy": return clone(a); case "equals": return this.equal(a, b);
      case "imod": return ((a % b) + b) % b; case "idiv": return this.numeric(Math.trunc(a / b), type); case "trunc": return this.numeric(Math.trunc(a), type);
      case "min": return Math.min(...args); case "max": return Math.max(...args); case "abs": return Math.abs(a); case "floor": return Math.floor(a); case "ceil": return Math.ceil(a); case "round": return Math.round(a); case "sqrt": return Math.sqrt(a); case "sin": return Math.sin(a); case "cos": return Math.cos(a); case "clamp": return Math.min(c, Math.max(b, a));
      case "map": return a.map((v: Value, i: number) => b(clone(v), i)); case "filter": return clone(a.filter((v: Value, i: number) => b(clone(v), i))); case "find": return clone(a.find((v: Value, i: number) => b(clone(v), i))); case "some": return a.some((v: Value, i: number) => b(clone(v), i));
      default: throw new Error(`Unsupported Model IR builtin ${name}`);
    }
  }
  private equal(a: Value, b: Value): boolean {
    if (primitive(a) || primitive(b)) return a === b;
    const keys = Object.keys(a); return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && this.equal(a[key], b[key]));
  }
  private block(block: ModelBlock, region: Region, env: Env): void {
    for (const stmt of block.stmts) {
      const evaluate = (e: ModelExpr) => this.expr(e, region, env);
      switch (stmt.kind) {
        case "let": env.set(stmt.binder.id, this.capacity(this.expr(stmt.init, region, env, stmt.binder.name), bound(stmt.binder), stmt.binder.name)); break;
        case "assign": {
          const value = clone(evaluate(stmt.value)), target = stmt.target;
          if (target.kind === "local") env.set(target.id, value);
          else if (target.kind === "field") { const field = region.module.fields.find(f => f.id === target.id)!; region.fields.set(target.id, this.capacity(value, bound(field), field.name)); }
          else if (target.kind === "element" || target.kind === "member") { const owner = env.get(target.owner); if (target.kind === "member") owner[target.name] = value; else { const index = evaluate(target.index); if (Number.isInteger(index) && index >= 0 && index < owner.length) owner[index] = value; } }
          break;
        }
        case "set": {
          const cell = region.cells.get(stmt.signal)!, signal = region.module.signals.find(s => s.id === stmt.signal)!;
          if (stmt.pre) env.set(stmt.pre.id, clone(cell.value));
          const value = this.capacity(this.expr(stmt.value, region, env, signal.name), bound(signal), signal.name);
          const changed = !stmt.writeBack && (!this.primitiveType(signal.type) || value !== cell.value);
          if (changed) { cell.value = clone(value); cell.version++; cell.changed = true; }
          this.emit({ kind: "set", region: region.id, id: stmt.signal, name: signal.name, value: clone(value), changed, version: cell.version });
          if (stmt.pre) env.delete(stmt.pre.id); break;
        }
        case "if": if (evaluate(stmt.condition)) this.block(stmt.then, region, env); else if (stmt.else) this.block(stmt.else, region, env); break;
        case "for": { const start = stmt.start ? evaluate(stmt.start) : 0, bound = evaluate(stmt.bound); for (let i = start; stmt.inclusive ? i <= bound : i < bound; i++) { this.counts.loopIterations++; env.set(stmt.binder.id, i); this.block(stmt.body, region, env); } break; }
        case "forOf": { const values = clone(evaluate(stmt.source)); for (const value of values) { this.counts.loopIterations++; env.set(stmt.binder.id, value); this.block(stmt.body, region, env); } break; }
        case "switch": { const value = evaluate(stmt.value), arm = stmt.cases.find(c => c.value && evaluate(c.value) === value) ?? stmt.cases.find(c => !c.value); if (arm) this.block(arm.body, region, env); break; }
        case "batch": case "untrack": this.block(stmt.body, region, env); break;
        case "return": throw new Returned(stmt.value ? evaluate(stmt.value) : undefined);
        case "call": this.invoke(stmt.callee, stmt.args.map(evaluate), region); break;
        case "expr": evaluate(stmt.value); break;
        case "external": {
          const args = stmt.args.map(evaluate);
          if (stmt.op === "cancel") { const task = region.tasks.get(args[0]); if (task) this.cancelTask(task, "cancel"); }
          else if (stmt.op !== "log" || this.options.development !== false) this.emit({ kind: "command", region: region.id, op: stmt.op, args: clone(args) });
          break;
        }
        case "start": this.start(stmt.task, stmt.args.map(evaluate), region); break;
        case "await": throw new Error("Await reached execution without coroutine lowering");
      }
    }
  }

  private start(id: number, args: Value[], region: Region): RunningTask {
    const fn = this.findFunction(id, region), definition = region.module.tasks.find(t => t.fn === id);
    if (!definition) throw new Error(`No coroutine for ${fn.name}`);
    const old = region.tasks.get(id); if (old?.status === "live") this.cancelTask(old, "restart");
    const generation = (region.generations.get(id) ?? 0) + 1; region.generations.set(id, generation);
    const task: RunningTask = { id: { region: region.id, fn: id, generation }, region, definition, state: 0, env: new Map([...region.params, ...fn.params.map((p, i) => [p.id, this.capacity(args[i], bound(p), p.name)] as const)]), sequence: ++region.startSequence, generation: 0, status: "live" };
    region.tasks.set(id, task); this.emit({ kind: "task-start", task: clone(task.id), state: 0 }); this.segment(task); return task;
  }
  private taskState(task: RunningTask): ModelTaskState { const state = task.definition.states.find(s => s.id === task.state); if (!state) throw new Error(`Unknown task state ${task.state}`); return state; }
  private segment(task: RunningTask): void {
    this.counts.taskSegments++;
    try {
      while (task.state !== -1 && task.status === "live") {
        const state = this.taskState(task);
        if (state.loop) this.counts.loopIterations++;
        this.block(state.body, task.region, task.env);
        if (state.suspend) {
          task.generation++;
          task.env = new Map([...task.env].map(([id, value]) => [id, clone(value)]));
          task.wait = this.wait(state.suspend, task, { member: 0 });
          if (this.hasCancelledJoin(task.wait)) this.cancelTask(task, "awaited task cancelled");
          return;
        }
        task.state = state.branch ? (this.expr(state.branch.condition, task.region, task.env) ? state.branch.then : state.branch.else) : state.next ?? -1;
      }
      if (task.status === "live") this.complete(task, undefined);
    } catch (result) { if (result instanceof Returned) this.complete(task, result.value); else throw result; }
  }
  private complete(task: RunningTask, value: Value): void { task.status = "done"; task.value = clone(value); this.emit({ kind: "task-complete", task: clone(task.id), value: clone(value) }); }
  private cancelTask(task: RunningTask, reason: string): void {
    if (task.status !== "live") return;
    task.status = "cancelled"; if (task.wait) this.release(task.wait); task.wait = undefined;
    this.emit({ kind: "task-cancel", task: clone(task.id), reason });
    for (const region of this.regions.values()) for (const parent of region.tasks.values()) if (parent.status === "live" && parent.wait && this.cancelledJoin(parent.wait, task)) this.cancelTask(parent, "awaited task cancelled");
  }
  private cancelledJoin(wait: Wait, task: RunningTask): boolean { return !wait.released && (wait.kind === "join" && wait.task === task && !(wait.source as Extract<ModelAwaitable, {kind: "join"}>).wrapped || !!wait.members?.some(w => this.cancelledJoin(w, task))); }
  private hasCancelledJoin(wait: Wait): boolean {
    return !wait.released && (wait.kind === "join" && wait.task?.status === "cancelled" && !(wait.source as Extract<ModelAwaitable,{kind:"join"}>).wrapped || !!wait.members?.some(member => this.hasCancelledJoin(member)));
  }
  private release(wait: Wait): void {
    if (wait.released) return;
    wait.released = true;
    for (const child of wait.members ?? []) this.release(child);
    if (wait.request) {
      this.requests.delete(key(wait.request));
      if (wait.issued && !wait.delivered && wait.service) this.emit({ kind: "request-cancel", request: clone(wait.request), service: wait.service });
    }
  }
  private wait(source: ModelAwaitable, task: RunningTask, position: { member: number }): Wait {
    if (source.kind === "all" || source.kind === "any") return { kind: source.kind, members: source.members.map(s => this.wait(s, task, position)) };
    const request: RequestId = { task: clone(task.id), generation: task.generation, member: position.member++ };
    const wait: Wait = { kind: source.kind, source, request, env: new Map(task.env) };
    const evaluate = (e: ModelExpr) => this.expr(e, task.region, task.env);
    this.requests.set(key(request), { task, wait });
    this.emit({ kind: "wait", request: clone(request), awaitable: source.kind });
    switch (source.kind) {
      case "frames": wait.due = this.instant + Math.max(1, evaluate(source.count)); break;
      case "after": wait.due = this.clock + evaluate(source.ms); break;
      case "until": break;
      case "join": wait.task = this.start(source.task, (source.args ?? []).map(evaluate), task.region); break;
      case "animate": wait.issued = true; this.emit({ kind: "command", region: task.region.id, op: "animate", args: source.args.map(evaluate), request: clone(request) }); break;
      case "service": {
        const name = source.module, service = this.options.services?.[name]; wait.service = name;
        const current = [...this.requests.values()].filter(r => r.wait !== wait && r.task.region === task.region && r.wait.service === name && r.wait.issued && !r.wait.delivered).length;
        if (!service || service.available === false) { wait.value = { kind: "unavailable" }; wait.ready = true; }
        else if (current >= (source.capacity ?? service.capacity ?? Infinity)) { wait.value = { kind: "busy" }; wait.ready = true; }
        else { wait.issued = true; this.emit({ kind: "request", request: clone(request), module: name, call: source.call, args: clone(source.args.map(evaluate)) }); }
        break;
      }
    }
    return wait;
  }
  private ready(wait: Wait, region: Region): { ready: boolean; value?: Value; cancelled?: boolean } {
    if (wait.ready) return { ready: true, value: clone(wait.value), cancelled: wait.cancelled };
    const result = this.inspectReady(wait, region);
    if (result.ready) { wait.ready = true; wait.value = clone(result.value); wait.cancelled = result.cancelled; }
    return result;
  }
  private inspectReady(wait: Wait, region: Region): { ready: boolean; value?: Value; cancelled?: boolean } {
    if (wait.kind === "all" || wait.kind === "any") {
      const members = wait.members!.map(w => this.ready(w, region));
      if (wait.kind === "all") return { ready: members.every(m => m.ready), value: members.map(m => clone(m.value)), cancelled: members.some(m => m.cancelled) };
      const winner = members.findIndex(member => member.ready);
      if (winner < 0) return { ready: false };
      for (let index = 0; index < wait.members!.length; index++) if (index !== winner) this.release(wait.members![index]!);
      return members[winner]!;
    }
    switch (wait.kind) {
      case "frames": return { ready: this.instant >= wait.due! };
      case "after": return { ready: this.clock >= wait.due! };
      case "until": return { ready: !!this.expr((wait.source as Extract<ModelAwaitable, { kind: "until" }>).predicate, region, wait.env!) };
      case "service": case "animate": return { ready: !!wait.ready, value: clone(wait.value) };
      case "join": {
        const task = wait.task!, wrapped = (wait.source as Extract<ModelAwaitable, { kind: "join" }>).wrapped;
        return { ready: task.status !== "live", cancelled: !wrapped && task.status === "cancelled", value: wrapped ? task.status === "cancelled" ? { kind: "cancelled" } : { kind: "done", value: clone(task.value) } : clone(task.value) };
      }
      default: throw new Error(`Unknown awaitable ${wait.kind}`);
    }
  }
}

export function interpretModel(program: ModelProgram, tape: ModelFrameInput[], options: ModelInterpreterOptions = {}): ModelFrame[] {
  const model = new ModelInterpreter(program, options); return tape.map(frame => model.frame(frame));
}
