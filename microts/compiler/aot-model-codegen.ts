/** Model IR → Rust AST. The shared printer is the only owner of Rust syntax. */
import type { AotComponent, AotProgram, AotType, AotTypeDeclaration } from "./aot-ir.ts";
import { checkModelVersion, type ModelBinder, type ModelBlock, type ModelExpr, type ModelFunction, type ModelModule, type ModelPathStep, type ModelProgram, type ModelStmt, type ModelTarget, type ModelTask, type ModelAwaitable } from "./aot-model-ir.ts";
import type { RustBlock, RustExpr, RustField, RustFunction, RustItem, RustParam, RustStatement, RustType } from "./rust-ast.ts";
import { rb, rc, re, ref, rf, rl, rm, rn, rp, rr, rt } from "./rust-ast.ts";
import { printRust, rustVariant } from "./rust-printer.ts";
import { exactIntegerLiteral, typeName } from "./aot-types.ts";
import { ANIMATABLE, PROP, type PropName } from "../../contracts/spec/spec.ts";
import { parseMicroTsColor, MICROTS_NUMERIC_TYPES } from "../../contracts/spec/microts.ts";

const self = rp("self"), unit: RustType = { kind: "tuple", elements: [] };
const field = (name: string) => rf(self, name);
const param = (name: string, type: RustType): RustParam => ({ pattern: rn(name), type });
const receiver = (mutable = false) => param("self", rr(rt("Self"), mutable));
const let_ = (name: string, value: RustExpr, mutable = false, type?: RustType): RustStatement => ({ kind: "let", pattern: rn(name, mutable), value, type });
const assign = (target: RustExpr, value: RustExpr): RustStatement => ({ kind: "assign", target, value });
const bin = (operator: string, left: RustExpr, right: RustExpr): RustExpr => ({ kind: "binary", operator, left, right });
const cast = (expr: RustExpr, type: RustType): RustExpr => ({ kind: "cast", expr, type });
const block = (statements: RustStatement[], result?: RustExpr): RustExpr => ({ kind: "block", block: rb(statements, result) });
const condition = (value: RustExpr, statements: RustStatement[], otherwise?: RustBlock): RustStatement => re({ kind: "if", condition: value, then: rb(statements), otherwise });
const fn = (name: string, params: RustParam[], body: RustBlock, returns?: RustType, public_ = false): RustFunction => ({ kind: "fn", name, params, body, returns, public: public_ });
const or = (values: RustExpr[]): RustExpr => values.reduce((a, b) => bin("||", a, b), rl(false));
/**
 * Windows shorter than this are copied or filled by a loop written in place;
 * longer ones call memcpy or memset, whose word stores pay for the call.
 */
const SHORT_WINDOW = 16;
const work = (kind: string): RustStatement => re(rc(rp("microts", "model", "count_work"), rp("microts", "model", "ModelWork", kind)));

class ModelRust {
  items: RustItem[] = [];
  serial = 0;
  current!: ModelModule;
  mutable = true;
  constructing = false;
  task: ModelTask | undefined;
  returnType: AotType | undefined;
  expressionScope = 0;
  predicates = new Map<ModelAwaitable, number>();
  binders = new Map<number, ModelBinder>();
  modules = new Map<number, ModelModule>();
  functions = new Map<number, ModelFunction>();
  declarations: Map<string, AotTypeDeclaration>;
  /** Loops targeted by continue, and the label a continue uses while each loop is open. */
  continued = new Set<number>();
  loopLabels = new Map<number, { loop: string; body?: string }>();
  constants = new Map<number, ModelExpr>();
  /** Rows `root[index]` of nested arrays borrowed as slices before the loop that reads them, by rowKey. */
  rows = new Map<string, string>();
  constructor(readonly program: ModelProgram, readonly view?: AotProgram) {
    this.declarations = new Map(program.types.map(t => [t.name, t]));
    const walk = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) { value.forEach(walk); return; }
      const node = value as { kind?: string; loop?: number; id?: number; value?: ModelExpr };
      if (node.kind === "continue" && node.loop !== undefined) this.continued.add(node.loop);
      if (node.kind === "constant" && node.id !== undefined && node.value) this.constants.set(node.id, node.value);
      for (const [key, child] of Object.entries(value)) if (!["loc", "ledger", "type"].includes(key)) walk(child);
    };
    walk(program.modules);
    for (const module of program.modules) for (const func of module.functions) { this.modules.set(func.id, module); this.functions.set(func.id, func); }
  }
  name(id: number) { return `v_${id}`; }
  taskValueName() { return `${this.current.name}TaskValue`; }
  taskReturn(value?: ModelExpr): RustExpr {
    const func = this.functions.get(this.task!.fn)!;
    return rc(rp(this.taskValueName(), `Fn${func.id}`), value ? this.coerce(value, func.returns, func.name) : this.defaultValue(func.returns));
  }
  signal(id: number) { const signal = this.current.signals.find(s => s.id === id); if (!signal) throw new Error(`Unknown model signal ${id}`); return signal; }
  node(id: number) { return [...this.current.signals, ...this.current.memos].find(s => s.id === id)!; }
  storage(id: number): RustExpr {
    if (this.current.params.some(p => p.id === id)) return this.constructing ? rp(this.name(id)) : field(this.name(id));
    if (this.task?.fields.some(p => p.id === id)) return field(`task_${this.task.id}_${this.name(id)}`);
    if ([...this.current.signals, ...this.current.fields, ...this.current.memos, ...this.current.refs].some(p => p.id === id)) return field(this.name(id));
    return rp(this.name(id));
  }
  constantName(id: number) { return `CONST_${id}`; }
  /** include_bytes! takes the resolved path as a string literal. */
  embeddedPath(e: ModelExpr): RustExpr {
    const path = e.kind === "builtin" ? e.args[0] : undefined;
    if (path?.kind !== "literal" || typeof path.value !== "string") throw new Error("embedBytes requires a resolved path literal");
    return rl(path.value);
  }
  /** A Rust place for a stored value, read without cloning the whole value. */
  borrow(e: ModelExpr): RustExpr | undefined {
    if (e.kind === "local" || e.kind === "field" || e.kind === "signal") return this.storage(e.id);
    if (e.kind === "constant") return rp(this.constantName(e.id));
    if (e.kind === "member" && e.object.type.kind === "named" && this.declarations.get(e.object.type.name)?.kind === "struct") {
      const object = this.borrow(e.object);
      return object && rf(object, e.name);
    }
    return undefined;
  }
  /**
   * An element read below a stored root, as an `Option<&T>` chain: index operands
   * are bound to locals in source order, then each step borrows from the last.
   */
  readChain(e: ModelExpr): { statements: RustStatement[]; value: RustExpr } | undefined {
    const steps: ModelExpr[] = [];
    let root = e;
    while (root.kind === "index" || root.kind === "member" && root.object.type.kind === "named" && this.declarations.get(root.object.type.name)?.kind === "struct") { steps.unshift(root); root = root.object; }
    const place = this.borrow(root);
    if (!place || !steps.length || steps[0]!.kind !== "index") return undefined;
    // Index operands run before the borrow; one that calls a function could change the
    // root, which JavaScript reads first, so such reads copy the root instead.
    if (steps.some(step => step.kind === "index" && this.calls(step.index))) return undefined;
    const statements: RustStatement[] = [];
    let value: RustExpr = place, optional = false;
    const row = steps.length > 1 && steps[1]!.kind === "index" ? this.rows.get(this.rowKey(root, (steps[0] as { index: ModelExpr }).index)) : undefined;
    if (row) { value = rp(row); steps.shift(); }
    for (const step of steps) {
      if (step.kind === "member") { value = optional ? rm(value, "map", { kind: "closure", params: [rn("value")], body: ref(rf(rp("value"), step.name)) }) : rf(value, step.name); continue; }
      if (step.kind !== "index") continue;
      const index = `index_${this.serial++}`;
      statements.push(let_(index, this.expr(step.index)));
      const get = (object: RustExpr) => rm(object, "get", cast(rp(index), rt("usize")));
      value = optional ? rm(value, "and_then", { kind: "closure", params: [rn("value")], body: get(rp("value")) }) : get(value);
      optional = true;
    }
    return { statements, value };
  }
  /** Whether evaluating a value may call a function or change an array. */
  calls(value: unknown): boolean {
    if (!value || typeof value !== "object") return false;
    if (Array.isArray(value)) return value.some(item => this.calls(item));
    const kind = (value as { kind?: string }).kind;
    if (kind === "invoke" || kind === "mutate" || kind === "sequence" || kind === "lambda") return true;
    return Object.entries(value).some(([key, child]) => key !== "loc" && key !== "ledger" && key !== "type" && this.calls(child));
  }
  rowKey(root: ModelExpr, index: ModelExpr): string {
    return `${"id" in root ? root.id : ""}:${JSON.stringify(index, (key, value) => key === "loc" || key === "ledger" ? undefined : value)}`;
  }
  /**
   * Borrows, before a loop, each row `root[i]` whose elements the loop reads, when
   * the loop writes neither `root` nor anything `i` reads and calls no model
   * function. Element reads then index a slice held in registers instead of
   * reloading the row's header from memory that stores in the loop may alias.
   */
  withRows(parts: unknown[], lower: () => RustStatement[]): RustStatement[] {
    const written = new Set<number>(), found = new Map<string, Extract<ModelExpr, { kind: "index" }>>();
    const candidate = (row: ModelExpr | undefined) => { if (row?.kind === "index" && row.type.kind === "array" && (row.object.kind === "local" || row.object.kind === "field" || row.object.kind === "signal")) found.set(this.rowKey(row.object, row.index), row); };
    let blocked = false;
    const walk = (value: unknown): void => {
      if (blocked || !value || typeof value !== "object") return;
      if (Array.isArray(value)) { value.forEach(walk); return; }
      const node = value as Record<string, any>;
      switch (node.kind) {
        case "invoke": case "call": if (this.modules.get(node.callee)?.kind !== "pure") blocked = true; break;
        case "memo": case "set": case "external": case "start": case "await": blocked = true; break;
        case "return": if (this.task) blocked = true; break;
        case "let": case "for": case "forOf": written.add(node.binder.id); break;
        case "lambda": for (const binder of node.params) written.add(binder.id); break;
        case "assign": case "mutate": {
          const t = node.target as ModelTarget; written.add(t.kind === "path" ? t.root.id : "id" in t ? t.id : t.owner);
          // A row copied from is read in place like a row read by element.
          if (node.kind === "mutate" && (node.op === "copyRange" || node.op === "copyRect")) candidate(node.args[node.op === "copyRect" ? 2 : 1]);
          break;
        }
        case "index": candidate(node.object); break;
      }
      for (const [key, child] of Object.entries(value)) if (key !== "loc" && key !== "ledger" && key !== "type") walk(child);
    };
    walk(parts);
    const invariant = (e: ModelExpr): boolean => {
      switch (e.kind) {
        case "literal": return true;
        case "local": case "field": case "signal": return !written.has(e.id);
        case "unary": return invariant(e.operand);
        case "binary": return e.operator !== "??" && e.type.kind === "number" && invariant(e.left) && invariant(e.right);
        case "cast": case "copy": return invariant(e.value);
        case "conditional": return invariant(e.condition) && invariant(e.consequent) && invariant(e.alternate);
        default: return false;
      }
    };
    const statements: RustStatement[] = [], keys: string[] = [];
    for (const [key, row] of blocked ? [] : found) {
      const place = this.borrow(row.object);
      if (this.rows.has(key) || !place || !("id" in row.object) || written.has(row.object.id) || row.index.type.kind !== "number" || !invariant(row.index)) continue;
      const name = `row_${this.serial++}`;
      statements.push(let_(name, rm(rm(rm(place, "get", cast(this.expr(row.index), rt("usize"))), "map", { kind: "closure", params: [rn("value")], body: rm(rp("value"), "as_slice") }), "unwrap_or", ref({ kind: "array", elements: [] }))));
      this.rows.set(key, name);
      keys.push(key);
    }
    try { return [...statements, ...lower()]; } finally { for (const key of keys) this.rows.delete(key); }
  }
  /** Type of the place a target denotes. */
  placeType(target: ModelTarget): AotType {
    const root = target.kind === "path" ? target.root.id : "id" in target ? target.id : target.owner;
    const steps: ModelPathStep[] = target.kind === "path" ? target.steps : target.kind === "element" ? [{ kind: "index", index: target.index }] : target.kind === "member" ? [{ kind: "member", name: target.name }] : [];
    return steps.reduce((type, step) => this.stepType(type, step), this.rootType(root));
  }
  /** Type of a place below its root, following element and member steps. */
  stepType(type: AotType, step: ModelPathStep): AotType {
    if (step.kind === "index") return type.kind === "array" ? type.element : type;
    const declaration = type.kind === "named" ? this.declarations.get(type.name) : undefined;
    return declaration?.kind === "struct" ? declaration.fields.find(field => field.name === step.name)!.type : type;
  }
  rootType(id: number): AotType {
    return (this.binders.get(id) ?? this.task?.fields.find(field => field.id === id) ?? [...this.current.fields, ...this.current.params].find(field => field.id === id))!.type;
  }
  /**
   * Runs `body` with a mutable Rust place for a target. Index operands are bound to
   * locals first; an out-of-range element skips the body, as element writes do.
   */
  withPlace(target: ModelTarget, body: (place: RustExpr, type: AotType) => RustStatement[]): RustStatement[] {
    const root = target.kind === "path" ? target.root : target.kind === "element" || target.kind === "member" ? { kind: "local" as const, id: target.owner } : { kind: target.kind, id: target.id };
    const steps: ModelPathStep[] = target.kind === "path" ? target.steps : target.kind === "element" ? [{ kind: "index", index: target.index }] : target.kind === "member" ? [{ kind: "member", name: target.name }] : [];
    const prefix: RustStatement[] = [], names = steps.map(step => { if (step.kind !== "index") return ""; const name = `index_${this.serial++}`; prefix.push(let_(name, this.expr(step.index))); return name; });
    const nest = (place: RustExpr, type: AotType, index: number): RustStatement[] => {
      if (index === steps.length) return body(place, type);
      const step = steps[index]!, next = this.stepType(type, step);
      if (step.kind === "member") return nest(rf(place, step.name), next, index + 1);
      const element = `element_${this.serial++}`;
      return [re({ kind: "ifLet", pattern: { kind: "variant", path: ["Some"], tuple: [rn(element)] }, value: rm(place, "get_mut", cast(rp(names[index]!), rt("usize"))), then: rb(nest({ kind: "unary", operator: "*", expr: rp(element) }, next, index + 1)) })];
    };
    return [...prefix, ...nest(this.storage(root.id), this.rootType(root.id), 0)];
  }
  mutate(e: Extract<ModelExpr, { kind: "mutate" }>): RustExpr {
    // copyRange and copyRect read a source array, borrowed below rather than evaluated here.
    const sourceIndex = e.op === "copyRange" ? 1 : e.op === "copyRect" ? 2 : -1;
    // A value stored into the array takes the element type, such as a Cap string.
    const valueIndex = ({ push: 0, insert: 1, fillRange: 2, fillRect: 4 } as Partial<Record<typeof e.op, number>>)[e.op];
    const targetType = this.placeType(e.target), element = targetType.kind === "array" ? targetType.element : undefined;
    const statements: RustStatement[] = [], args = e.args.map((arg, index) => {
      if (index === sourceIndex) return undefined;
      const name = `arg_${this.serial++}`; statements.push(let_(name, index === valueIndex && element ? this.coerce(arg, element) : this.expr(arg))); return rp(name);
    });
    const root = e.target.kind === "path" ? e.target.root.id : "id" in e.target ? e.target.id : e.target.owner;
    let source: RustExpr | undefined;
    if (sourceIndex >= 0) {
      // The source is borrowed as a slice where it can be: a stored array, a row held
      // by the enclosing loop, or an element of another stored array. A source that
      // may be the target is copied first, except for copyRange's copy_within.
      const value = e.args[sourceIndex]!, place = this.borrow(value);
      const element = value.type.kind === "array" ? value.type.element : value.type;
      const slice = (borrowed: RustExpr) => { const name = `source_${this.serial++}`; statements.push(let_(name, borrowed, false, rr({ kind: "slice", element: this.type(element) }))); return rp(name); };
      const sameRoot = (value.kind === "local" || value.kind === "field") && value.id === root;
      let stored = value;
      while (stored.kind === "index" || stored.kind === "member") stored = stored.object;
      // Any source below the target's root, such as bank.data for a target bank.data, is copied.
      const aliased = (stored.kind === "local" || stored.kind === "field" || stored.kind === "signal") && stored.id === root;
      const other = (stored.kind === "local" || stored.kind === "field" || stored.kind === "signal") && !aliased;
      const row = value.kind === "index" && other ? this.rows.get(this.rowKey(value.object, value.index)) : undefined;
      const chain = !place && !row && other ? this.readChain(value) : undefined;
      const within = e.op === "copyRange" && e.args.length < 5 && sameRoot && (e.target.kind === "local" || e.target.kind === "field");
      if (row) source = rp(row);
      else if (place && !aliased) source = slice(ref(place));
      else if (chain) { statements.push(...chain.statements); source = slice({ kind: "match", value: chain.value, arms: [{ pattern: { kind: "variant", path: ["Some"], tuple: [rn("value")] }, body: rp("value") }, { pattern: { kind: "wildcard" }, body: ref({ kind: "array", elements: [] }) }] }); }
      else if (!within) { const name = `source_${this.serial++}`; statements.push(let_(name, this.expr(value))); source = slice(ref(rp(name))); }
    }
    const result = `result_${this.serial++}`, returns = e.type.kind !== "void";
    if (returns) statements.push(let_(result, this.defaultValue(e.type), true, this.type(e.type)));
    const builtin = (name: string, ...values: RustExpr[]) => rc(rp("microts", "builtins", name), ...values);
    statements.push(...this.withPlace(e.target, (place, type) => {
      const element = type.kind === "array" ? type.element : e.type;
      const coerced = (value: RustExpr | undefined) => value!;
      switch (e.op) {
        case "push": return [re(rm(place, "push", coerced(args[0])))];
        case "pop": return [assign(rp(result), rm(rm(place, "pop"), "unwrap_or_else", { kind: "closure", params: [], body: this.defaultValue(element) }))];
        case "insert": return [re(builtin("insert", ref(place, true), args[0]!, args[1]!))];
        case "removeAt": return [assign(rp(result), builtin("remove_at", ref(place, true), args[0]!, { kind: "closure", params: [], body: this.defaultValue(element) }))];
        case "clear": return [re(rm(place, "clear"))];
        case "truncate": return [re(builtin("truncate", ref(place, true), args[0]!))];
        case "fillRange": return this.fillWindow(place, element, args[0]!, args[1]!, args[2]!);
        case "copyRange":
          if (!source) return [re(builtin("copy_within", ref(place, true), args[2]!, args[0]!, args[3]!))];
          return this.copyWindow(place, element, source, args[0]!, args[2]!, args[3]!, args[4]);
        case "fillRect": return this.fillRect(place, element, args[0]!, args[1]!, args[2]!, args[3]!, args[4]!);
        case "copyRect": return this.copyRect(place, element, source!, args[0]!, args[1]!, args[3]!, args[4]!, args[5]!, args[6]!, args[7]);
      }
    }));
    return block(statements, returns ? rp(result) : undefined);
  }
  /**
   * copyRange written out in place: the clipped window becomes two slices that a
   * loop indexes without bounds checks. A generic helper would not inline into
   * functions built for another instruction set, and short copies would pay for
   * the call.
   */
  copyWindow(place: RustExpr, element: AotType, source: RustExpr, to: RustExpr, from: RustExpr, count: RustExpr, skip?: RustExpr): RustStatement[] {
    const id = this.serial++, name = (base: string) => `${base}_${id}`;
    const i32 = (value: RustExpr) => cast(value, rt("i32")), usize = (value: RustExpr) => cast(value, rt("usize"));
    const at = rp(name("to")), start = rp(name("from")), length = rp(name("count")), target = rp(name("target"));
    const limit = (slice: RustExpr, offset: RustExpr) => condition(bin(">", length, bin("-", i32(rm(slice, "len")), offset)), [assign(length, bin("-", i32(rm(slice, "len")), offset))]);
    // Saturating steps keep i32 arithmetic: a window pushed past i32 range is empty either way.
    return [
      let_(name("to"), to, true), let_(name("from"), from, true), let_(name("count"), count, true),
      condition(bin("<", start, rl(0)), [assign(length, rm(length, "saturating_add", start)), assign(at, rm(at, "saturating_sub", start)), assign(start, rl(0))]),
      condition(bin("<", at, rl(0)), [assign(length, rm(length, "saturating_add", at)), assign(start, rm(start, "saturating_sub", at)), assign(at, rl(0))]),
      let_(name("target"), ref(place, true), false, rr({ kind: "slice", element: this.type(element) }, true)),
      limit(source, start), limit(target, at),
      condition(bin(">", length, rl(0)), this.copyLoop(name, target, usize(at), source, usize(start), usize(length), skip)),
    ];
  }
  /** Copies `length` elements from source[from..] to target[to..], both in range, skipping `skip`. */
  copyLoop(name: (base: string) => string, target: RustExpr, to: RustExpr, source: RustExpr, from: RustExpr, length: RustExpr, skip?: RustExpr): RustStatement[] {
    const index = rp(name("index")), value = rp(name("value")), window = rp(name("window")), values = rp(name("values"));
    const range = (first: RustExpr): RustExpr => ({ kind: "struct", path: ["core", "ops", "Range"], fields: [{ name: "start", value: first }, { name: "end", value: bin("+", first, length) }] });
    const store = assign({ kind: "index", object: window, index }, value);
    return [
      let_(name("window"), ref({ kind: "index", object: target, index: range(to) }, true)), let_(name("values"), ref({ kind: "index", object: source, index: range(from) })), let_(name("index"), rl(0, "usize"), true),
      ...this.shortLoop(skip ? undefined : bin(">=", length, rl(SHORT_WINDOW)), [re(rm(window, "copy_from_slice", values))], { kind: "while", condition: bin("<", index, length), body: rb([
        let_(name("value"), { kind: "index", object: values, index }),
        skip ? condition(bin("!=", value, skip), [store]) : store,
        assign(index, bin("+", index, rl(1))),
      ]) }),
    ];
  }
  /** A loop over a short window, or `long` (memcpy or memset) when `isLong` holds. */
  shortLoop(isLong: RustExpr | undefined, long: RustStatement[], loop: RustStatement): RustStatement[] {
    return isLong ? [condition(isLong, long, rb([loop]))] : [loop];
  }
  /** fillRange written out in place, like copyWindow. */
  fillWindow(place: RustExpr, element: AotType, start: RustExpr, end: RustExpr, value: RustExpr): RustStatement[] {
    const id = this.serial++, name = (base: string) => `${base}_${id}`;
    const first = rp(name("start")), last = rp(name("end")), target = rp(name("target"));
    const size = cast(rm(target, "len"), rt("i32")), usize = (value: RustExpr) => cast(value, rt("usize"));
    return [
      let_(name("target"), ref(place, true), false, rr({ kind: "slice", element: this.type(element) }, true)),
      let_(name("start"), start, true), let_(name("end"), end, true),
      condition(bin("<", first, rl(0)), [assign(first, rl(0))]),
      condition(bin(">", last, size), [assign(last, size)]),
      condition(bin("<", first, last), this.fillLoop(name, target, usize(first), usize(bin("-", last, first)), element, value)),
    ];
  }
  /** Fills `length` elements of target from `at`, all in range. */
  fillLoop(name: (base: string) => string, target: RustExpr, at: RustExpr, length: RustExpr, element: AotType, value: RustExpr): RustStatement[] {
    const index = rp(name("index")), window = rp(name("window")), item = this.copy(element) ? value : rm(value, "clone");
    return [
      let_(name("window"), ref({ kind: "index", object: target, index: { kind: "struct", path: ["core", "ops", "Range"], fields: [{ name: "start", value: at }, { name: "end", value: bin("+", at, length) }] } }, true)),
      let_(name("index"), rl(0, "usize"), true),
      ...this.shortLoop(bin(">=", length, rl(SHORT_WINDOW)), [re(rm(window, "fill", item))],
        { kind: "while", condition: bin("<", index, length), body: rb([assign({ kind: "index", object: window, index }, item), assign(index, bin("+", index, rl(1)))]) }),
    ];
  }
  /**
   * Rows of a rectangle whose every row lies in range (`inside`) run from offsets
   * that advance by their strides without clipping. Other rectangles, rarely drawn,
   * go to `otherwise`, a builtin that clips each row as copyRange or fillRange would.
   */
  rectRows(name: (base: string) => string, height: RustExpr, inside: RustExpr, offsets: { start: RustExpr; stride: RustExpr }[], row: (offsets: RustExpr[]) => RustStatement[], otherwise: RustExpr): RustStatement[] {
    const line = rp(name("line")), offset = (index: number) => rp(name(`offset${index}`));
    return [condition(inside, [
      let_(name("line"), rl(0, "i32"), true),
      ...offsets.map((o, index) => let_(name(`offset${index}`), cast(o.start, rt("usize")), true)),
      { kind: "while", condition: bin("<", line, height), body: rb([
        ...row(offsets.map((_, index) => offset(index))),
        ...offsets.map((o, index) => assign(offset(index), bin("+", offset(index), cast(o.stride, rt("usize"))))),
        assign(line, bin("+", line, rl(1))),
      ]) },
    ], rb([re(otherwise)]))];
  }
  /** Whether a `width` x `height` rectangle at `start` with a non-negative `stride` lies within the slice `within`. */
  rectInside(start: RustExpr, stride: RustExpr, width: RustExpr, height: RustExpr, within: RustExpr): RustExpr {
    const i64 = (value: RustExpr) => cast(value, rt("i64"));
    const end = bin("+", bin("+", i64(start), bin("*", i64(bin("-", height, rl(1))), i64(stride))), i64(width));
    return bin("&&", bin("&&", bin(">=", start, rl(0)), bin(">=", stride, rl(0))), bin(">=", i64(rm(within, "len")), end));
  }
  /** copyRect: copyRange for each row, read from a source that is not the target. */
  copyRect(place: RustExpr, element: AotType, source: RustExpr, to: RustExpr, toStride: RustExpr, from: RustExpr, fromStride: RustExpr, width: RustExpr, height: RustExpr, skip?: RustExpr): RustStatement[] {
    const id = this.serial++, name = (base: string) => `${base}_${id}`, target = rp(name("target"));
    const inside = bin("&&", bin("&&", bin("&&", bin(">", width, rl(0)), bin(">", height, rl(0))), this.rectInside(to, toStride, width, height, target)), this.rectInside(from, fromStride, width, height, source));
    return [
      let_(name("target"), ref(place, true), false, rr({ kind: "slice", element: this.type(element) }, true)),
      ...this.rectRows(name, height, inside, [{ start: to, stride: toStride }, { start: from, stride: fromStride }],
        ([at, start]) => [re(block(this.copyLoop(name, target, at!, source, start!, cast(width, rt("usize")), skip)))],
        rc(rp("microts", "builtins", "copy_rect"), target, to, toStride, source, from, fromStride, width, height, skip ? rc(rp("Some"), skip) : rp("None"))),
    ];
  }
  /** fillRect: fillRange for each row. */
  fillRect(place: RustExpr, element: AotType, start: RustExpr, stride: RustExpr, width: RustExpr, height: RustExpr, value: RustExpr): RustStatement[] {
    const id = this.serial++, name = (base: string) => `${base}_${id}`, target = rp(name("target"));
    const inside = bin("&&", bin("&&", bin(">", width, rl(0)), bin(">", height, rl(0))), this.rectInside(start, stride, width, height, target));
    return [
      let_(name("target"), ref(place, true), false, rr({ kind: "slice", element: this.type(element) }, true)),
      ...this.rectRows(name, height, inside, [{ start, stride }],
        ([at]) => [re(block(this.fillLoop(name, target, at!, cast(width, rt("usize")), element, value)))],
        rc(rp("microts", "builtins", "fill_rect"), target, start, stride, width, height, this.copy(element) ? value : rm(value, "clone"))),
    ];
  }
  copy(type: AotType): boolean {
    if (["number", "boolean", "style", "void", "undefined"].includes(type.kind)) return true;
    if (type.kind === "named") { const d = this.declarations.get(type.name); return d?.kind === "enum" || d?.kind === "newtype" && this.copy(d.base); }
    if (type.kind === "option") return this.copy(type.value);
    if (type.kind === "tuple") return type.elements.every(t => this.copy(t));
    return false;
  }
  primitive(type: AotType): boolean { const declaration = type.kind === "named" ? this.declarations.get(type.name) : undefined; return ["number", "boolean", "string", "style"].includes(type.kind) || declaration?.kind === "enum" || declaration?.kind === "newtype" && this.primitive(declaration.base); }
  scalarType(type: AotType): AotType { const declaration = type.kind === "named" ? this.declarations.get(type.name) : undefined; return declaration?.kind === "newtype" ? this.scalarType(declaration.base) : type; }
  unwrapScalar(value: RustExpr, type: AotType): RustExpr { const declaration = type.kind === "named" ? this.declarations.get(type.name) : undefined; return declaration?.kind === "newtype" ? this.unwrapScalar(rf(value, 0), declaration.base) : value; }
  wrapScalar(value: RustExpr, type: AotType): RustExpr { const declaration = type.kind === "named" ? this.declarations.get(type.name) : undefined; return declaration?.kind === "newtype" ? rc(rp(type.kind === "named" ? type.name : declaration.name), this.wrapScalar(value, declaration.base)) : value; }
  /** A heapless::Vec with room for `capacity` elements, filled from `values`. */
  bounded(values: RustExpr, element: AotType, capacity: number, name: string): RustExpr {
    return rc({ kind: "path", path: ["microts", "model", "bounded_array"], typeArgs: [this.type(element), { kind: "const", value: capacity }] }, values, rl(name));
  }
  /** A reference to a value of `type`, borrowed as its scalar when `type` is a newtype. */
  scalarRef(reference: RustExpr, type: AotType): RustExpr { return this.scalarType(type) === type ? reference : ref(this.unwrapScalar(reference, type)); }
  displayValue(value: RustExpr, type: AotType): RustExpr { const base = this.scalarType(type); return base.kind === "number" && base.name === "f32" ? cast(this.unwrapScalar(value, type), rt("f64")) : value; }
  own(value: RustExpr, type: AotType) { return this.copy(type) ? value : rm(value, "clone"); }
  type(type: AotType, borrowed = false, capacity?: number): RustType {
    capacity ??= "capacity" in type ? type.capacity : undefined;
    switch (type.kind) {
      case "number": return rt(type.name);
      case "boolean": return rt("bool");
      case "void": return unit;
      case "undefined": return rt("Option", unit);
      case "style": return rt("microts::StyleId");
      case "string": return borrowed ? rr(rt("str")) : capacity !== undefined ? rt("heapless::String", { kind: "const", value: capacity }) : rt("String");
      case "array": {
        const inner = type.length !== undefined ? { kind: "array", element: this.type(type.element), length: type.length } as RustType : borrowed ? { kind: "slice", element: this.type(type.element) } as RustType : capacity !== undefined ? rt("heapless::Vec", this.type(type.element), { kind: "const", value: capacity }) : rt("Vec", this.type(type.element));
        return borrowed ? rr(inner) : inner;
      }
      case "option": return rt("Option", this.type(type.value, borrowed));
      case "tuple": return { kind: "tuple", elements: type.elements.map(t => this.type(t, borrowed)) };
      case "named": return borrowed && !this.copy(type) ? rr(rt(type.name)) : rt(type.name);
    }
  }
  borrowed(value: RustExpr, type: AotType): RustExpr {
    if (type.kind === "string") return rm(value, "as_str");
    if (type.kind === "array") return ref(value);
    if (type.kind === "named" && !this.copy(type)) return ref(value);
    if (type.kind === "option" && !this.copy(type.value)) return rm(rm(value, "as_ref"), "map", { kind: "closure", params: [rn("value")], body: type.value.kind === "named" ? rp("value") : this.borrowed(rp("value"), type.value) });
    return value;
  }
  defaultValue(type: AotType): RustExpr {
    if (type.kind === "tuple") return { kind: "tuple", elements: type.elements.map(type => this.defaultValue(type)) };
    if (type.kind === "named") {
      const d = this.declarations.get(type.name);
      if (d?.kind === "struct") return { kind: "struct", path: [d.name], fields: d.fields.map(f => ({ name: f.name, value: this.defaultValue(f.type) })) };
      if (d?.kind === "enum") return rp(d.name, rustVariant(d.variants[0]!));
      if (d?.kind === "union") { const v = d.variants[0]!; return { kind: "struct", path: [d.name, rustVariant(v.name)], fields: v.fields.map(f => ({ name: f.name, value: this.defaultValue(f.type) })) }; }
      if (d?.kind === "newtype") return rc(rp(d.name), this.defaultValue(d.base));
    }
    return rc(rp("Default", "default"));
  }
  coerce(e: ModelExpr, type: AotType, name = "value", capacity?: number): RustExpr {
    capacity ??= "capacity" in type ? type.capacity : undefined;
    const storage = this.sourceType(e);
    if (type.kind === "option" && storage.kind !== "option" && e.kind !== "undefined") return rc(rp("Some"), this.coerce({ ...e, type: storage }, type.value, name, capacity));
    const value = this.expr(e, capacity, name);
    const sourceType = this.sourceType(e), source = "capacity" in sourceType ? sourceType.capacity : undefined;
    const contextual = ["literal", "binary", "template", "array", "constant"].includes(e.kind) || e.kind === "builtin" && e.name !== "copy";
    const actual = contextual ? capacity ?? source : source;
    if (type.kind === "string" && actual !== capacity) return capacity === undefined
      ? rm(rm(value, "as_str"), "to_owned")
      : rc({ kind: "path", path: ["microts", "model", "bounded_string"], typeArgs: [{ kind: "const", value: capacity }] }, ref(value), rl(name));
    if (type.kind === "array" && type.length === undefined && actual !== capacity) return capacity === undefined
      ? { kind: "method", object: rm(value, "into_iter"), method: "collect", args: [], typeArgs: [this.type(type)] }
      : rc({ kind: "path", path: ["microts", "model", "bounded_array"], typeArgs: [this.type(type.element), { kind: "const", value: capacity }] }, value, rl(name));
    return value;
  }
  sourceType(e: ModelExpr): AotType {
    if (e.kind === "local") return this.binders.get(e.id)?.type ?? this.task?.fields.find(field => field.id === e.id)?.type ?? this.current.params.find(param => param.id === e.id)?.type ?? e.type;
    if (e.kind === "signal" || e.kind === "memo" || e.kind === "field") return [...this.current.signals, ...this.current.memos, ...this.current.fields].find(field => field.id === e.id)?.type ?? e.type;
    if (e.kind === "copy" || e.kind === "sequence") return this.sourceType(e.value);
    if (e.kind === "invoke") return this.functions.get(e.callee)?.returns ?? e.type;
    if (e.kind === "builtin" && e.name === "String") return { kind: "string" };
    if (e.kind === "member") {
      const source = this.sourceType(e.object), type = source.kind === "option" ? source.value : source, declaration = type.kind === "named" ? this.declarations.get(type.name) : undefined;
      const fields = declaration?.kind === "struct" ? declaration.fields : declaration?.kind === "union" ? declaration.variants.flatMap(variant => variant.fields) : [];
      return fields.find(field => field.name === e.name)?.type ?? e.type;
    }
    if (e.kind === "index") { const type = this.sourceType(e.object); return type.kind === "array" ? type.element : e.type; }
    return e.type;
  }
  expressionBody(body: ModelBlock, type: AotType): RustStatement[] {
    const previous = this.returnType; this.returnType = type; this.expressionScope++;
    try { return this.statements(body); } finally { this.returnType = previous; this.expressionScope--; }
  }
  expr(e: ModelExpr, capacity?: number, capacityName = "value"): RustExpr {
    capacity ??= "capacity" in e.type ? e.type.capacity : undefined;
    if (e.type.kind === "option" && ["literal", "struct", "array"].includes(e.kind)) return rc(rp("Some"), this.expr({ ...e, type: e.type.value }, capacity, capacityName));
    switch (e.kind) {
      case "literal": {
        if (e.type.kind === "named") { const d = this.declarations.get(e.type.name); if (d?.kind === "enum") return rp(d.name, rustVariant(String(e.value))); if (d?.kind === "newtype") return rc(rp(d.name), d.unit === "Color" ? rl(parseMicroTsColor(String(e.value)), "u32") : this.expr({ ...e, type: d.base })); }
        if (typeof e.value === "string") return capacity === undefined ? rc(rp("String", "from"), rl(e.value)) : rc({ kind: "path", path: ["microts", "model", "bounded_string"], typeArgs: [{ kind: "const", value: capacity }] }, rl(e.value), rl(capacityName));
        const raw = e.rawNumber === undefined ? undefined : exactIntegerLiteral(e.rawNumber) ?? e.rawNumber.replaceAll("_", "").replace(/^\./, "0.").replace(/\.$/, ".0");
        return rl(e.value, e.type.kind === "number" ? e.type.name : undefined, raw);
      }
      case "undefined": return rp("None");
      case "local": case "signal": case "field": return this.own(this.storage(e.id), e.type);
      case "memo": return this.mutable ? rm(self, `read_${e.id}`) : this.own(this.storage(e.id), e.type);
      case "member": {
        const base = e.object.type.kind === "option" ? e.object.type.value : e.object.type;
        const declaration = base.kind === "named" ? this.declarations.get(base.name) : undefined;
        const memberType = e.optional && e.type.kind === "option" ? e.type.value : e.type;
        const extract = (object: RustExpr): RustExpr => {
          if (declaration?.kind === "union" && e.name === declaration.discriminant) return { kind: "match", value: object, arms: declaration.variants.map(variant => ({ pattern: { kind: "variant", path: [declaration.name, rustVariant(variant.name)], fields: [], rest: true }, body: this.expr({ kind: "literal", value: variant.name, type: memberType, ledger: e.ledger, loc: e.loc }) })) };
          if (declaration?.kind === "union") {
            const variants = declaration.variants.filter(variant => (!e.variant || variant.name === e.variant) && variant.fields.some(field => field.name === e.name));
            return { kind: "match", value: object, arms: [...variants.map(variant => ({ pattern: { kind: "variant" as const, path: [declaration.name, rustVariant(variant.name)], fields: [{ name: e.name, pattern: rn("value") }], rest: true }, body: rp("value") })), ...(variants.length === declaration.variants.length ? [] : [{ pattern: { kind: "wildcard" as const }, body: { kind: "macro" as const, name: ["unreachable"], args: [rl("checked union narrowing")] } }])] };
          }
          return this.own(rf(object, e.name), memberType);
        };
        // A field below an element, such as items[i].x, is read in place rather than
        // after copying the element.
        const chain = declaration?.kind === "struct" && e.object.type.kind !== "option" && !this.borrow(e.object) ? this.readChain(e) : undefined;
        if (chain) {
          // An optional field reads as undefined when the element is missing too.
          const value = rm(chain.value, "cloned");
          return block(chain.statements, e.type.kind === "option" ? rm(value, "flatten") : rm(value, "unwrap_or_else", { kind: "closure", params: [], body: this.defaultValue(e.type) }));
        }
        const object = declaration?.kind === "struct" && e.object.type.kind !== "option" ? this.borrow(e.object) ?? this.expr(e.object) : this.expr(e.object);
        if (e.object.type.kind === "option") return e.optional
          ? rm(object, "map", { kind: "closure", params: [rn("value")], body: extract(rp("value")) })
          : extract(rm(object, "expect", rl("checked option narrowing")));
        return extract(object);
      }
      case "index": {
        const chain = this.readChain(e);
        if (chain) {
          const value = rm(chain.value, "cloned");
          return block(chain.statements, e.type.kind === "option" ? value : rm(value, "unwrap_or_else", { kind: "closure", params: [], body: this.defaultValue(e.type) }));
        }
        const value = rm(rm(this.expr(e.object), "get", cast(this.expr(e.index), rt("usize"))), "cloned");
        return e.type.kind === "option" ? value : rm(value, "unwrap_or_else", { kind: "closure", params: [], body: this.defaultValue(e.type) });
      }
      case "copy": return this.expr(e.value, capacity, capacityName);
      case "cast": {
        if (e.type.kind === "option") return e.value.type.kind === "option" ? this.expr(e.value) : rc(rp("Some"), this.coerce(e.value, e.type.value));
        const sourceType = e.value.type.kind === "option" ? e.value.type.value : e.value.type;
        const source = e.value.type.kind === "option" ? rm(this.expr(e.value), "expect", rl("checked option narrowing")) : this.expr(e.value);
        const value = this.unwrapScalar(source, sourceType), type = this.scalarType(e.type);
        return this.wrapScalar(type.kind === "number" ? cast(value, this.type(type)) : value, e.type);
      }
      case "unary": {
        if (e.operator === "+") return this.expr(e.operand);
        const value = this.unwrapScalar(this.expr(e.operand), e.operand.type), type = this.scalarType(e.type);
        return this.wrapScalar(e.operator === "-" && type.kind === "number" && !type.name.startsWith("f") ? rm(value, "wrapping_neg") : { kind: "unary", operator: e.operator === "~" ? "!" : e.operator, expr: value }, e.type);
      }
      case "binary": {
        if (e.operator === "??") return rm(this.expr(e.left), "unwrap_or_else", { kind: "closure", params: [], body: this.expr(e.right) });
        if (["&&", "||"].includes(e.operator)) return bin(e.operator, this.expr(e.left), this.expr(e.right));
        const id = this.serial++, left = rp(`left_${id}`), right = rp(`right_${id}`);
        const type = this.scalarType(e.type), scalarLeft = this.unwrapScalar(left, e.left.type), scalarRight = this.unwrapScalar(right, e.right.type);
        let result: RustExpr;
        if (e.operator === "+" && type.kind === "string") {
          const textLeft = this.displayValue(left, e.left.type), textRight = this.displayValue(right, e.right.type);
          result = capacity === undefined ? rc(rp("microts", "model", "concat"), ref(textLeft), ref(textRight)) : rc({ kind: "path", path: ["microts", "model", "bounded_concat"], typeArgs: [{ kind: "const", value: capacity }] }, ref(textLeft), ref(textRight), rl(capacityName));
        } else if (e.operator === "/" && type.kind === "number") {
          result = bin("/", cast(scalarLeft, this.type(type)), cast(scalarRight, this.type(type)));
        } else if (e.operator === "%" && type.kind === "number" && !type.name.startsWith("f")) {
          result = rc(rp("microts", "builtins", "imod"), scalarLeft, scalarRight);
        } else if (["<<", ">>", ">>>"].includes(e.operator) && type.kind === "number" && ["i8", "u8", "i16", "u16"].includes(type.name)) {
          // 8- and 16-bit integers shift as 32-bit values, as in JavaScript, then wrap to their width.
          const wide = e.operator === ">>>" ? cast(cast(scalarLeft, rt(type.name.replace("i", "u"))), rt("u32")) : cast(scalarLeft, rt("i32"));
          result = cast(rm(wide, e.operator === "<<" ? "wrapping_shl" : "wrapping_shr", cast(scalarRight, rt("u32"))), rt(type.name));
        } else if (e.operator === ">>>" && type.kind === "number" && !type.name.startsWith("f")) {
          const unsigned = ({ i8: "u8", i16: "u16", i32: "u32", i64: "u64" } as Record<string, string>)[type.name] ?? type.name;
          result = cast(rm(cast(scalarLeft, rt(unsigned)), "wrapping_shr", cast(scalarRight, rt("u32"))), rt(type.name));
        } else if (type.kind === "number" && !type.name.startsWith("f") && ["+", "-", "*", "<<", ">>"].includes(e.operator)) {
          result = rm(scalarLeft, ({ "+": "wrapping_add", "-": "wrapping_sub", "*": "wrapping_mul", "<<": "wrapping_shl", ">>": "wrapping_shr" })[e.operator]!, ["<<", ">>"].includes(e.operator) ? cast(scalarRight, rt("u32")) : scalarRight);
        } else if (["<", ">", "<=", ">="].includes(e.operator) && e.left.type.kind === "string") result = bin(e.operator, rc(rp("microts", "builtins", "string_compare"), ref(left), ref(right)), rl(0));
        else result = bin(e.operator === "===" ? "==" : e.operator === "!==" ? "!=" : e.operator, scalarLeft, scalarRight);
        if (type.kind === "number" || type.kind === "string") result = this.wrapScalar(result, e.type);
        return block([let_(`left_${id}`, this.expr(e.left, capacity, capacityName)), let_(`right_${id}`, this.expr(e.right, capacity, capacityName))], result);
      }
      case "conditional": return { kind: "if", condition: this.expr(e.condition), then: rb([], this.expr(e.consequent, capacity, capacityName)), otherwise: rb([], this.expr(e.alternate, capacity, capacityName)) };
      case "template": {
        const name = `text_${this.serial++}`, statements: RustStatement[] = [let_(name, capacity === undefined ? rc(rp("String", "new")) : rc({ kind: "qualifiedPath", type: this.type({ kind: "string" }, false, capacity), member: "new" }), true)];
        for (const part of e.parts) statements.push(re(rc(rp("microts", "model", capacity === undefined ? "append_display" : "append_bounded_display"), ref(rp(name), true), ref(typeof part === "string" ? rl(part) : this.displayValue(this.expr(part), part.type)), ...(capacity === undefined ? [] : [rl(capacityName)]))));
        return block(statements, rp(name));
      }
      case "struct": {
        const declaration = this.declarations.get(e.name), discriminant = declaration?.kind === "union" ? declaration.discriminant : undefined;
        const tag = discriminant ? e.fields.find(field => field.name === discriminant)?.value : undefined;
        const variant = e.variant ?? (tag?.kind === "literal" ? String(tag.value) : undefined);
        if (declaration?.kind === "union" && !variant) throw new Error(`Union value ${e.name} requires a known discriminant`);
        const fields = declaration?.kind === "struct" ? declaration.fields : declaration?.kind === "union" ? declaration.variants.find(item => item.name === variant)?.fields : undefined;
        // Optional fields a literal leaves out are None.
        const given = new Set(e.fields.map(field => field.name)), omitted = (fields ?? []).filter(field => !given.has(field.name) && field.name !== discriminant && field.type.kind === "option");
        return { kind: "struct", path: variant ? [e.name, rustVariant(variant)] : [e.name], fields: [...e.fields.filter(field => field.name !== discriminant).map(field => ({ name: field.name, value: this.coerce(field.value, fields?.find(item => item.name === field.name)?.type ?? field.value.type, field.name) })), ...omitted.map(field => ({ name: field.name, value: rp("None") }))] };
      }
      case "array": return e.type.kind === "array" && e.type.length !== undefined ? { kind: "array", elements: e.items.map(item => this.expr(item)) } : capacity !== undefined ? rc({ kind: "path", path: ["microts", "model", "bounded_array"], typeArgs: [this.type(e.element), { kind: "const", value: capacity }] }, { kind: "array", elements: e.items.map(item => this.expr(item)) }, rl(capacityName)) : { kind: "macro", name: ["alloc", "vec"], args: e.items.map(item => this.expr(item)) };
      case "invoke": return this.invoke(e.callee, e.args);
      case "builtin": return this.builtin(e, capacity, capacityName);
      case "lambda": return { kind: "closure", params: e.params.map(p => rn(this.name(p.id))), body: block(this.expressionBody(e.body, e.type)) };
      case "sequence": {
        // A body without return is a plain block; a return needs the closure boundary.
        const value = block(this.expressionBody(e.body, e.type), this.expr(e.value, capacity, capacityName));
        return this.returns(e.body) ? rc({ kind: "closure", params: [], body: value }) : value;
      }
      // A static constant copied where a Cap array is expected fills bounded storage.
      case "constant": {
        const constant = rp(this.constantName(e.id));
        if (e.type.kind === "array" && e.type.length !== undefined) return constant;
        return capacity !== undefined && e.type.kind === "array" ? this.bounded(rm(rm(constant, "iter"), "cloned"), e.type.element, capacity, capacityName) : rm(constant, "to_vec");
      }
      case "mutate": return this.mutate(e);
    }
  }
  invoke(id: number, args: ModelExpr[]): RustExpr {
    const module = this.modules.get(id), func = this.functions.get(id);
    if (!func || !module) throw new Error(`Unknown model function ${id}`);
    const callArgs = args.map((arg, index) => this.coerce(arg, func.params[index]!.type, func.params[index]!.name, func.params[index]!.capacity));
    if (module.kind === "pure") return rc(rp(`pure_${id}`), this.current.kind === "pure" ? rp("depth") : ref(field("depth")), ...callArgs);
    if (func.async) return rm(self, `start_${id}`, ...callArgs);
    return rm(self, `${this.mutable ? "fn" : "render_fn"}_${id}`, ...callArgs);
  }
  /**
   * A built-in call. map, filter and String build bounded storage themselves; the other
   * built-ins that return an array or a string are bounded where a Cap type is expected.
   */
  builtin(e: Extract<ModelExpr, { kind: "builtin" }>, capacity?: number, capacityName = "value"): RustExpr {
    const value = this.builtinValue(e, capacity, capacityName);
    if (capacity === undefined || ["map", "filter", "String", "copy"].includes(e.name)) return value;
    if (e.type.kind === "array" && e.type.length === undefined) return this.bounded(value, e.type.element, capacity, capacityName);
    if (e.type.kind === "string") return rc({ kind: "path", path: ["microts", "model", "bounded_string"], typeArgs: [{ kind: "const", value: capacity }] }, ref(value), rl(capacityName));
    return value;
  }
  builtinValue(e: Extract<ModelExpr, { kind: "builtin" }>, capacity?: number, capacityName = "value"): RustExpr {
    const args = e.args.map(arg => this.expr(arg));
    if (e.name === "copy") return args[0]!;
    if (e.name === "equals") return bin("==", args[0]!, args[1]!);
    if (e.name === "String") {
      const value = this.displayValue(args[0]!, e.args[0]!.type);
      if (capacity === undefined) return rc(rp("microts", "model", "to_string"), ref(value));
      const name = `text_${this.serial++}`;
      return block([let_(name, rc({ kind: "qualifiedPath", type: this.type({ kind: "string" }, false, capacity), member: "new" }), true), re(rc(rp("microts", "model", "append_bounded_display"), ref(rp(name), true), ref(value), rl(capacityName)))], rp(name));
    }
    if (e.name === "len") {
      const place = this.borrow(e.args[0]!), chain = place ? undefined : this.readChain(e.args[0]!), type = e.args[0]!.type;
      // An element is measured in place rather than cloned first; a string newtype by its string.
      if (chain) return block(chain.statements, rm(rm(chain.value, "map", { kind: "closure", params: [rn("value")], body: rc(rp("microts", "builtins", "len"), this.scalarRef(rp("value"), type)) }), "unwrap_or", rl(0, "i32")));
      return rc(rp("microts", "builtins", "len"), ref(this.unwrapScalar(place ?? args[0]!, type)));
    }
    // usize converts as u32 on every target, as the JavaScript backends do.
    if (e.name === "usize") return cast(cast(this.unwrapScalar(args[0]!, e.args[0]!.type), rt("u32")), rt("usize"));
    if ((MICROTS_NUMERIC_TYPES as readonly string[]).includes(e.name)) return cast(this.unwrapScalar(args[0]!, e.args[0]!.type), rt(e.name));
    if (e.name === "fill") return rc(rp("microts", "builtins", "fill"), args[0]!, args[1]!);
    if (e.name === "embedBytes") return rm({ kind: "macro", name: ["include_bytes"], args: [this.embeddedPath(e)] }, "to_vec");
    if (e.name === "codePoints") {
      // The string is read in place, like len()'s argument.
      const place = this.borrow(e.args[0]!), chain = place ? undefined : this.readChain(e.args[0]!), type = e.args[0]!.type;
      if (chain) return block(chain.statements, rm(rm(chain.value, "map", { kind: "closure", params: [rn("value")], body: rc(rp("microts", "builtins", "code_points"), this.scalarRef(rp("value"), type)) }), "unwrap_or_default"));
      return rc(rp("microts", "builtins", "code_points"), ref(this.unwrapScalar(place ?? args[0]!, type)));
    }
    if (e.name === "fromCodePoint") return rc(rp("microts", "builtins", "from_code_point"), args[0]!);
    if (["map", "filter", "find", "some"].includes(e.name)) {
      const collection = `items_${this.serial++}`, closure = e.args[1];
      if (closure?.kind !== "lambda") throw new Error(`${e.name} requires a bound lambda`);
      const body = this.expressionBody(closure.body, closure.type), parameter = this.name(closure.params[0]!.id), statements = [let_(collection, args[0]!)];
      const indexed = closure.params[1], argument = `index_${this.serial++}`;
      const borrowed = e.name === "filter" || e.name === "find";
      const prefix = [...(borrowed ? [let_(parameter, rm(rp(parameter), "clone"))] : []), ...(indexed ? [let_(this.name(indexed.id), cast(borrowed ? { kind: "unary", operator: "*", expr: rp(argument) } : rp(argument), this.type(indexed.type)))] : [])];
      const closureExpr: RustExpr = { kind: "closure", params: [indexed ? { kind: "tuple", elements: [rn(argument), rn(parameter)] } : rn(parameter)], body: block([...prefix, ...body]) };
      let iter = rm(rp(collection), "into_iter");
      if (indexed) iter = rm(iter, "enumerate");
      if (e.name === "some") return block(statements, rm(iter, "any", closureExpr));
      iter = rm(iter, e.name, closureExpr);
      if (indexed && borrowed) iter = rm(iter, "map", { kind: "closure", params: [{ kind: "tuple", elements: [{ kind: "wildcard" }, rn("value")] }], body: rp("value") });
      if (e.name !== "find" && e.type.kind === "array" && capacity !== undefined) return block(statements, rc({ kind: "path", path: ["microts", "model", "bounded_array"], typeArgs: [this.type(e.type.element), { kind: "const", value: capacity }] }, iter, rl(capacityName)));
      return block(statements, e.name === "find" ? iter : { kind: "method", object: iter, method: "collect", args: [], typeArgs: [this.type(e.type)] });
    }
    return this.wrapScalar(rc(rp("microts", "builtins", e.name), ...args.map((arg, index) => this.unwrapScalar(arg, e.args[index]!.type))), e.type);
  }
  statements(body: ModelBlock): RustStatement[] { return body.stmts.flatMap(stmt => this.statement(stmt)); }
  /** Ids of the locals and parameters a block assigns or changes in place. */
  assignedIds(body: ModelBlock): Set<number> {
    const ids = new Set<number>();
    const walk = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) { value.forEach(walk); return; }
      const node = value as Record<string, any>;
      if ((node.kind === "assign" || node.kind === "mutate") && node.target) {
        const t = node.target as ModelTarget;
        ids.add(t.kind === "path" ? t.root.id : "id" in t ? t.id : t.owner);
      }
      for (const [key, child] of Object.entries(value)) if (key !== "loc" && key !== "ledger" && key !== "type") walk(child);
    };
    walk(body);
    return ids;
  }
  /**
   * Whether a block never completes: it ends in a return, in branches that all end
   * in one, or in a loop on the literal true that nothing breaks.
   */
  diverges(body: ModelBlock): boolean {
    const last = body.stmts.at(-1);
    if (!last) return false;
    switch (last.kind) {
      case "return": return true;
      case "if": return !!last.else && this.diverges(last.then) && this.diverges(last.else);
      case "switch": return last.cases.some(c => !c.value) && last.cases.every(c => this.diverges(c.body));
      case "batch": case "untrack": return this.diverges(last.body);
      case "while": {
        let broken = false;
        const walk = (value: unknown): void => {
          if (broken || !value || typeof value !== "object") return;
          if (Array.isArray(value)) { value.forEach(walk); return; }
          const node = value as { kind?: string; loop?: number };
          if (node.kind === "break" && node.loop === last.loop) { broken = true; return; }
          if (node.kind === "lambda") return;
          for (const [key, child] of Object.entries(value)) if (!["loc", "ledger", "type"].includes(key)) walk(child);
        };
        walk(last.body);
        if (broken) return false;
        const forever = last.condition.kind === "literal" && last.condition.value === true;
        return forever || !!last.post && this.diverges(last.body) && !this.continued.has(last.loop);
      }
      default: return false;
    }
  }
  /** Whether a block contains a return outside nested lambdas. */
  returns(body: ModelBlock): boolean {
    let found = false;
    const walk = (value: unknown): void => {
      if (found || !value || typeof value !== "object") return;
      if (Array.isArray(value)) { value.forEach(walk); return; }
      const node = value as { kind?: string };
      if (node.kind === "return") { found = true; return; }
      if (node.kind === "lambda") return;
      for (const [key, child] of Object.entries(value)) if (!["loc", "ledger", "type"].includes(key)) walk(child);
    };
    walk(body);
    return found;
  }
  /**
   * Lowers a loop body. A loop reached by break or continue gets a label; when code
   * follows the body in each iteration, continue leaves a labeled block around the body.
   */
  loopBody(id: number | undefined, body: ModelBlock, trailing: boolean): { label?: string; statements: RustStatement[] } {
    if (id === undefined) return { statements: this.statements(body) };
    const labels = { loop: `loop_${id}`, ...(trailing && this.continued.has(id) ? { body: `body_${id}` } : {}) };
    this.loopLabels.set(id, labels);
    const statements = this.statements(body);
    return { label: labels.loop, statements: labels.body ? [re({ kind: "block", label: labels.body, block: rb(statements) })] : statements };
  }
  statement(s: ModelStmt): RustStatement[] {
    switch (s.kind) {
      case "let": this.binders.set(s.binder.id, s.binder); return this.task?.fields.some(p => p.id === s.binder.id) ? [assign(this.storage(s.binder.id), this.coerce(s.init, s.binder.type, s.binder.name, s.binder.capacity))] : [let_(this.name(s.binder.id), this.coerce(s.init, s.binder.type, s.binder.name, s.binder.capacity), true, this.type(s.binder.type, false, s.binder.capacity))];
      case "assign": {
        const metadata = (id: number) => this.binders.get(id) ?? this.task?.fields.find(field => field.id === id) ?? [...this.current.fields, ...this.current.params].find(field => field.id === id);
        if (s.target.kind === "element") {
          const index = `index_${this.serial++}`, value = `element_${this.serial++}`;
          const owner = metadata(s.target.owner), type = owner?.type.kind === "array" ? owner.type.element : s.value.type;
          return [let_(index, this.expr(s.target.index)), let_(value, this.coerce(s.value, type, owner?.name)), re({ kind: "ifLet", pattern: { kind: "variant", path: ["Some"], tuple: [rn("element")] }, value: rm(this.storage(s.target.owner), "get_mut", cast(rp(index), rt("usize"))), then: rb([assign({ kind: "unary", operator: "*", expr: rp("element") }, rp(value))]) })];
        }
        if (s.target.kind === "path") {
          const target = s.target, value = `value_${this.serial++}`;
          const type = target.steps.reduce((type, step) => this.stepType(type, step), this.rootType(target.root.id));
          const indexes = target.steps.filter(step => step.kind === "index").length;
          // Evaluate index operands, then the value, then borrow the place.
          const statements = this.withPlace(target, place => [assign(place, rp(value))]);
          statements.splice(indexes, 0, let_(value, this.coerce(s.value, type, target.steps.at(-1)?.kind === "member" ? (target.steps.at(-1) as { name: string }).name : undefined)));
          return statements;
        }
        const t = s.target, target = "id" in t ? this.storage(t.id) : rf(this.storage(t.owner), t.name);
        const binder = "id" in t ? metadata(t.id) : undefined, owner = t.kind === "member" ? metadata(t.owner) : undefined;
        const declaration = owner?.type.kind === "named" ? this.declarations.get(owner.type.name) : undefined;
        const member = t.kind === "member" && declaration?.kind === "struct" ? declaration.fields.find(field => field.name === t.name) : undefined;
        return [assign(target, binder ? this.coerce(s.value, binder.type, binder.name, binder.capacity) : member ? this.coerce(s.value, member.type, member.name) : this.expr(s.value))];
      }
      case "set": {
        const signal = this.signal(s.signal), prefix = s.pre ? [let_(this.name(s.pre.id), this.own(this.storage(s.signal), signal.type))] : [];
        if (s.writeBack) return [...prefix, this.trace("set", signal.id, signal.name, rm(this.storage(signal.id), "model_value"), { changed: rl(false), version: field(`version_${signal.id}`) })];
        const valueName = `write_${this.serial++}`;
        return [...prefix, let_(valueName, this.coerce(s.value, signal.type, signal.name, signal.capacity)), re(rm(self, `write_${s.signal}`, rp(valueName)))];
      }
      case "if": return [condition(this.expr(s.condition), this.statements(s.then), s.else ? rb(this.statements(s.else)) : undefined)];
      case "untrack": case "batch": return [re(block(this.statements(s.body)))];
      case "for": return this.withRows([s], () => {
        const bound = `bound_${this.serial++}`, index = this.name(s.binder.id);
        const body = this.loopBody(s.loop, s.body, true);
        return [let_(index, s.start ? this.expr(s.start) : rl(0, "i32"), true), let_(bound, this.expr(s.bound)), { kind: "while", condition: bin(s.inclusive ? "<=" : "<", rp(index), rp(bound)), label: body.label, body: rb([work("LoopIteration"), ...body.statements, ...(s.inclusive ? [condition(bin("==", rp(index), rp(bound)), [{ kind: "break" }])] : []), assign(rp(index), rm(rp(index), "wrapping_add", rl(1)))]) }];
      });
      case "forOf": return this.withRows([s], () => { const body = this.loopBody(s.loop, s.body, false); return [{ kind: "for", pattern: rn(this.name(s.binder.id)), iterable: this.expr(s.source), label: body.label, body: rb([work("LoopIteration"), ...body.statements]) }]; });
      case "while": return this.withRows([s], () => {
        const body = this.loopBody(s.loop, s.body, !!s.update || !!s.post), update = s.update ? this.statements(s.update) : [];
        // A loop on the literal true is a Rust loop, which ends only by break or return, so
        // a function that returns from inside it type-checks as TypeScript's does.
        const forever = s.condition.kind === "literal" && s.condition.value === true;
        if (forever) return [{ kind: "loop", label: body.label, body: rb([work("LoopIteration"), ...body.statements, ...update]) }];
        // A do-while body that always returns, with no continue, never reaches its condition.
        const checked = !(this.diverges(s.body) && !this.continued.has(s.loop));
        if (s.post) return [{ kind: "loop", label: body.label, body: rb([work("LoopIteration"), ...body.statements, ...(checked ? [condition({ kind: "unary", operator: "!", expr: this.expr(s.condition) }, [{ kind: "break" }])] : [])]) }];
        return [{ kind: "while", condition: this.expr(s.condition), label: body.label, body: rb([work("LoopIteration"), ...body.statements, ...update]) }];
      });
      case "break": return [{ kind: "break", label: this.loopLabels.get(s.loop)!.loop }];
      case "continue": { const labels = this.loopLabels.get(s.loop)!; return [labels.body ? { kind: "break", label: labels.body } : { kind: "continue", label: labels.loop }]; }
      case "switch": {
        const value = `switch_${this.serial++}`;
        let next: RustBlock = rb();
        for (const arm of [...s.cases].reverse()) next = arm.value ? rb([condition(bin("==", rp(value), this.expr(arm.value)), this.statements(arm.body), next)]) : rb(this.statements(arm.body));
        return [let_(value, this.expr(s.value)), ...next.statements];
      }
      case "return": {
        if (this.task && !this.expressionScope) return [re(rm(field(`task_${this.task.id}`), "finish", this.taskReturn(s.value), ref(field("outcomes"), true))), { kind: "return" }];
        if (s.value && this.returnType?.kind === "void") return [re(this.expr(s.value)), { kind: "return" }];
        return [{ kind: "return", value: s.value ? this.returnType ? this.coerce(s.value, this.returnType) : this.expr(s.value) : undefined }];
      }
      case "call": return [re(this.invoke(s.callee, s.args))];
      case "expr": return [re(this.expr(s.value))];
      case "external": {
        if (s.op === "log") {
          const name = `log_${this.serial++}`;
          const args = s.args.map((arg, index) => ({ name: `${name}_${index}`, value: this.expr(arg), type: arg.type }));
          return [...args.map(arg => let_(arg.name, arg.value)), condition({ kind: "macro", name: ["cfg"], args: [rp("debug_assertions")] }, [
            this.trace("command", 0, "log", rc(rp("Value", "Array"), { kind: "macro", name: ["alloc", "vec"], args: args.map(arg => rm(rp(arg.name), "model_value")) })),
            let_(name, rc(rp("String", "new")), true), ...args.flatMap((arg, index) => [...(index ? [re(rm(rp(name), "push_str", rl(" ")))] : []), re(rc(rp("microts", "model", "append_display"), ref(rp(name), true), ref(this.displayValue(rp(arg.name), arg.type))))]), re(rm(field("commands"), "push", rc(rp("Cmd", "Log"), rp(name)))),
          ])];
        }
        if (s.op === "cancel") return s.args.map(arg => re(rm(self, `cancel_${arg.kind === "literal" ? arg.value : "id" in arg ? arg.id : 0}`)));
        if (s.op === "animate" || s.op === "jump") return [this.commandTrace(s.op, s.args), re(rm(field("commands"), "push", this.animation(s.op, s.args)))];
        throw new Error(`Model Rust external ${s.op} is not implemented`);
      }
      case "start": return [re(rm(self, `start_${this.current.tasks.find(t => t.id === s.task)?.fn ?? s.task}`, ...s.args.map(arg => this.expr(arg))))];
      case "await": throw new Error("Unlowered await reached Model Rust generation");
    }
  }
  function(func: ModelFunction, render = false): RustFunction {
    const previous = this.mutable, previousReturn = this.returnType; this.mutable = !render; this.returnType = func.returns;
    for (const parameter of func.params) this.binders.set(parameter.id, parameter);
    const depth = this.current.kind === "pure" ? rp("depth") : field("depth");
    const body = this.statements(func.body);
    // Falling off the end returns undefined, which is None for an undefined or optional return
    // type. For other return types TypeScript has found the end unreachable, and a body whose
    // end Rust cannot see as unreachable ends in unreachable!().
    const tail: RustExpr | undefined = func.returns.kind === "void" || this.diverges(func.body) ? undefined : func.returns.kind === "option" || func.returns.kind === "undefined" ? rp("None") : { kind: "macro", name: ["unreachable"], args: [rl(`${func.name} returns on every path`)] };
    const expression: RustExpr = rc({ kind: "closure", params: [], body: block(body, tail) });
    // Parameters the body assigns or changes in place are declared mut.
    const assigned = this.assignedIds(func.body);
    const params = func.params.map(p => ({ pattern: rn(this.name(p.id), assigned.has(p.id)), type: this.type(p.type, false, p.capacity) }));
    const result = fn(this.current.kind === "pure" ? `pure_${func.id}` : `${render ? "render_fn" : "fn"}_${func.id}`, [ ...(this.current.kind === "pure" ? [param("depth", rr(rt("Depth")))] : [receiver(!render)]), ...params ], rb([re(rm(depth, "enter", rl(func.name))), let_("result", expression), re(rm(depth, "leave"))], rp("result")), this.type(func.returns));
    this.mutable = previous; this.returnType = previousReturn; return result;
  }
  trace(kind: string, id: number, name: string, value: RustExpr = rp("Value", "Unit"), extras: Record<string, RustExpr> = {}): RustStatement {
    const fields = { kind: rl(kind), region: field("instance"), id: rl(id, "u32"), name: rl(name), mode: rl(""), value, changed: rl(false), version: rl(0), initial: rl(false), ...extras };
    return condition(rc(rp("microts", "model", "trace_enabled")), [re(rc(rp("microts", "model", "trace"), { kind: "struct", path: ["microts", "model", "ModelTrace"], fields: Object.entries(fields).map(([name, value]) => ({ name, value })), rest: rc(rp("Default", "default")) }))]);
  }
  commandTrace(name: string, args: ModelExpr[], request?: RustExpr): RustStatement {
    return this.trace("command", 0, name, rc(rp("Value", "Array"), { kind: "macro", name: ["alloc", "vec"], args: args.map(arg => rm(this.expr(arg), "model_value")) }), request ? { request: rc(rp("Some"), request) } : {});
  }
  decodeCompletion(type: AotType, completion: RustExpr): RustExpr {
    const decodeValue = (type: AotType, value: RustExpr): RustExpr => type.kind === "tuple"
      ? { kind: "tuple", elements: type.elements.map((element, index) => decodeValue(element, rc(rp("microts", "model", "value_element"), value, rl(index)))) }
      : rm(rc({ kind: "qualifiedPath", type: this.type(type), member: "from_model_value" }, value), "expect", rl("malformed task tuple completion"));
    return type.kind === "tuple" ? decodeValue(type, rc(rp("microts", "model", "completion_value"), completion)) : rc({ kind: "path", path: ["microts", "model", "decode"], typeArgs: [this.type(type)] }, completion);
  }
  decodeWait(source: ModelAwaitable, type: AotType, wait: RustExpr, index: number): RustExpr {
    const size = (source: ModelAwaitable): number => 1 + (source.kind === "all" || source.kind === "any" ? source.members.reduce((count, member) => count + size(member), 0) : 0);
    if (source.kind === "any") {
      let child = index + 1;
      const arms = source.members.map(member => { const at = child; child += size(member); return { pattern: { kind: "literal" as const, value: at }, body: this.decodeWait(member, type, wait, at) }; });
      return { kind: "match", value: rm(wait, "winner", rl(index)), arms: [...arms, { pattern: { kind: "wildcard" }, body: { kind: "macro", name: ["unreachable"], args: [rl("invalid any winner")] } }] };
    }
    const joined = source.kind === "join" ? this.current.tasks.find(task => task.id === source.task || task.fn === source.task) : undefined;
    const returns = joined ? this.functions.get(joined.fn)!.returns : undefined;
    const actual: AotType = source.kind === "service" ? source.result : source.kind === "animate" ? { kind: "string" } : source.kind === "join" && !source.wrapped ? returns! : source.kind === "all" || source.kind === "join" ? type.kind === "option" ? type.value : type : { kind: "void" };
    if (type.kind === "option") {
      if (actual.kind === "void" || actual.kind === "undefined") return rp("None");
      if (actual.kind !== "option") return rc(rp("Some"), this.decodeWait(source, type.value, wait, index));
    }
    if (source.kind === "all") {
      if (type.kind !== "tuple") throw new Error("all completion requires a tuple result");
      let child = index + 1;
      return { kind: "tuple", elements: source.members.map((member, memberIndex) => { const at = child; child += size(member); return this.decodeWait(member, type.elements[memberIndex]!, wait, at); }) };
    }
    const result = rm(wait, "result", rl(index));
    if (source.kind === "join") {
      const value = this.copy(returns!) ? { kind: "unary", operator: "*", expr: rp("value") } as RustExpr : rm(rp("value"), "clone");
      const payload = { kind: "variant" as const, path: [this.taskValueName(), `Fn${joined!.fn}`], tuple: [rn("value")] };
      if (!source.wrapped) return { kind: "match", value: result, arms: [{ pattern: { kind: "variant", path: ["TaskResult", "Typed"], tuple: [payload] }, body: value }, { pattern: { kind: "wildcard" }, body: { kind: "macro", name: ["unreachable"], args: [rl("invalid typed task result")] } }] };
      const name = `Join${typeName(returns!.kind === "named" ? returns!.name : returns!.kind)}`;
      return { kind: "match", value: result, arms: [
        { pattern: { kind: "variant", path: ["TaskResult", "Joined"], tuple: [{ kind: "variant", path: ["Some"], tuple: [payload] }] }, body: { kind: "struct", path: [name, "Done"], fields: returns!.kind === "void" ? [] : [{ name: "value", value }] } },
        { pattern: { kind: "variant", path: ["TaskResult", "Joined"], tuple: [{ kind: "variant", path: ["None"] }] }, body: { kind: "struct", path: [name, "Cancelled"], fields: [] } },
        { pattern: { kind: "wildcard" }, body: { kind: "macro", name: ["unreachable"], args: [rl("invalid joined task result")] } },
      ] };
    }
    return this.decodeCompletion(type, rm(result, "host"));
  }
  codecs() {
    const string = (value: string) => rc(rp("String", "from"), rl(value));
    const object = (fields: { name: string; value: RustExpr }[]) => rc(rp("Value", "Object"), { kind: "macro", name: ["alloc", "vec"], args: fields.map(f => ({ kind: "tuple", elements: [string(f.name), f.value] })) } as RustExpr);
    const construct = (path: string[], fields: { name: string; type: AotType }[]): RustExpr => ({ kind: "match", value: { kind: "tuple", elements: fields.map(f => rc({ kind: "path", path: ["microts", "model", "decode_field"], typeArgs: [this.type(f.type)] }, rp("value"), rl(f.name))) }, arms: [
      { pattern: { kind: "tuple", elements: fields.map(f => ({ kind: "variant", path: ["Some"], tuple: [rn(f.name)] })) }, body: rc(rp("Some"), { kind: "struct", path, fields: fields.map(f => ({ name: f.name, value: rp(f.name) })) }) },
      { pattern: { kind: "wildcard" }, body: rp("None") },
    ] });
    for (const d of this.program.types) {
      let encode: RustExpr, decode: RustExpr;
      if (d.kind === "struct") {
        encode = object(d.fields.map(f => ({ name: f.name, value: rm(field(f.name), "model_value") })));
        decode = construct([d.name], d.fields);
      } else if (d.kind === "enum") {
        encode = { kind: "match", value: self, arms: d.variants.map(name => ({ pattern: { kind: "variant", path: [d.name, rustVariant(name)] }, body: rc(rp("Value", "String"), string(name)) })) };
        decode = { kind: "match", value: rc(rp("microts", "model", "value_string"), rp("value")), arms: [...d.variants.map(name => ({ pattern: { kind: "variant" as const, path: ["Some"], tuple: [{ kind: "literal" as const, value: name }] }, body: rc(rp("Some"), rp(d.name, rustVariant(name))) })), { pattern: { kind: "wildcard" }, body: rp("None") }] };
      } else if (d.kind === "union") {
        encode = { kind: "match", value: self, arms: d.variants.map(v => ({ pattern: { kind: "variant", path: [d.name, rustVariant(v.name)], fields: v.fields.map(f => ({ name: f.name, pattern: rn(f.name) })) }, body: object([{ name: d.discriminant, value: rc(rp("Value", "String"), string(v.name)) }, ...v.fields.map(f => ({ name: f.name, value: rm(rp(f.name), "model_value") }))]) })) };
        decode = { kind: "match", value: rc(rp("microts", "model", "value_tag"), rp("value"), rl(d.discriminant)), arms: [...d.variants.map(v => ({ pattern: { kind: "variant" as const, path: ["Some"], tuple: [{ kind: "literal" as const, value: v.name }] }, body: construct([d.name, rustVariant(v.name)], v.fields) })), { pattern: { kind: "wildcard" }, body: rp("None") }] };
      } else {
        encode = d.unit === "Color" ? rc(rp("Value", "String"), rc(rp("microts", "model", "to_string"), self)) : rm(rf(self, 0), "model_value");
        decode = rm(d.unit === "Color" ? rc(rp("microts", "model", "decode_color"), rp("value")) : rc({ kind: "qualifiedPath", type: this.type(d.base), member: "from_model_value" }, rp("value")), "map", rp(d.name));
      }
      this.items.push({ kind: "impl", type: rt(d.name), trait: rt("ModelValue"), methods: [fn("model_value", [receiver()], rb([], encode), rt("Value")), fn("from_model_value", [param("value", rr(rt("Value")))], rb([], decode), rt("Option", rt("Self")))] });
    }
  }
  emitTypes() {
    for (const d of this.program.types) {
      if (d.kind === "struct") this.items.push({ kind: "struct", name: d.name, public: true, derives: ["Clone", "Debug", "PartialEq"], fields: d.fields.map(f => ({ ...f, public: true, type: this.type(f.type) })) });
      else if (d.kind === "enum") this.items.push({ kind: "enum", name: d.name, public: true, derives: ["Clone", "Copy", "Debug", "PartialEq"], variants: d.variants.map(name => ({ name: rustVariant(name) })) });
      else if (d.kind === "union") this.items.push({ kind: "enum", name: d.name, public: true, derives: ["Clone", "Debug", "PartialEq"], variants: d.variants.map(v => ({ name: rustVariant(v.name), fields: v.fields.map(f => ({ name: f.name, type: this.type(f.type) })) })) });
      else this.items.push({ kind: "struct", name: d.name, public: true, derives: ["Clone", ...(this.copy(d.base) ? ["Copy"] : []), "Debug", "PartialEq"], tuple: [this.type(d.base)] });
      if (d.kind === "newtype" || d.kind === "enum") {
        const formatter = param("formatter", rr(rt("core::fmt::Formatter", { kind: "lifetime", name: "_" }), true));
        const display: RustExpr = d.kind === "enum" ? { kind: "match", value: self, arms: d.variants.map(name => ({ pattern: { kind: "variant", path: [d.name, rustVariant(name)] }, body: rm(rp("formatter"), "write_str", rl(name)) })) }
          : d.unit === "Color" ? rc(rp("microts", "format_color"), rf(self, 0), rp("formatter")) : rc(rp("microts", "MicroTsDisplay", "fmt_microts"), ref(rf(self, 0)), rp("formatter"));
        this.items.push({ kind: "impl", type: rt(d.name), trait: rt("microts::MicroTsDisplay"), methods: [fn("fmt_microts", [receiver(), formatter], rb([], display), rt("core::fmt::Result"))] });
      }
    }
  }
  module(module: ModelModule) {
    this.current = module;
    if (module.kind === "pure") { for (const func of module.functions) this.items.push(this.function(func)); return; }
    const modelName = `${module.name}Model`, traitName = `${module.name}ViewModel`;
    const fields: RustField[] = [{ name: "depth", type: rt("Depth") }, { name: "commands", type: rt("microts::CommandQueue") }, { name: "instance", type: rt("u32") }, { name: "frame", type: rt("u64") }, { name: "now_ms", type: rt("f64") }, { name: "resumed", type: rt("bool") }, { name: "trace_mode", type: rr(rt("str"), false, "static") }];
    const seeds: { name: string; value: RustExpr }[] = [ { name: "depth", value: rc(rp("Depth", "new"), rl(this.program.recursionLimit, "u32")) }, { name: "commands", value: rc(rp("microts", "CommandQueue", "default")) }, { name: "instance", value: rc(rp("microts", "model", "next_region")) }, { name: "frame", value: rl(0) }, { name: "now_ms", value: rl(0, "f64") }, { name: "resumed", value: rl(false) }, { name: "trace_mode", value: rl("construction") } ];
    const methods: RustFunction[] = [], traitMethods: RustFunction[] = [], watchSeeds: RustStatement[] = [];
    methods.push(fn("model_state", [receiver()], rb([], { kind: "if", condition: rc(rp("microts", "model", "trace_enabled")), then: rb([], rc(rp("Value", "Object"), { kind: "macro", name: ["alloc", "vec"], args: [...module.signals, ...module.memos, ...module.fields].map(item => ({ kind: "tuple", elements: [rc(rp("String", "from"), rl(item.name)), rm(this.storage(item.id), "model_value")] })) })), otherwise: rb([], rp("Value", "Unit")) }), rt("Value"), true));
    for (const p of module.params) { fields.push({ name: this.name(p.id), type: this.type(p.type, false, p.capacity) }); seeds.push({ name: this.name(p.id), value: this.own(rp(this.name(p.id)), p.type) }); }
    this.constructing = true;
    for (const s of [...module.signals, ...module.fields]) { fields.push({ name: this.name(s.id), type: this.type(s.type, false, s.capacity) }); seeds.push({ name: this.name(s.id), value: this.coerce(s.seed, s.type, s.name, s.capacity) }); }
    this.constructing = false;
    for (const s of module.signals) {
      fields.push({ name: `version_${s.id}`, type: rt("u32") }, { name: `changed_${s.id}`, type: rt("bool") });
      seeds.push({ name: `version_${s.id}`, value: rl(1) }, { name: `changed_${s.id}`, value: rl(false) });
      const write = [assign(this.storage(s.id), rp("value")), assign(field(`version_${s.id}`), rm(field(`version_${s.id}`), "wrapping_add", rl(1))), assign(field(`changed_${s.id}`), rl(true))];
      methods.push(fn(`write_${s.id}`, [receiver(true), param("value", this.type(s.type, false, s.capacity))], rb([let_("changed", this.primitive(s.type) ? bin("!=", rp("value"), this.storage(s.id)) : rl(true)), condition(rp("changed"), write), this.trace("set", s.id, s.name, rm(this.storage(s.id), "model_value"), { changed: rp("changed"), version: field(`version_${s.id}`) })])));
    }
    for (const memo of module.memos) {
      fields.push({ name: this.name(memo.id), type: this.type(memo.type) }, { name: `version_${memo.id}`, type: rt("u32") }, { name: `changed_${memo.id}`, type: rt("bool") }, { name: `initialized_${memo.id}`, type: rt("bool") });
      seeds.push({ name: this.name(memo.id), value: this.defaultValue(memo.type) }, { name: `version_${memo.id}`, value: rl(0) }, { name: `changed_${memo.id}`, value: rl(false) }, { name: `initialized_${memo.id}`, value: rl(false) });
      for (const input of memo.inputs) { fields.push({ name: `seen_${memo.id}_${input}`, type: rt("u32") }); seeds.push({ name: `seen_${memo.id}_${input}`, value: rl(0) }); }
      const updates = [assign(this.storage(memo.id), rp("value")), assign(field(`version_${memo.id}`), rm(field(`version_${memo.id}`), "wrapping_add", rl(1))), assign(field(`changed_${memo.id}`), rl(true))];
      methods.push(fn(`read_${memo.id}`, [receiver(true)], rb([
        ...memo.inputs.filter(input => module.memos.some(m => m.id === input)).map(input => re(rm(self, `read_${input}`))),
        condition(or([{ kind: "unary", operator: "!", expr: field(`initialized_${memo.id}`) }, ...memo.inputs.map(input => bin("!=", field(`seen_${memo.id}_${input}`), field(`version_${input}`)))]), [condition(bin("==", field("trace_mode"), rl("demand")), [work("DemandMemo")]), let_("value", this.expr(memo.body)), let_("changed", this.primitive(memo.type) ? or([{ kind: "unary", operator: "!", expr: field(`initialized_${memo.id}`) }, bin("!=", rp("value"), this.storage(memo.id))]) : rl(true)), ...(this.primitive(memo.type) ? [condition(rp("changed"), updates)] : updates), ...memo.inputs.map(input => assign(field(`seen_${memo.id}_${input}`), field(`version_${input}`))), assign(field(`initialized_${memo.id}`), rl(true)), this.trace("memo", memo.id, memo.name, rm(this.storage(memo.id), "model_value"), { changed: rp("changed"), version: field(`version_${memo.id}`), mode: field("trace_mode") })]),
      ], this.own(this.storage(memo.id), memo.type)), this.type(memo.type)));
    }
    for (const reference of module.refs) { fields.push({ name: this.name(reference.id), type: rt("NodeSlot") }); seeds.push({ name: this.name(reference.id), value: rc(rp("NodeSlot", "default")) }); }
    for (const effect of module.effects) {
      const body: RustStatement[] = [];
      if (effect.watch) {
        const watched = effect.watch.sources.map(id => this.node(id));
        const valueType: AotType = watched.length === 1 ? watched[0]!.type : { kind: "tuple", elements: watched.map(source => source.type) };
        const capture = (owner: RustExpr): RustExpr => {
          const values = watched.map(source => module.memos.some(memo => memo.id === source.id) ? rm(owner, `read_${source.id}`) : this.own(rf(owner, this.name(source.id)), source.type));
          return values.length === 1 ? values[0]! : { kind: "tuple", elements: values };
        };
        const previous = field(`watch_previous_${effect.id}`), snapshot = `watch_value_${effect.id}`;
        fields.push({ name: `watch_previous_${effect.id}`, type: rt("Option", this.type(valueType)) });
        seeds.push({ name: `watch_previous_${effect.id}`, value: rp("None") });
        if (effect.defer) watchSeeds.push(assign(rf(rp("model"), `watch_previous_${effect.id}`), rc(rp("Some"), capture(rp("model")))));
        body.push(let_(snapshot, capture(self)));
        if (effect.watch.value) { const binder = effect.watch.value; this.binders.set(binder.id, binder); body.push(let_(this.name(binder.id), this.own(rp(snapshot), valueType), true)); }
        if (effect.watch.previous) {
          const binder = effect.watch.previous; this.binders.set(binder.id, binder);
          let value = this.own(previous, { kind: "option", value: valueType });
          if (effect.defer) value = rm(value, "expect", rl("watch seed was captured at construction"));
          else if (JSON.stringify(binder.type) === JSON.stringify(valueType)) value = rm(value, "unwrap_or_else", { kind: "closure", params: [], body: this.defaultValue(valueType) });
          body.push(let_(this.name(binder.id), value, true));
        }
        body.push(assign(previous, rc(rp("Some"), rp(snapshot))));
      }
      methods.push(fn(`effect_${effect.id}`, [receiver(true)], rb([...body, ...this.expressionBody(effect.body, { kind: "void" })])));
    }
    for (const func of module.functions.filter(f => !f.async)) { methods.push(this.function(func)); if (!func.ledger.writes.length && !func.ledger.external) methods.push(this.function(func, true)); }
    this.tasks(module, fields, seeds, methods, traitMethods);
    const memoOrder = module.schedule.filter(id => module.memos.some(m => m.id === id));
    const reset = () => [...module.signals, ...module.memos].map(s => assign(field(`changed_${s.id}`), rl(false)));
    const newBody = rb([let_("model", { kind: "struct", path: ["Self"], fields: seeds }, true), ...memoOrder.map(id => re(rm(rp("model"), `read_${id}`))), ...watchSeeds, assign(rf(rp("model"), "trace_mode"), rl("demand")), ...[...module.signals, ...module.memos].map(s => assign(rf(rp("model"), `changed_${s.id}`), rl(false)))], rp("model"));
    if (module.params.length) {
      methods.push(fn("new", module.params.map(p => param(this.name(p.id), this.type(p.type))), newBody, rt("Self"), true));
      const args: RustType = { kind: "tuple", elements: module.params.map(p => this.type(p.type)) };
      this.items.push({ kind: "impl", type: rt(modelName), trait: rt("microts::New", args), methods: [fn("new", [param("args", args)], rb([], rc(rp("Self", "new"), ...module.params.map((_, i) => rf(rp("args"), i)))), rt("Self"))] });
    }
    else this.items.push({ kind: "impl", type: rt(modelName), trait: rt("Default"), methods: [fn("default", [], newBody, rt("Self"))] });
    const view = this.view?.components.find(c => c.name === module.name);
    for (const value of view?.values ?? [...module.signals, ...module.memos].filter(s => s.exported).map(s => ({ ...s, sourceName: s.name, writable: module.signals.some(signal => signal.id === s.id) }))) {
      const target = [...module.signals, ...module.memos].find(s => s.name === value.sourceName || s.name === value.name); if (!target) throw new Error(`No model source for ${module.name}.${value.name}`);
      traitMethods.push(fn(value.name, [receiver()], rb([], this.borrowed(this.storage(target.id), target.type)), this.type(value.type, true)));
      if (module.memos.some(m => m.id === target.id)) traitMethods.push(fn(`${value.name}_now`, [receiver(true)], rb([re(rm(self, `read_${target.id}`))], this.borrowed(this.storage(target.id), target.type)), this.type(value.type, true)));
      if (value.writable) {
        const signal = this.signal(target.id);
        const val = signal.capacity === undefined ? rp("value") : rc({ kind: "path", path: ["microts", "model", signal.type.kind === "string" ? "bounded_string" : "bounded_array"], typeArgs: signal.type.kind === "string" ? [{ kind: "const", value: signal.capacity }] : [this.type((signal.type as Extract<AotType, { kind: "array" }>).element), { kind: "const", value: signal.capacity }] }, signal.type.kind === "string" ? ref(rp("value")) : rp("value"), rl(signal.name));
        traitMethods.push(fn(`set_${value.name}`, [receiver(true), param("value", this.type(value.type))], rb([re(rm(self, `write_${target.id}`, val))])));
      }
    }
    for (const f of view?.functions ?? module.functions.filter(f => f.exported).map(f => ({ name: f.name, sourceName: f.name, parameters: f.params, returns: f.returns, handler: f.async || f.ledger.writes.length > 0 || f.ledger.external, binding: false }))) {
      const func = module.functions.find(item => item.name === f.sourceName || item.name === f.name); if (!func) throw new Error(`No model source for ${module.name}.${f.name}`);
      const mutable = this.view ? !f.binding || func.async : f.handler || func.async;
      let commands = "cmds"; while (f.parameters.some(parameter => parameter.name === commands)) commands = `_${commands}`;
      traitMethods.push(fn(f.name, [receiver(mutable), ...f.parameters.map(p => param(p.name, this.type(p.type))), ...(func.async ? [param(commands, rr(rt("Vec", rt("Cmd")), true))] : [])], func.async ? rb([re(rm(self, `start_${func.id}`, ...f.parameters.map(p => rp(p.name)))), re(rm(field("commands"), "drain_to", rp(commands)))]) : rb([], rm(self, `${mutable ? "fn" : "render_fn"}_${func.id}`, ...f.parameters.map(p => rp(p.name)))), func.async ? unit : this.type(f.returns)));
    }
    for (const method of traitMethods) {
      const sourceName = view?.functions.find(fn => fn.name === method.name)?.sourceName ?? method.name;
      const func = module.functions.find(f => f.name === sourceName);
      if (func && method.body) method.body.statements.unshift(this.trace("handler", func.id, func.name, rc(rp("Value", "Array"), { kind: "macro", name: ["alloc", "vec"], args: method.params.slice(1, 1 + func.params.length).map(p => rm(rp((p.pattern as { name: string }).name), "model_value")) })));
    }
    for (const reference of view?.refs ?? module.refs.map(reference => ({ name: reference.name, sourceName: reference.name }))) {
      const source = module.refs.find(item => item.name === reference.sourceName);
      if (!source) throw new Error(`No model node reference for ${module.name}.${reference.name}`);
      traitMethods.push(fn(reference.name, [receiver()], rb([], ref(this.storage(source.id))), rr(rt("NodeSlot"))));
    }
    traitMethods.push(fn("react", [receiver(true), param("initial", rt("bool")), param("cmds", rr(rt("Vec", rt("Cmd")), true))], rb([
      ...module.schedule.map(id => { const effect = module.effects.find(e => e.id === id); return effect ? condition(or([...(effect.defer ? [] : [rp("initial")]), bin("&&", { kind: "unary", operator: "!", expr: rp("initial") }, or(effect.subscriptions.map(s => field(`changed_${s}`))))]), [work("Effect"), this.trace("effect", id, "", rp("Value", "Unit"), { initial: rp("initial") }), assign(field("trace_mode"), rl("demand")), re(rm(self, `effect_${id}`))]) : re(block([work("ScheduledMemo"), assign(field("trace_mode"), rl("scheduled")), re(rm(self, `read_${id}`)), assign(field("trace_mode"), rl("demand"))])); }),
      ...reset(), assign(field("resumed"), rl(false)), re(rm(field("commands"), "drain_to", rp("cmds"))),
    ])));
    traitMethods.push(fn("settle", [receiver(true)], rb([assign(field("trace_mode"), rl("settle")), ...memoOrder.map(id => re(rm(self, `read_${id}`))), ...reset(), assign(field("trace_mode"), rl("demand"))])));
    traitMethods.push(fn("bind_commands", [receiver(true), param("commands", rt("microts::CommandQueue"))], rb([assign(field("commands"), rp("commands"))])));
    traitMethods.push(fn("model_changed", [receiver()], rb([], or([field("resumed"), ...module.signals.map(s => field(`changed_${s.id}`)), { kind: "unary", operator: "!", expr: rm(field("commands"), "is_empty") }])), rt("bool")));
    if (!module.tasks.length) {
      traitMethods.push(fn("prepare_resume", [receiver(true), param("ready", rr(rt("Ready")))], rb([assign(field("frame"), rf(rp("ready"), "frame")), assign(field("now_ms"), rf(rp("ready"), "now_ms"))])));
      traitMethods.push(fn("resume", [receiver(true), param("ready", rr(rt("Ready"))), param("_cmds", rr(rt("Vec", rt("Cmd")), true))], rb([re(rm(self, "prepare_resume", rp("ready")))])));
      traitMethods.push(fn("cancel_tasks", [receiver(true), param("cmds", rr(rt("Vec", rt("Cmd")), true))], rb([re(rm(field("commands"), "drain_to", rp("cmds")))])));
    }
    const taken = new Set([...methods, ...traitMethods].map(method => method.name));
    for (const f of module.fields) if (f.hostName) {
      for (const name of [f.hostName, `${f.hostName}_mut`]) {
        if (taken.has(name)) throw new Error(`The state accessor ${name} of field ${f.name} has the name of a model method; rename the field or its file`);
        taken.add(name);
      }
      const type = this.type(f.type, false, f.capacity);
      methods.push(fn(f.hostName, [receiver()], rb([], ref(field(this.name(f.id)))), rr(type), true));
      methods.push(fn(`${f.hostName}_mut`, [receiver(true)], rb([], ref(field(this.name(f.id)), true)), rr(type, true), true));
    }
    this.items.push({ kind: "struct", name: modelName, public: true, fields });
    this.items.push({ kind: "impl", type: rt(modelName), methods });
    if (!this.view) this.items.push({ kind: "trait", name: traitName, public: true, methods: traitMethods.map(f => ({ ...f, body: undefined })) });
    const children: string[] = [];
    const visitChild = (name: string) => { const child = this.view!.components.find(component => component.name === name)!; if (child.factory) children.push(name); else child.children.forEach(visitChild); };
    view?.children.forEach(visitChild);
    this.items.push({ kind: "impl", type: rt(modelName), trait: rt(traitName), associatedTypes: [...new Set(children)].map(name => ({ name, type: rt(`${name}Model`) })), methods: traitMethods });
  }
  tasks(module: ModelModule, fields: RustField[], seeds: { name: string; value: RustExpr }[], methods: RustFunction[], traitMethods: RustFunction[]) {
    if (!module.tasks.length) return;
    const payload = this.taskValueName();
    this.items.push({ kind: "enum", name: payload, derives: ["Clone", "Debug"], variants: module.tasks.map(task => ({ name: `Fn${task.fn}`, tuple: [this.type(this.functions.get(task.fn)!.returns)] })) });
    this.items.push({ kind: "impl", type: rt(payload), trait: rt("TaskValue"), methods: [fn("task_value", [receiver()], rb([], { kind: "match", value: self, arms: module.tasks.map(task => ({ pattern: { kind: "variant", path: [payload, `Fn${task.fn}`], tuple: [rn("value")] }, body: rm(rp("value"), "model_value") })) }), rt("Value"))] });
    const countWait = (wait: ModelAwaitable, kind?: ModelAwaitable["kind"]): number => (kind === undefined || wait.kind === kind ? 1 : 0) + (wait.kind === "all" || wait.kind === "any" ? wait.members.reduce((n, child) => n + countWait(child, kind), 0) : 0);
    const bound = (task: ModelTask, kind?: ModelAwaitable["kind"]) => Math.max(0, ...task.states.map(state => state.suspend ? countWait(state.suspend, kind) : 0));
    const joins = module.tasks.reduce((n, task) => n + bound(task, "join"), 0);
    const services = module.tasks.reduce((n, task) => n + bound(task, "service"), 0);
    fields.push({ name: "prepared_frame", type: rt("u64") }, { name: "task_order", type: rt("u64") }, { name: "building_wait", type: rt("u32") }, { name: "outcomes", type: rt("heapless::Vec", rt("TaskOutcome", rt(payload)), { kind: "const", value: module.tasks.length + joins + 1 }) }, { name: "services", type: rt("Vec", rt("String")) }, { name: "requests", type: rt("ServiceRequests", { kind: "const", value: services }) });
    seeds.push({ name: "prepared_frame", value: rp("u64", "MAX") }, { name: "task_order", value: rl(0) }, { name: "building_wait", value: rl(0) }, { name: "outcomes", value: rc(rp("heapless", "Vec", "new")) }, { name: "services", value: rc(rp("Vec", "new")) }, { name: "requests", value: rc(rp("ServiceRequests", "default")) });
    methods.push(fn("prune_outcomes", [receiver(true)], rb([condition(bin("!=", field("building_wait"), rl(0)), [{ kind: "return" }]), re(rm(field("outcomes"), "retain", { kind: "closure", params: [rn("outcome")], body: or(module.tasks.map(task => rm(field(`task_${task.id}`), "references", rf(rp("outcome"), "task")))) }))])));
    const predicates: RustExpr[] = [];
    const predicateWalk = (awaitable: ModelAwaitable) => {
      if (awaitable.kind === "until") {
        const id = this.predicates.size; this.predicates.set(awaitable, id);
        predicates.push({ kind: "tuple", elements: [rl(id, "u32"), { kind: "if", condition: rm(field(`task_${this.task!.id}`), "waits_for_predicate", rl(id, "u32")), then: rb([], this.expr(awaitable.predicate)), otherwise: rb([], rl(false)) }] });
      }
      if (awaitable.kind === "all" || awaitable.kind === "any") awaitable.members.forEach(predicateWalk);
    };
    for (const task of module.tasks) {
      const func = this.functions.get(task.fn)!;
      this.task = { ...task, fields: [...new Map([...task.fields, ...func.params].map(p => [p.id, p])).values()] };
      const taskField = field(`task_${task.id}`);
      fields.push({ name: `task_${task.id}`, type: rt("TaskState", { kind: "const", value: bound(task) }, rt(payload)) }, { name: `prepared_${task.id}`, type: rt("Option", rt("TaskReady")) }, { name: `prepared_id_${task.id}`, type: rt("TaskId") }, { name: `prepared_order_${task.id}`, type: rt("u64") });
      seeds.push({ name: `task_${task.id}`, value: rc(rp("TaskState", "default")) }, { name: `prepared_${task.id}`, value: rp("None") }, { name: `prepared_id_${task.id}`, value: rc(rp("TaskId", "default")) }, { name: `prepared_order_${task.id}`, value: rl(0) });
      for (const binder of this.task.fields) {
        fields.push({ name: `task_${task.id}_${this.name(binder.id)}`, type: this.type(binder.type, false, binder.capacity) });
        seeds.push({ name: `task_${task.id}_${this.name(binder.id)}`, value: this.defaultValue(binder.type) });
      }
      for (const state of task.states) if (state.suspend) predicateWalk(state.suspend);
      methods.push(fn(`release_${func.id}`, [receiver(true)], rb(this.task.fields.map(binder => assign(this.storage(binder.id), this.defaultValue(binder.type))))));
      methods.push(fn(`cancel_${func.id}`, [receiver(true)], rb([re(rm(self, `cancel_reason_${func.id}`, rl("cancel")))])));
      methods.push(fn(`cancel_reason_${func.id}`, [receiver(true), param("reason", rr(rt("str"), false, "static"))], rb([
        condition({ kind: "unary", operator: "!", expr: rf(taskField, "live") }, [{ kind: "return" }]),
        let_("cancelled", rf(taskField, "task")),
        re(rm(taskField, "cancel", ref(rm(field("commands"), "borrow_mut"), true), ref(field("outcomes"), true), ref(field("requests"), true), rp("reason"))),
        re(rm(self, `release_${func.id}`)),
        ...module.tasks.filter(other => other.id !== task.id).map(other => condition(rm(field(`task_${other.id}`), "awaits_bare", rp("cancelled")), [re(rm(self, `cancel_reason_${other.fn}`, rl("awaited task cancelled")))])),
        re(rm(self, "prune_outcomes")),
      ])));
      methods.push(fn(`start_${func.id}`, [receiver(true), ...func.params.map(p => param(this.name(p.id), this.type(p.type)))], rb([
        re(rm(self, `cancel_reason_${func.id}`, rl("restart"))),
        assign(field("task_order"), rm(field("task_order"), "wrapping_add", rl(1))),
        let_("task", rm(taskField, "start", field("instance"), rl(func.id, "u32"), field("task_order"))),
        ...func.params.map(p => assign(this.storage(p.id), rp(this.name(p.id)))),
        re(rm(self, `segment_${func.id}`, rl(0), rp("None"))),
        condition({ kind: "unary", operator: "!", expr: rf(taskField, "live") }, [re(rm(self, `release_${func.id}`))]),
        re(rm(self, "prune_outcomes")),
      ], rp("task")), rt("TaskId")));
      const arms = task.states.map(state => {
        const previous = task.states.find(candidate => candidate.suspend && (candidate.next ?? candidate.id + 1) === state.id && candidate.resume);
        const body: RustStatement[] = state.loop ? [work("LoopIteration")] : [];
        if (previous?.resume) {
          const target = this.storage(previous.resume.id);
          const value = this.decodeWait(previous.suspend!, previous.resume.type, rm(rm(rp("result"), "as_ref"), "expect", rl("missing task completion")), 0);
          if (this.task!.fields.some(p => p.id === previous.resume!.id)) body.push(assign(target, value));
          else body.push(let_(this.name(previous.resume.id), value, true, this.type(previous.resume.type)));
        }
        body.push(...this.statements(state.body));
        if (state.suspend) {
          body.push(assign(rf(taskField, "wait_generation"), rm(rm(rf(taskField, "wait_generation"), "checked_add", rl(1)), "expect", rl("model wait identity exhausted"))));
          const wait = rc(rp("Wait", "new"), { kind: "array", elements: this.awaitables(state.suspend, task) });
          body.push(assign(field("building_wait"), bin("+", field("building_wait"), rl(1))), let_("wait", wait), re(rm(taskField, "suspend", rl(state.next ?? state.id + 1, "u32"), field("frame"), rp("wait"))), assign(field("building_wait"), bin("-", field("building_wait"), rl(1))), condition(rm(taskField, "has_cancelled_join", ref(field("outcomes"))), [re(rm(self, `cancel_reason_${func.id}`, rl("awaited task cancelled")))]), { kind: "return" });
        } else if (state.branch) body.push(assign(rp("state"), { kind: "if", condition: this.expr(state.branch.condition), then: rb([], rl(state.branch.then, "u32")), otherwise: rb([], rl(state.branch.else, "u32")) }), { kind: "continue" });
        else if (state.next !== undefined) body.push(assign(rp("state"), rl(state.next, "u32")), { kind: "continue" });
        else body.push(re(rm(taskField, "finish", this.taskReturn(), ref(field("outcomes"), true))), { kind: "return" });
        return { pattern: { kind: "literal" as const, value: state.id }, body: block(body) };
      });
      arms.push({ pattern: { kind: "wildcard" } as never, body: { kind: "macro", name: ["unreachable"], args: [] } });
      methods.push(fn(`segment_${func.id}`, [receiver(true), { pattern: rn("state", true), type: rt("u32") }, param("result", rt("Option", rt("Wait", { kind: "const", value: bound(task) }, rt(payload))))], rb([work("TaskSegment"), { kind: "loop", body: rb([re({ kind: "match", value: rp("state"), arms })]) }])));
    }
    this.task = undefined;
    traitMethods.push(fn("prepare_resume", [receiver(true), param("ready", rr(rt("Ready")))], rb([
      assign(field("frame"), rf(rp("ready"), "frame")), assign(field("now_ms"), rf(rp("ready"), "now_ms")), assign(field("prepared_frame"), rf(rp("ready"), "frame")), condition(bin("!=", field("services"), rf(rp("ready"), "services")), [assign(field("services"), rm(rf(rp("ready"), "services"), "clone"))]),
      condition(rc(rp("microts", "model", "trace_enabled")), [{ kind: "for", pattern: rn("delivery"), iterable: ref(rf(rp("ready"), "deliveries")), body: rb([condition(bin("==", rf(rf(rf(rp("delivery"), "request"), "task"), "region"), field("instance")), [re({ kind: "match", value: rf(rf(rf(rp("delivery"), "request"), "task"), "function"), arms: [...module.tasks.map(task => ({ pattern: { kind: "literal" as const, value: task.fn }, body: rm(field(`task_${task.id}`), "trace_delivery", rp("delivery")) })), { pattern: { kind: "wildcard" }, body: rc(rp("microts", "model", "trace_delivery_drop"), rp("delivery")) }] })])]) }]),
      let_("predicates", { kind: "array", elements: predicates }, false, { kind: "array", element: { kind: "tuple", elements: [rt("u32"), rt("bool")] }, length: predicates.length }),
      ...module.tasks.flatMap(task => [assign(field(`prepared_${task.id}`), rm(field(`task_${task.id}`), "poll", rp("ready"), ref(rp("predicates")), ref(field("outcomes")), ref(field("requests"), true), ref(field("commands")))), assign(field(`prepared_id_${task.id}`), rf(field(`task_${task.id}`), "task")), assign(field(`prepared_order_${task.id}`), rf(field(`task_${task.id}`), "order"))]),
    ])));
    const readyItems = module.tasks.map(task => ({ kind: "tuple" as const, elements: [field(`prepared_order_${task.id}`), rl(task.id, "u32"), field(`prepared_id_${task.id}`), rm(field(`prepared_${task.id}`), "take")] }));
    const branches = module.tasks.map(task => ({ pattern: { kind: "literal" as const, value: task.id }, body: block([
      condition(bin("||", { kind: "unary", operator: "!", expr: rf(field(`task_${task.id}`), "live") }, bin("!=", rf(field(`task_${task.id}`), "task"), rp("task_id"))), [{ kind: "continue" }]),
      condition({ kind: "matches", value: rp("completion"), pattern: { kind: "variant", path: ["TaskReady", "Cancelled"] } }, [re(rm(self, `cancel_reason_${task.fn}`, rl("awaited task cancelled")))], rb([
        let_("result", rm(field(`task_${task.id}`), "complete_wait", ref(rm(field("commands"), "borrow_mut"), true), ref(field("requests"), true))),
        let_("state", rf(field(`task_${task.id}`), "state")),
        re(rc(rp("microts", "model", "trace_task_resume"), rp("task_id"), rp("state"))),
        re(rm(self, `segment_${task.fn}`, rp("state"), rp("result"))),
        condition({ kind: "unary", operator: "!", expr: rf(field(`task_${task.id}`), "live") }, [re(rm(self, `release_${task.fn}`))]),
        re(rm(self, "prune_outcomes")),
      ])),
    ]) }));
    branches.push({ pattern: { kind: "wildcard" } as never, body: { kind: "macro", name: ["unreachable"], args: [] } });
    traitMethods.push(fn("resume", [receiver(true), param("ready", rr(rt("Ready"))), param("cmds", rr(rt("Vec", rt("Cmd")), true))], rb([
      condition(bin("!=", field("prepared_frame"), rf(rp("ready"), "frame")), [re(rm(self, "prepare_resume", rp("ready")))]),
      let_("resumptions", { kind: "array", elements: readyItems }, true),
      re(rm(rp("resumptions"), "sort_by_key", { kind: "closure", params: [rn("entry")], body: rf(rp("entry"), 0) })),
      { kind: "for", pattern: { kind: "tuple", elements: [{ kind: "wildcard" }, rn("function"), rn("task_id"), rn("completion")] }, iterable: rp("resumptions"), body: rb([re({ kind: "ifLet", pattern: { kind: "variant", path: ["Some"], tuple: [rn("completion")] }, value: rp("completion"), then: rb([assign(field("resumed"), rl(true)), re({ kind: "match", value: rp("function"), arms: branches })]) })]) },
      re(rm(field("commands"), "drain_to", rp("cmds"))),
    ])));
    traitMethods.push(fn("cancel_tasks", [receiver(true), param("cmds", rr(rt("Vec", rt("Cmd")), true))], rb([
      ...module.tasks.map(task => re(rm(self, `cancel_reason_${task.fn}`, rl("unmount")))), re(rm(field("commands"), "drain_to", rp("cmds"))),
    ])));
  }
  animation(op: "animate" | "jump", args: ModelExpr[], request: RustExpr = rp("None"), values = args.map(arg => this.expr(arg))): RustExpr {
    const [node, property, target, options] = args;
    if (!node || !property || !target) throw new Error(`${op} requires a node, property and target`);
    const reference = node.kind === "literal" ? this.current.refs.find(ref => ref.name === node.value) : undefined;
    if (!reference) throw new Error(`${op} requires a bound model node reference`);
    const prop = property.kind === "literal" && typeof property.value === "string" ? property.value as PropName : undefined;
    if (prop && !ANIMATABLE.includes(prop)) throw new Error(`${op}: property ${prop} is not animatable`);
    const propValue: RustExpr = prop ? rl(PROP[prop], "u8") : { kind: "match", value: rc(rp("microts", "model", "value_string"), ref(rm(values[1]!, "model_value"))), arms: [...ANIMATABLE.map(name => ({ pattern: { kind: "variant" as const, path: ["Some"], tuple: [{ kind: "literal" as const, value: name }] }, body: rl(PROP[name], "u8") })), { pattern: { kind: "wildcard" }, body: { kind: "macro", name: ["panic"], args: [rl("model animation property is not animatable")] } }] };
    const option = (name: string, fallback: RustExpr): RustExpr => {
      if (!options) return fallback;
      if (options.kind === "struct") { const entry = options.fields.find(field => field.name === name); return entry ? rf(values[3]!, name) : fallback; }
      if (options.type.kind === "named") {
        const declaration = this.declarations.get(options.type.name);
        const entry = declaration?.kind === "struct" ? declaration.fields.find(field => field.name === name) : undefined;
        if (!entry) return fallback;
        const expr = this.own(rf(values[3]!, name), entry.type);
        return entry.type.kind === "option" && name !== "easing" ? rm(expr, "unwrap_or", fallback) : expr;
      }
      throw new Error(`${op} options require a contract struct`);
    };
    const numericTarget = target.type.kind === "string" ? rc(rp("microts", "model", "animation_color"), ref(values[2]!)) : cast(values[2]!, rt("f64"));
    const fields = [{ name: "node", value: rm(this.storage(reference.id), "get") }, { name: "prop", value: propValue }];
    if (op === "jump") return { kind: "struct", path: ["Cmd", "Jump"], fields: [...fields, { name: "value", value: numericTarget }] };
    const easing = rc(rp("microts", "model", "animation_easing_value"), ref(rm(option("easing", rl(2, "i32")), "model_value")));
    return { kind: "struct", path: ["Cmd", "Animate"], fields: [...fields, { name: "to", value: numericTarget }, { name: "dur", value: cast(option("dur", rl(200)), rt("u32")) }, { name: "easing", value: easing }, { name: "delay", value: cast(option("delay", rl(0)), rt("u32")) }, { name: "request", value: request }] };
  }
  awaitables(wait: ModelAwaitable, task: ModelTask): RustExpr[] {
    const nodes: RustExpr[] = [], sequence = { member: 0 };
    const walk = (wait: ModelAwaitable) => {
      const index = nodes.length;
      nodes.push(rp("unreachable"));
      if (wait.kind === "all" || wait.kind === "any") {
        wait.members.forEach(walk);
        nodes[index] = { kind: "struct", path: ["WaitNode", wait.kind === "all" ? "All" : "Any"], fields: [{ name: "end", value: rl(nodes.length) }, ...(wait.kind === "any" ? [{ name: "winner", value: rp("None") }] : [])] };
      } else nodes[index] = this.awaitableLeaf(wait as Exclude<ModelAwaitable, { kind: "all" | "any" }>, task, sequence);
    };
    walk(wait); return nodes;
  }
  awaitableLeaf(wait: Exclude<ModelAwaitable, { kind: "all" | "any" }>, task: ModelTask, sequence: { member: number }): RustExpr {
    const taskField = field(`task_${task.id}`);
    const request = rc(rp("microts", "model", "trace_wait"), rm(taskField, "request", rl(sequence.member++, "u32")), rl(wait.kind));
    const value = (variant: string, fields: { name: string; value: RustExpr }[]): RustExpr => ({ kind: "struct", path: ["WaitNode", variant], fields: [{ name: "request", value: request }, ...fields] });
    if (wait.kind === "frames") return value("Frames", [{ name: "until", value: rm(field("frame"), "saturating_add", cast(rm(this.expr(wait.count), "max", rl(0)), rt("u64"))) }]);
    if (wait.kind === "after") return value("After", [{ name: "until", value: bin("+", field("now_ms"), cast(this.expr(wait.ms), rt("f64"))) }]);
    if (wait.kind === "until") return value("Until", [{ name: "predicate", value: rl(this.predicates.get(wait)!, "u32") }]);
    if (wait.kind === "join") {
      const target = this.current.tasks.find(candidate => candidate.id === wait.task || candidate.fn === wait.task);
      if (!target) throw new Error(`Unknown joined task ${wait.task}`);
      const args = (wait.args ?? []).map((arg, index) => ({ name: `arg_${index}`, value: this.expr(arg) }));
      return block([let_("request", request), ...args.map(arg => let_(arg.name, arg.value)), let_("joined", rm(self, `start_${target.fn}`, ...args.map(arg => rp(arg.name))))], { kind: "struct", path: ["WaitNode", "Join"], fields: [{ name: "request", value: rp("request") }, { name: "target", value: rp("joined") }, { name: "wrapped", value: rl(wait.wrapped) }] });
    }
    if (wait.kind === "service") {
      const capacity = wait.capacity;
      if (capacity === undefined) throw new Error(`Service ${wait.module} does not declare a request capacity`);
      const args = wait.args.map((arg, index) => ({ name: `arg_${index}`, value: this.expr(arg) }));
      return block([let_("request", request), ...args.map(arg => let_(arg.name, arg.value))], { kind: "method", object: field("requests"), method: "wait", typeArgs: [this.type(wait.result), { kind: "infer" }], args: [ref(field("services")), rl(wait.module), rl(wait.call), { kind: "macro", name: ["alloc", "vec"], args: args.map(arg => rm(rp(arg.name), "model_value")) }, rp("request"), rl(capacity), ref(field("commands"))] });
    }
    if (wait.kind === "animate") {
      const args = wait.args.map((arg, index) => ({ name: `arg_${index}`, value: this.expr(arg) }));
      return block([let_("request", request), ...args.map(arg => let_(arg.name, arg.value)), this.trace("command", 0, "animate", rc(rp("Value", "Array"), { kind: "macro", name: ["alloc", "vec"], args: args.map(arg => rm(rp(arg.name), "model_value")) }), { request: rc(rp("Some"), rp("request")) }), re(rm(field("commands"), "push", this.animation("animate", wait.args, rc(rp("Some"), rp("request")), args.map(arg => rp(arg.name)))))], { kind: "struct", path: ["WaitNode", "Delivery"], fields: [{ name: "request", value: rp("request") }] });
    }
    throw new Error(`Model Rust awaitable ${(wait as ModelAwaitable).kind} is not implemented`);
  }
  generate(): string {
    this.items.push({ kind: "extern", name: "alloc" }, { kind: "use", path: ["alloc", "borrow"], names: ["ToOwned"] }, { kind: "use", path: ["alloc", "string"], names: ["String"] }, { kind: "use", path: ["alloc", "vec"], names: ["Vec"] }, { kind: "use", path: ["microts", "model"], names: ["Cmd", "Ready", "Depth", "NodeSlot", "TaskId", "RequestId", "heapless", "Wait", "WaitNode", "ServiceRequests", "TaskState", "TaskOutcome", "TaskValue", "TaskResult", "TaskReady", "Completion", "Value", "ModelValue"] });
    if (this.view) this.items.push({ kind: "use", path: ["super"], names: ["*"] }); else this.emitTypes();
    this.codecs();
    for (const [id, value] of this.constants) {
      if (value.kind === "builtin" && value.name === "embedBytes") this.items.push({ kind: "static", name: this.constantName(id), type: rr({ kind: "slice", element: rt("u8") }, false, "static"), value: { kind: "macro", name: ["include_bytes"], args: [this.embeddedPath(value)] } });
      else if (value.kind === "array" && value.type.kind === "array") this.items.push({ kind: "static", name: this.constantName(id), type: { kind: "array", element: this.type(value.type.element), length: value.items.length }, value: { kind: "array", elements: value.items.map(item => this.expr(item)) } });
      else throw new Error(`Model constant ${id} cannot be stored as a static`);
    }
    for (const module of this.program.modules) this.module(module);
    return printRust({ items: this.items, attributes: [{ name: "allow", args: ["dead_code", "unused_imports", "unused_mut", "non_snake_case", "unused_variables", "unused_labels", "non_upper_case_globals", "unused_braces"] }] });
  }
}

export function generateModelRust(program: ModelProgram, view?: AotProgram): string {
  checkModelVersion(program);
  return new ModelRust(program, view).generate();
}
