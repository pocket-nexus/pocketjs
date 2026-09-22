/** Framework reaction: versions change at writes, never through a stock effect queue. */
export interface ModelTrace { kind: string; region: number; [key: string]: unknown }
export interface ModelStorage { <T>(value: T): [() => T, (value: T) => void] }
interface Cell {
  id: number; name: string; value: unknown; version: number; changed: boolean;
  read: () => unknown; store: (value: unknown) => void;
  inputs?: number[]; seen?: number[]; compute?: () => unknown; computing?: boolean;
  capacity?: number;
  scalar?: boolean;
  pending?: boolean;
}
interface Effect { id: number; inputs: number[]; body: () => void; defer: boolean }
export const copy = <T>(value: T): T => {
  if (Array.isArray(value)) return value.map(copy) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, copy(v)])) as T;
  return value;
};
export function equals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
  const ak = Object.keys(a), bk = Object.keys(b);
  return ak.length === bk.length && ak.every(key => Object.hasOwn(b, key) && equals((a as any)[key], (b as any)[key]));
}
export function capacity<T>(value: T, limit: number | undefined, name: string, development: boolean): T {
  if (limit === undefined) return value;
  if (typeof value === "string") {
    let bytes = 0, result = "";
    for (const character of value) {
      const code = character.codePointAt(0)!;
      const width = code < 128 ? 1 : code < 2048 ? 2 : code < 65536 ? 3 : 4;
      if (bytes + width > limit) { if (development) throw new Error(`model capacity exceeded in ${name}`); break; }
      result += character; bytes += width;
    }
    return result as T;
  }
  if (Array.isArray(value) && value.length > limit) {
    if (development) throw new Error(`model capacity exceeded in ${name}`);
    return value.slice(0, limit) as T;
  }
  return value;
}
const primitive = (value: unknown) => value === null || typeof value !== "object";
let sequence = 0;
export class ModelRegion {
  readonly instance = ++sequence;
  readonly cells = new Map<number, Cell>();
  readonly effects = new Map<number, Effect>();
  readonly refs = new Map<string, unknown>();
  readonly fields = new Map<string, () => unknown>();
  schedule: number[] = [];
  trace: ModelTrace[] = [];
  initial = true;
  disposed = false;
  dirty = false;
  private depth = 0;
  private fieldRevision = 0;
  private fieldsDirty = false;
  private fieldRead: () => number;
  private fieldStore: (value: number) => void;
  constructor(private storage: ModelStorage, readonly development = true, readonly recursionLimit = 256) {
    [this.fieldRead, this.fieldStore] = storage(0);
  }
  field<T>(value: T): T { this.fieldRead(); return value; }
  fieldChanged(): void { this.fieldsDirty = true; this.dirty = true; }
  emit(kind: string, data: Record<string, unknown> = {}): void { this.trace.push({ kind, region: this.instance, ...data }); }
  signal<T>(id: number, name: string, seed: T, cap?: number, scalar?: boolean): [() => T, (value: T | ((old: T) => T), writeBack?: boolean) => T] {
    const value = capacity(copy(seed), cap, name, this.development), [read, store] = this.storage(value);
    this.cells.set(id, { id, name, value, version: 1, changed: false, read, store: store as any, capacity: cap, scalar });
    return [() => this.read(id) as T, (next, writeBack = false) => { const value = typeof next === "function" ? (next as (v: T) => T)(this.cells.get(id)!.value as T) : next; this.write(id, value, writeBack); return value; }];
  }
  memo<T>(id: number, name: string, inputs: number[], compute: () => T, scalar?: boolean): () => T {
    const [read, store] = this.storage<unknown>(undefined);
    this.cells.set(id, { id, name, inputs, compute, seen: [], value: undefined, version: 0, changed: false, read, store, scalar });
    return () => this.read(id) as T;
  }
  effect(id: number, inputs: number[], body: () => void, defer = false): void { this.effects.set(id, { id, inputs, body, defer }); }
  finish(schedule: number[]): void {
    this.schedule = schedule;
    this.settle();
    for (const cell of this.cells.values()) cell.changed = false;
    this.dirty = false; this.trace = [];
  }
  read(id: number, mode = "demand"): unknown {
    const cell = this.cells.get(id);
    if (!cell) throw new Error(`Model cell ${id} is not declared`);
    if (cell.compute) {
      if (cell.computing) throw new Error(`model memo cycle at ${cell.name}`);
      cell.computing = true;
      try {
        for (const input of cell.inputs!) this.read(input, mode);
        const versions = cell.inputs!.map(id => this.cells.get(id)!.version);
        if (cell.version === 0 || versions.some((v, i) => v !== cell.seen![i])) {
          const value = cell.compute();
          const changed = cell.version === 0 || !(cell.scalar ?? primitive(value)) || value !== cell.value;
          cell.seen = versions;
          if (changed) { cell.value = copy(value); cell.version++; cell.changed = true; cell.pending = true; }
          this.emit("memo", { id, name: cell.name, mode, value: copy(value), changed, version: cell.version });
        }
      } finally { cell.computing = false; }
    }
    // Subscribe the view to stock storage, after all model work has finished.
    cell.read();
    return cell.value;
  }
  write(id: number, input: unknown, writeBack = false): void {
    const cell = this.cells.get(id)!;
    const value = capacity(input, cell.capacity, cell.name, this.development);
    const changed = (cell.scalar ?? primitive(value)) ? value !== cell.value : !writeBack;
    if (changed) { cell.value = copy(value); cell.version++; cell.changed = true; this.dirty = true; cell.pending = true; }
    this.emit("set", { id, name: cell.name, value: copy(value), changed, version: cell.version });
  }
  react(initial = false): void {
    for (const id of this.schedule) {
      const effect = this.effects.get(id);
      if (!effect) this.read(id, "scheduled");
      else if (initial ? !effect.defer : effect.inputs.some(id => this.cells.get(id)!.changed)) {
        this.emit("effect", { id, initial }); effect.body();
      }
    }
    for (const cell of this.cells.values()) cell.changed = false;
    this.initial = false; this.dirty = false;
  }
  settle(): void {
    for (const id of this.schedule) if (!this.effects.has(id)) this.read(id, "settle");
    for (const cell of this.cells.values()) if (cell.pending) { cell.pending = false; cell.store(cell.value); }
    if (this.fieldsDirty) { this.fieldsDirty = false; this.fieldStore(++this.fieldRevision); }
  }
  enter(name: string): void { if (this.development && ++this.depth > this.recursionLimit) { this.depth--; throw new Error(`model recursion limit exceeded in ${name}`); } }
  leave(): void { if (this.development) this.depth--; }
  state(): Record<string, unknown> { return Object.fromEntries([...this.cells.values()].map(cell => [cell.name, copy(cell.value)]).concat([...this.fields].map(([name, read]) => [name, copy(read())]))); }
  dispose(): void { this.disposed = true; }
}

const regions = new Set<ModelRegion>();
export function registerModelRegion(region: ModelRegion): ModelRegion { regions.add(region); return region; }
export function liveModelRegions(): ModelRegion[] { return [...regions].filter(region => !region.disposed); }
export function reactModelRegions(): void {
  for (const region of regions) {
    if (region.disposed) { regions.delete(region); continue; }
    if (!region.initial && region.dirty) { region.react(); region.settle(); }
  }
}
export function initialModelRegions(): boolean {
  let ran = false;
  for (const region of liveModelRegions()) if (region.initial) { region.react(true); region.settle(); ran = true; }
  return ran;
}
