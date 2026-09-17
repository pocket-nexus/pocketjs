/** Model IR → Rust AST. The shared printer is the only owner of Rust syntax. */
import type { AotComponent, AotProgram, AotType, AotTypeDeclaration } from "./aot-ir.ts";
import { checkModelVersion, type ModelBinder, type ModelBlock, type ModelExpr, type ModelFunction, type ModelModule, type ModelProgram, type ModelStmt, type ModelTask, type ModelAwaitable } from "./aot-model-ir.ts";
import type { RustBlock, RustExpr, RustField, RustFunction, RustItem, RustParam, RustStatement, RustType } from "./rust-ast.ts";
import { rb, rc, re, ref, rf, rl, rm, rn, rp, rr, rt } from "./rust-ast.ts";
import { printRust, rustVariant } from "./rust-printer.ts";

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

class ModelRust {
  items: RustItem[] = [];
  serial = 0;
  current!: ModelModule;
  mutable = true;
  task: ModelTask | undefined;
  predicates = new Map<ModelAwaitable, number>();
  binders = new Map<number, ModelBinder>();
  modules = new Map<number, ModelModule>();
  functions = new Map<number, ModelFunction>();
  declarations: Map<string, AotTypeDeclaration>;
  constructor(readonly program: ModelProgram, readonly view?: AotProgram) {
    this.declarations = new Map(program.types.map(t => [t.name, t]));
    for (const module of program.modules) for (const func of module.functions) { this.modules.set(func.id, module); this.functions.set(func.id, func); }
  }
  name(id: number) { return `v_${id}`; }
  signal(id: number) { const signal = this.current.signals.find(s => s.id === id); if (!signal) throw new Error(`Unknown model signal ${id}`); return signal; }
  node(id: number) { return [...this.current.signals, ...this.current.memos].find(s => s.id === id)!; }
  storage(id: number): RustExpr {
    if (this.current.params.some(p => p.id === id)) return field(this.name(id));
    if (this.task?.fields.some(p => p.id === id)) return field(`task_${this.task.id}_${this.name(id)}`);
    if ([...this.current.signals, ...this.current.fields, ...this.current.memos].some(p => p.id === id)) return field(this.name(id));
    return rp(this.name(id));
  }
  copy(type: AotType): boolean {
    if (["number", "boolean", "style", "void", "undefined"].includes(type.kind)) return true;
    if (type.kind === "named") { const d = this.declarations.get(type.name); return d?.kind === "enum" || d?.kind === "newtype" && this.copy(d.base); }
    if (type.kind === "option") return this.copy(type.value);
    if (type.kind === "tuple") return type.elements.every(t => this.copy(t));
    return false;
  }
  primitive(type: AotType): boolean { return ["number", "boolean", "string", "style"].includes(type.kind) || type.kind === "named" && this.declarations.get(type.name)?.kind === "enum"; }
  own(value: RustExpr, type: AotType) { return this.copy(type) ? value : rm(value, "clone"); }
  type(type: AotType, borrowed = false, capacity?: number): RustType {
    capacity ??= "capacity" in type ? type.capacity : undefined;
    switch (type.kind) {
      case "number": return rt(type.name);
      case "boolean": return rt("bool");
      case "void": return unit;
      case "undefined": return rt("Option", unit);
      case "style": return rt("pocket_vapor::StyleId");
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
    if (type.kind === "named") {
      const d = this.declarations.get(type.name);
      if (d?.kind === "struct") return { kind: "struct", path: [d.name], fields: d.fields.map(f => ({ name: f.name, value: this.defaultValue(f.type) })) };
      if (d?.kind === "enum") return rp(d.name, rustVariant(d.variants[0]!));
      if (d?.kind === "union") { const v = d.variants[0]!; return { kind: "struct", path: [d.name, rustVariant(v.name)], fields: v.fields.map(f => ({ name: f.name, value: this.defaultValue(f.type) })) }; }
      if (d?.kind === "newtype") return rc(rp(d.name), this.defaultValue(d.base));
    }
    return rc(rp("Default", "default"));
  }
  expr(e: ModelExpr, capacity?: number): RustExpr {
    capacity ??= "capacity" in e.type ? e.type.capacity : undefined;
    switch (e.kind) {
      case "literal": {
        if (e.type.kind === "named") { const d = this.declarations.get(e.type.name); if (d?.kind === "enum") return rp(d.name, rustVariant(String(e.value))); if (d?.kind === "newtype") return rc(rp(d.name), this.expr({ ...e, type: d.base })); }
        if (typeof e.value === "string") return capacity === undefined ? rc(rp("String", "from"), rl(e.value)) : rc({ kind: "path", path: ["pocket_vapor", "model", "bounded_string"], typeArgs: [{ kind: "const", value: capacity }] }, rl(e.value), rl("value"));
        return rl(e.value, e.type.kind === "number" ? e.type.name : undefined, e.rawNumber);
      }
      case "undefined": return rp("None");
      case "local": case "signal": case "field": return this.own(this.storage(e.id), e.type);
      case "memo": return this.mutable ? rm(self, `read_${e.id}`) : this.own(this.storage(e.id), e.type);
      case "member": {
        if (e.variant) {
          const object = this.expr(e.object), d = e.object.type.kind === "named" ? this.declarations.get(e.object.type.name) : undefined;
          if (d?.kind === "union") return { kind: "match", value: object, arms: [ { pattern: { kind: "variant", path: [d.name, rustVariant(e.variant)], fields: [{ name: e.name, pattern: rn("value") }], rest: true }, body: rp("value") }, { pattern: { kind: "wildcard" }, body: { kind: "macro", name: ["unreachable"], args: [] } } ] };
        }
        return this.own(rf(this.expr(e.object), e.name), e.type);
      }
      case "index": return rm(rm(this.expr(e.object), "get", cast(this.expr(e.index), rt("usize"))), "cloned");
      case "copy": return this.expr(e.value, capacity);
      case "cast": return cast(this.expr(e.value), this.type(e.type));
      case "unary": {
        if (e.operator === "+") return this.expr(e.operand);
        const value = this.expr(e.operand);
        return e.operator === "-" && e.type.kind === "number" && !e.type.name.startsWith("f") ? rm(value, "wrapping_neg") : { kind: "unary", operator: e.operator, expr: value };
      }
      case "binary": {
        if (e.operator === "??") return rm(this.expr(e.left), "unwrap_or_else", { kind: "closure", params: [], body: this.expr(e.right) });
        if (["&&", "||"].includes(e.operator)) return bin(e.operator, this.expr(e.left), this.expr(e.right));
        const id = this.serial++, left = rp(`left_${id}`), right = rp(`right_${id}`);
        let result: RustExpr;
        if (e.operator === "+" && e.type.kind === "string") {
          result = capacity === undefined ? rc(rp("pocket_vapor", "model", "concat"), ref(left), ref(right)) : rc({ kind: "path", path: ["pocket_vapor", "model", "bounded_concat"], typeArgs: [{ kind: "const", value: capacity }] }, ref(left), ref(right), rl("value"));
        } else if (e.type.kind === "number" && !e.type.name.startsWith("f") && ["+", "-", "*", "<<", ">>"].includes(e.operator)) {
          result = rm(left, ({ "+": "wrapping_add", "-": "wrapping_sub", "*": "wrapping_mul", "<<": "wrapping_shl", ">>": "wrapping_shr" })[e.operator]!, ["<<", ">>"].includes(e.operator) ? cast(right, rt("u32")) : right);
        } else if (["<", ">", "<=", ">="].includes(e.operator) && e.left.type.kind === "string") result = bin(e.operator, rc(rp("pocket_vapor", "builtins", "string_compare"), ref(left), ref(right)), rl(0));
        else result = bin(e.operator === "===" ? "==" : e.operator === "!==" ? "!=" : e.operator, left, right);
        return block([let_(`left_${id}`, this.expr(e.left, capacity)), let_(`right_${id}`, this.expr(e.right, capacity))], result);
      }
      case "conditional": return { kind: "if", condition: this.expr(e.condition), then: rb([], this.expr(e.consequent, capacity)), otherwise: rb([], this.expr(e.alternate, capacity)) };
      case "template": {
        const name = `text_${this.serial++}`, statements: RustStatement[] = [let_(name, capacity === undefined ? rc(rp("String", "new")) : rc({ kind: "qualifiedPath", type: this.type({ kind: "string" }, false, capacity), member: "new" }), true)];
        for (const part of e.parts) statements.push(re(rc(rp("pocket_vapor", "model", capacity === undefined ? "append_display" : "append_bounded_display"), ref(rp(name), true), ref(typeof part === "string" ? rl(part) : this.expr(part)), ...(capacity === undefined ? [] : [rl("value")]))));
        return block(statements, rp(name));
      }
      case "struct": return { kind: "struct", path: e.variant ? [e.name, rustVariant(e.variant)] : [e.name], fields: e.fields.map(f => ({ name: f.name, value: this.expr(f.value) })) };
      case "array": return e.type.kind === "array" && e.type.length !== undefined ? { kind: "array", elements: e.items.map(item => this.expr(item)) } : capacity !== undefined ? rc({ kind: "path", path: ["pocket_vapor", "model", "bounded_array"], typeArgs: [this.type(e.element), { kind: "const", value: capacity }] }, { kind: "array", elements: e.items.map(item => this.expr(item)) }, rl("value")) : { kind: "macro", name: ["alloc", "vec"], args: e.items.map(item => this.expr(item)) };
      case "invoke": return this.invoke(e.callee, e.args);
      case "builtin": return this.builtin(e);
      case "lambda": return { kind: "closure", params: e.params.map(p => rn(this.name(p.id))), body: block(this.statements(e.body)) };
      case "sequence": return block(this.statements(e.body), this.expr(e.value, capacity));
    }
  }
  invoke(id: number, args: ModelExpr[]): RustExpr {
    const module = this.modules.get(id), func = this.functions.get(id);
    if (!func || !module) throw new Error(`Unknown model function ${id}`);
    const callArgs = args.map(arg => this.expr(arg));
    if (module.kind === "pure") return rc(rp(`pure_${id}`), this.current.kind === "pure" ? rp("depth") : ref(field("depth")), ...callArgs);
    if (func.async) return rm(self, `start_${id}`, ...callArgs);
    return rm(self, `${this.mutable ? "fn" : "render_fn"}_${id}`, ...callArgs);
  }
  builtin(e: Extract<ModelExpr, { kind: "builtin" }>): RustExpr {
    const args = e.args.map(arg => this.expr(arg));
    if (e.name === "copy") return args[0]!;
    if (e.name === "equals") return bin("==", args[0]!, args[1]!);
    if (e.name === "String") return rc(rp("pocket_vapor", "model", "to_string"), ref(args[0]!));
    if (e.name === "len") return rc(rp("pocket_vapor", "builtins", "len"), ref(args[0]!));
    if (["map", "filter", "find", "some"].includes(e.name)) {
      const collection = `items_${this.serial++}`, closure = e.args[1];
      if (closure?.kind !== "lambda") throw new Error(`${e.name} requires a bound lambda`);
      const body = this.statements(closure.body), parameter = this.name(closure.params[0]!.id), statements = [let_(collection, args[0]!)];
      const closureExpr: RustExpr = { kind: "closure", params: [rn(parameter)], body: block(body) };
      let iter = rm(rp(collection), "into_iter");
      if (e.name === "some") return block(statements, rm(iter, "any", closureExpr));
      if (e.name === "filter" || e.name === "find") closureExpr.body = block([let_(parameter, rm(rp(parameter), "clone")), ...body]);
      iter = rm(iter, e.name, closureExpr);
      return block(statements, e.name === "find" ? iter : { kind: "method", object: iter, method: "collect", args: [], typeArgs: [this.type(e.type)] });
    }
    return rc(rp("pocket_vapor", "builtins", e.name), ...args);
  }
  statements(body: ModelBlock): RustStatement[] { return body.stmts.flatMap(stmt => this.statement(stmt)); }
  statement(s: ModelStmt): RustStatement[] {
    switch (s.kind) {
      case "let": this.binders.set(s.binder.id, s.binder); return this.task?.fields.some(p => p.id === s.binder.id) ? [assign(this.storage(s.binder.id), this.expr(s.init, s.binder.capacity))] : [let_(this.name(s.binder.id), this.expr(s.init, s.binder.capacity), true, this.type(s.binder.type, false, s.binder.capacity))];
      case "assign": {
        const t = s.target, target = "id" in t ? this.storage(t.id) : t.kind === "member" ? rf(this.storage(t.owner), t.name) : { kind: "index", object: this.storage(t.owner), index: cast(this.expr(t.index), rt("usize")) } as RustExpr;
        return [assign(target, this.expr(s.value))];
      }
      case "set": {
        const signal = this.signal(s.signal), prefix = s.pre ? [let_(this.name(s.pre.id), this.own(this.storage(s.signal), signal.type))] : [];
        if (s.writeBack) return prefix;
        const valueName = `write_${this.serial++}`;
        return [...prefix, let_(valueName, this.expr(s.value, signal.capacity)), re(rm(self, `write_${s.signal}`, rp(valueName)))];
      }
      case "if": return [condition(this.expr(s.condition), this.statements(s.then), s.else ? rb(this.statements(s.else)) : undefined)];
      case "untrack": case "batch": return [re(block(this.statements(s.body)))];
      case "for": {
        const bound = `bound_${this.serial++}`, index = this.name(s.binder.id);
        return [let_(bound, this.expr(s.bound)), let_(index, s.start ? this.expr(s.start) : rl(0, "i32"), true), { kind: "while", condition: bin(s.inclusive ? "<=" : "<", rp(index), rp(bound)), body: rb([...this.statements(s.body), assign(rp(index), rm(rp(index), "wrapping_add", rl(1)))]) }];
      }
      case "forOf": return [{ kind: "for", pattern: rn(this.name(s.binder.id)), iterable: this.expr(s.source), body: rb(this.statements(s.body)) }];
      case "switch": {
        const value = `switch_${this.serial++}`;
        let next: RustBlock = rb();
        for (const arm of [...s.cases].reverse()) next = arm.value ? rb([condition(bin("==", rp(value), this.expr(arm.value)), this.statements(arm.body), next)]) : rb(this.statements(arm.body));
        return [let_(value, this.expr(s.value)), ...next.statements];
      }
      case "return": {
        if (this.task) return [re(rm(field(`task_${this.task.id}`), "finish", s.value ? rm(this.expr(s.value), "model_value") : rp("Value", "Unit"), ref(field("outcomes"), true))), { kind: "return" }];
        return [{ kind: "return", value: s.value ? this.expr(s.value) : undefined }];
      }
      case "call": return [re(this.invoke(s.callee, s.args))];
      case "expr": return [re(this.expr(s.value))];
      case "external": {
        if (s.op === "log") {
          const name = `log_${this.serial++}`;
          return [let_(name, rc(rp("String", "new")), true), ...s.args.flatMap((arg, index) => [...(index ? [re(rm(rp(name), "push_str", rl(" ")))] : []), re(rc(rp("pocket_vapor", "model", "append_display"), ref(rp(name), true), ref(this.expr(arg))))]), condition({ kind: "macro", name: ["cfg"], args: [rp("debug_assertions")] }, [re(rm(field("commands"), "push", rc(rp("Cmd", "Log"), rp(name))))])];
        }
        if (s.op === "cancel") return s.args.map(arg => re(rm(self, `cancel_${arg.kind === "literal" ? arg.value : "id" in arg ? arg.id : 0}`)));
        throw new Error(`Model Rust external ${s.op} is not implemented`);
      }
      case "start": return [re(rm(self, `start_${this.current.tasks.find(t => t.id === s.task)?.fn ?? s.task}`, ...s.args.map(arg => this.expr(arg))))];
      case "await": throw new Error("Unlowered await reached Model Rust generation");
    }
  }
  function(func: ModelFunction, render = false): RustFunction {
    const previous = this.mutable; this.mutable = !render;
    const depth = this.current.kind === "pure" ? rp("depth") : field("depth");
    const body = this.statements(func.body);
    const expression: RustExpr = rc({ kind: "closure", params: [], body: block(body) });
    const result = fn(this.current.kind === "pure" ? `pure_${func.id}` : `${render ? "render_fn" : "fn"}_${func.id}`, [ ...(this.current.kind === "pure" ? [param("depth", rr(rt("Depth")))] : [receiver(!render)]), ...func.params.map(p => param(this.name(p.id), this.type(p.type, false, p.capacity))) ], rb([re(rm(depth, "enter", rl(func.name))), let_("result", expression), re(rm(depth, "leave"))], rp("result")), this.type(func.returns));
    this.mutable = previous; return result;
  }
  emitTypes() {
    for (const d of this.program.types) {
      if (d.kind === "struct") this.items.push({ kind: "struct", name: d.name, public: true, derives: ["Clone", "Debug", "PartialEq"], fields: d.fields.map(f => ({ ...f, public: true, type: this.type(f.type) })) });
      else if (d.kind === "enum") this.items.push({ kind: "enum", name: d.name, public: true, derives: ["Clone", "Copy", "Debug", "PartialEq"], variants: d.variants.map(name => ({ name: rustVariant(name) })) });
      else if (d.kind === "union") this.items.push({ kind: "enum", name: d.name, public: true, derives: ["Clone", "Debug", "PartialEq"], variants: d.variants.map(v => ({ name: rustVariant(v.name), fields: v.fields.map(f => ({ name: f.name, type: this.type(f.type) })) })) });
      else this.items.push({ kind: "struct", name: d.name, public: true, derives: ["Clone", "Copy", "Debug", "PartialEq"], tuple: [this.type(d.base)] });
    }
  }
  module(module: ModelModule) {
    this.current = module;
    if (module.kind === "pure") { for (const func of module.functions) this.items.push(this.function(func)); return; }
    const modelName = `${module.name}Model`, traitName = `${module.name}ViewModel`;
    const fields: RustField[] = [{ name: "depth", type: rt("Depth") }, { name: "commands", type: rt("Vec", rt("Cmd")) }, { name: "instance", type: rt("u32") }, { name: "frame", type: rt("u64") }, { name: "now_ms", type: rt("f64") }, { name: "resumed", type: rt("bool") }];
    const seeds: { name: string; value: RustExpr }[] = [ { name: "depth", value: rc(rp("Depth", "new"), rl(this.program.recursionLimit, "u32")) }, { name: "commands", value: rc(rp("Vec", "new")) }, { name: "instance", value: rc(rp("pocket_vapor", "model", "next_region")) }, { name: "frame", value: rl(0) }, { name: "now_ms", value: rl(0, "f64") }, { name: "resumed", value: rl(false) } ];
    const methods: RustFunction[] = [], traitMethods: RustFunction[] = [];
    for (const p of module.params) { fields.push({ name: this.name(p.id), type: this.type(p.type, false, p.capacity) }); seeds.push({ name: this.name(p.id), value: rp(this.name(p.id)) }); }
    for (const s of [...module.signals, ...module.fields]) { fields.push({ name: this.name(s.id), type: this.type(s.type, false, s.capacity) }); seeds.push({ name: this.name(s.id), value: this.expr(s.seed, s.capacity) }); }
    for (const s of module.signals) {
      fields.push({ name: `version_${s.id}`, type: rt("u32") }, { name: `changed_${s.id}`, type: rt("bool") });
      seeds.push({ name: `version_${s.id}`, value: rl(1) }, { name: `changed_${s.id}`, value: rl(false) });
      const write = [assign(this.storage(s.id), rp("value")), assign(field(`version_${s.id}`), rm(field(`version_${s.id}`), "wrapping_add", rl(1))), assign(field(`changed_${s.id}`), rl(true))];
      methods.push(fn(`write_${s.id}`, [receiver(true), param("value", this.type(s.type, false, s.capacity))], rb(this.primitive(s.type) ? [condition(bin("!=", rp("value"), this.storage(s.id)), write)] : write)));
    }
    for (const memo of module.memos) {
      fields.push({ name: this.name(memo.id), type: this.type(memo.type) }, { name: `version_${memo.id}`, type: rt("u32") }, { name: `changed_${memo.id}`, type: rt("bool") }, { name: `initialized_${memo.id}`, type: rt("bool") });
      seeds.push({ name: this.name(memo.id), value: this.defaultValue(memo.type) }, { name: `version_${memo.id}`, value: rl(0) }, { name: `changed_${memo.id}`, value: rl(false) }, { name: `initialized_${memo.id}`, value: rl(false) });
      for (const input of memo.inputs) { fields.push({ name: `seen_${memo.id}_${input}`, type: rt("u32") }); seeds.push({ name: `seen_${memo.id}_${input}`, value: rl(0) }); }
      const updates = [assign(this.storage(memo.id), rp("value")), assign(field(`version_${memo.id}`), rm(field(`version_${memo.id}`), "wrapping_add", rl(1))), assign(field(`changed_${memo.id}`), rl(true))];
      methods.push(fn(`read_${memo.id}`, [receiver(true)], rb([
        ...memo.inputs.filter(input => module.memos.some(m => m.id === input)).map(input => re(rm(self, `read_${input}`))),
        condition(or([{ kind: "unary", operator: "!", expr: field(`initialized_${memo.id}`) }, ...memo.inputs.map(input => bin("!=", field(`seen_${memo.id}_${input}`), field(`version_${input}`)))]), [let_("value", this.expr(memo.body)), ...(this.primitive(memo.type) ? [condition(bin("!=", rp("value"), this.storage(memo.id)), updates)] : updates), ...memo.inputs.map(input => assign(field(`seen_${memo.id}_${input}`), field(`version_${input}`))), assign(field(`initialized_${memo.id}`), rl(true))]),
      ], this.own(this.storage(memo.id), memo.type)), this.type(memo.type)));
    }
    for (const reference of module.refs) { fields.push({ name: this.name(reference.id), type: rt("NodeSlot") }); seeds.push({ name: this.name(reference.id), value: rc(rp("NodeSlot", "default")) }); }
    for (const effect of module.effects) methods.push(fn(`effect_${effect.id}`, [receiver(true)], rb(this.statements(effect.body))));
    for (const func of module.functions.filter(f => !f.async)) { methods.push(this.function(func)); if (!func.ledger.writes.length && !func.ledger.external) methods.push(this.function(func, true)); }
    this.tasks(module, fields, seeds, methods, traitMethods);
    const memoOrder = module.schedule.filter(id => module.memos.some(m => m.id === id));
    const reset = () => [...module.signals, ...module.memos].map(s => assign(field(`changed_${s.id}`), rl(false)));
    const newBody = rb([let_("model", { kind: "struct", path: ["Self"], fields: seeds }, true), ...memoOrder.map(id => re(rm(rp("model"), `read_${id}`))), ...[...module.signals, ...module.memos].map(s => assign(rf(rp("model"), `changed_${s.id}`), rl(false)))], rp("model"));
    if (module.params.length) methods.push(fn("new", module.params.map(p => param(this.name(p.id), this.type(p.type))), newBody, rt("Self"), true));
    else this.items.push({ kind: "impl", type: rt(modelName), trait: rt("Default"), methods: [fn("default", [], newBody, rt("Self"))] });
    const view = this.view?.components.find(c => c.name === module.name);
    for (const value of view?.values ?? [...module.signals, ...module.memos].filter(s => s.exported).map(s => ({ ...s, sourceName: s.name, writable: module.signals.some(signal => signal.id === s.id) }))) {
      const target = [...module.signals, ...module.memos].find(s => s.name === value.sourceName || s.name === value.name); if (!target) throw new Error(`No model source for ${module.name}.${value.name}`);
      traitMethods.push(fn(value.name, [receiver()], rb([], this.borrowed(this.storage(target.id), target.type)), this.type(value.type, true)));
      if (module.memos.some(m => m.id === target.id)) traitMethods.push(fn(`${value.name}_now`, [receiver(true)], rb([re(rm(self, `read_${target.id}`))], this.borrowed(this.storage(target.id), target.type)), this.type(value.type, true)));
      if (value.writable) {
        const signal = this.signal(target.id);
        const val = signal.capacity === undefined ? rp("value") : rc({ kind: "path", path: ["pocket_vapor", "model", signal.type.kind === "string" ? "bounded_string" : "bounded_array"], typeArgs: signal.type.kind === "string" ? [{ kind: "const", value: signal.capacity }] : [this.type((signal.type as Extract<AotType, { kind: "array" }>).element), { kind: "const", value: signal.capacity }] }, signal.type.kind === "string" ? ref(rp("value")) : rp("value"), rl(signal.name));
        traitMethods.push(fn(`set_${value.name}`, [receiver(true), param("value", this.type(value.type))], rb([re(rm(self, `write_${target.id}`, val))])));
      }
    }
    for (const f of view?.functions ?? module.functions.filter(f => f.exported).map(f => ({ name: f.name, sourceName: f.name, parameters: f.params, returns: f.returns, handler: f.async || f.ledger.writes.length > 0 || f.ledger.external, binding: false }))) {
      const func = module.functions.find(item => item.name === f.sourceName || item.name === f.name); if (!func) throw new Error(`No model source for ${module.name}.${f.name}`);
      const mutable = f.handler || func.async;
      traitMethods.push(fn(f.name, [receiver(mutable), ...f.parameters.map(p => param(p.name, this.type(p.type)))], func.async ? rb([re(rm(self, `start_${func.id}`, ...f.parameters.map(p => rp(p.name))))]) : rb([], rm(self, `${mutable ? "fn" : "render_fn"}_${func.id}`, ...f.parameters.map(p => rp(p.name)))), func.async ? unit : this.type(f.returns)));
    }
    for (const reference of module.refs) traitMethods.push(fn(reference.name, [receiver()], rb([], ref(this.storage(reference.id))), rr(rt("NodeSlot"))));
    traitMethods.push(fn("react", [receiver(true), param("initial", rt("bool")), param("cmds", rr(rt("Vec", rt("Cmd")), true))], rb([
      ...module.schedule.map(id => { const effect = module.effects.find(e => e.id === id); return effect ? condition(or([...(effect.defer ? [] : [rp("initial")]), bin("&&", { kind: "unary", operator: "!", expr: rp("initial") }, or(effect.subscriptions.map(s => field(`changed_${s}`))))]), [re(rm(self, `effect_${id}`))]) : re(rm(self, `read_${id}`)); }),
      ...reset(), assign(field("resumed"), rl(false)), re(rm(rp("cmds"), "append", ref(field("commands"), true))),
    ])));
    traitMethods.push(fn("settle", [receiver(true)], rb([...memoOrder.map(id => re(rm(self, `read_${id}`))), ...reset()])));
    traitMethods.push(fn("model_changed", [receiver()], rb([], or([field("resumed"), ...module.signals.map(s => field(`changed_${s.id}`)), { kind: "unary", operator: "!", expr: rm(field("commands"), "is_empty") }])), rt("bool")));
    if (!module.tasks.length) traitMethods.push(fn("resume", [receiver(true), param("ready", rr(rt("Ready"))), param("_cmds", rr(rt("Vec", rt("Cmd")), true))], rb([assign(field("frame"), rf(rp("ready"), "frame")), assign(field("now_ms"), rf(rp("ready"), "now_ms"))])));
    this.items.push({ kind: "struct", name: modelName, public: true, fields });
    this.items.push({ kind: "impl", type: rt(modelName), methods });
    if (!this.view) this.items.push({ kind: "trait", name: traitName, public: true, methods: traitMethods.map(f => ({ ...f, body: undefined })) });
    const children = view?.children.filter(name => this.view!.components.find(c => c.name === name)?.factory) ?? [];
    this.items.push({ kind: "impl", type: rt(modelName), trait: rt(traitName), associatedTypes: [...new Set(children)].map(name => ({ name, type: rt(`${name}Model`) })), methods: traitMethods });
  }
  tasks(module: ModelModule, fields: RustField[], seeds: { name: string; value: RustExpr }[], methods: RustFunction[], traitMethods: RustFunction[]) {
    if (!module.tasks.length) return;
    fields.push({ name: "task_order", type: rt("u64") }, { name: "outcomes", type: rt("Vec", rt("TaskOutcome")) });
    seeds.push({ name: "task_order", value: rl(0) }, { name: "outcomes", value: rc(rp("Vec", "new")) });
    const predicates: RustExpr[] = [];
    const predicateWalk = (awaitable: ModelAwaitable) => {
      if (awaitable.kind === "until") {
        const id = this.predicates.size; this.predicates.set(awaitable, id);
        predicates.push({ kind: "tuple", elements: [rl(id, "u32"), this.expr(awaitable.predicate)] });
      }
      if (awaitable.kind === "all" || awaitable.kind === "any") awaitable.members.forEach(predicateWalk);
    };
    for (const task of module.tasks) {
      const func = this.functions.get(task.fn)!;
      this.task = { ...task, fields: [...new Map([...task.fields, ...func.params].map(p => [p.id, p])).values()] };
      const taskField = field(`task_${task.id}`);
      fields.push({ name: `task_${task.id}`, type: rt("TaskState") });
      seeds.push({ name: `task_${task.id}`, value: rc(rp("TaskState", "default")) });
      for (const binder of this.task.fields) {
        fields.push({ name: `task_${task.id}_${this.name(binder.id)}`, type: this.type(binder.type, false, binder.capacity) });
        seeds.push({ name: `task_${task.id}_${this.name(binder.id)}`, value: this.defaultValue(binder.type) });
      }
      for (const state of task.states) if (state.suspend) predicateWalk(state.suspend);
      methods.push(fn(`cancel_${func.id}`, [receiver(true)], rb([re(rm(taskField, "cancel", ref(field("commands"), true), ref(field("outcomes"), true)))])));
      methods.push(fn(`start_${func.id}`, [receiver(true), ...func.params.map(p => param(this.name(p.id), this.type(p.type)))], rb([
        re(rm(self, `cancel_${func.id}`)),
        assign(field("task_order"), rm(field("task_order"), "wrapping_add", rl(1))),
        let_("task", rm(taskField, "start", field("instance"), rl(func.id, "u32"), field("task_order"))),
        ...func.params.map(p => assign(this.storage(p.id), rp(this.name(p.id)))),
        re(rm(self, `segment_${func.id}`, rl(0), rp("None"))),
      ], rp("task")), rt("TaskId")));
      const arms = task.states.map(state => {
        const previous = task.states.find(candidate => candidate.suspend && (candidate.next ?? candidate.id + 1) === state.id && candidate.resume);
        const body: RustStatement[] = [];
        if (previous?.resume) {
          const target = this.storage(previous.resume.id);
          const value = rc({ kind: "path", path: ["pocket_vapor", "model", "decode"], typeArgs: [this.type(previous.resume.type)] }, rm(rm(rp("result"), "as_ref"), "expect", rl("missing task completion")));
          if (this.task!.fields.some(p => p.id === previous.resume!.id)) body.push(assign(target, value));
          else body.push(let_(this.name(previous.resume.id), value, true, this.type(previous.resume.type)));
        }
        body.push(...this.statements(state.body));
        if (state.suspend) {
          body.push(assign(rf(taskField, "wait_generation"), rm(rf(taskField, "wait_generation"), "wrapping_add", rl(1))));
          const wait = this.awaitable(state.suspend, task, { member: 0 });
          body.push(let_("wait", wait), re(rm(taskField, "suspend", rl(state.next ?? state.id + 1, "u32"), field("frame"), rp("wait"))), { kind: "return" });
        } else if (state.branch) body.push(assign(rp("state"), { kind: "if", condition: this.expr(state.branch.condition), then: rb([], rl(state.branch.then, "u32")), otherwise: rb([], rl(state.branch.else, "u32")) }), { kind: "continue" });
        else if (state.next !== undefined) body.push(assign(rp("state"), rl(state.next, "u32")), { kind: "continue" });
        else body.push(re(rm(taskField, "finish", rp("Value", "Unit"), ref(field("outcomes"), true))), { kind: "return" });
        return { pattern: { kind: "literal" as const, value: state.id }, body: block(body) };
      });
      arms.push({ pattern: { kind: "wildcard" } as never, body: { kind: "macro", name: ["unreachable"], args: [] } });
      methods.push(fn(`segment_${func.id}`, [receiver(true), { pattern: rn("state", true), type: rt("u32") }, param("result", rt("Option", rt("Completion")))], rb([{ kind: "loop", body: rb([re({ kind: "match", value: rp("state"), arms })]) }])));
    }
    this.task = undefined;
    const readyItems = module.tasks.map(task => ({ kind: "tuple" as const, elements: [rf(field(`task_${task.id}`), "order"), rl(task.id, "u32"), rm(field(`task_${task.id}`), "poll", rp("ready"), ref(rp("predicates")), ref(field("outcomes")))] }));
    const branches = module.tasks.map(task => ({ pattern: { kind: "literal" as const, value: task.id }, body: block([
      condition({ kind: "matches", value: rp("completion"), pattern: { kind: "variant", path: ["Completion", "Cancelled"] } }, [re(rm(self, `cancel_${task.fn}`))], rb([
        re(rm(field(`task_${task.id}`), "complete_wait", ref(field("commands"), true))),
        let_("state", rf(field(`task_${task.id}`), "state")),
        re(rm(self, `segment_${task.fn}`, rp("state"), rc(rp("Some"), rp("completion")))),
      ])),
    ]) }));
    branches.push({ pattern: { kind: "wildcard" } as never, body: { kind: "macro", name: ["unreachable"], args: [] } });
    traitMethods.push(fn("resume", [receiver(true), param("ready", rr(rt("Ready"))), param("cmds", rr(rt("Vec", rt("Cmd")), true))], rb([
      assign(field("frame"), rf(rp("ready"), "frame")), assign(field("now_ms"), rf(rp("ready"), "now_ms")),
      let_("predicates", { kind: "array", elements: predicates }, false, { kind: "array", element: { kind: "tuple", elements: [rt("u32"), rt("bool")] }, length: predicates.length }),
      let_("resumptions", { kind: "array", elements: readyItems }, true),
      re(rm(rp("resumptions"), "sort_by_key", { kind: "closure", params: [rn("entry")], body: rf(rp("entry"), 0) })),
      { kind: "for", pattern: { kind: "tuple", elements: [{ kind: "wildcard" }, rn("function"), rn("completion")] }, iterable: rp("resumptions"), body: rb([re({ kind: "ifLet", pattern: { kind: "variant", path: ["Some"], tuple: [rn("completion")] }, value: rp("completion"), then: rb([assign(field("resumed"), rl(true)), re({ kind: "match", value: rp("function"), arms: branches })]) })]) },
      re(rm(rp("cmds"), "append", ref(field("commands"), true))),
    ])));
    traitMethods.push(fn("cancel_tasks", [receiver(true), param("cmds", rr(rt("Vec", rt("Cmd")), true))], rb([
      ...module.tasks.map(task => re(rm(self, `cancel_${task.fn}`))), re(rm(rp("cmds"), "append", ref(field("commands"), true))),
    ])));
  }
  awaitable(wait: ModelAwaitable, task: ModelTask, sequence: { member: number }): RustExpr {
    const taskField = field(`task_${task.id}`);
    if (wait.kind === "all" || wait.kind === "any") return rc(rp("Wait", wait.kind === "all" ? "All" : "Any"), { kind: "macro", name: ["alloc", "vec"], args: wait.members.map(member => this.awaitable(member, task, sequence)) });
    const request = rm(taskField, "request", rl(sequence.member++, "u32"));
    const value = (variant: string, fields: { name: string; value: RustExpr }[]): RustExpr => ({ kind: "struct", path: ["Wait", variant], fields: [{ name: "request", value: request }, ...fields] });
    if (wait.kind === "frames") return value("Frames", [{ name: "until", value: rm(field("frame"), "wrapping_add", cast(this.expr(wait.count), rt("u64"))) }]);
    if (wait.kind === "after") return value("After", [{ name: "until", value: bin("+", field("now_ms"), cast(this.expr(wait.ms), rt("f64"))) }]);
    if (wait.kind === "until") return value("Until", [{ name: "predicate", value: rl(this.predicates.get(wait)!, "u32") }]);
    if (wait.kind === "join") {
      const target = this.current.tasks.find(candidate => candidate.id === wait.task || candidate.fn === wait.task);
      if (!target) throw new Error(`Unknown joined task ${wait.task}`);
      return block([let_("joined", rm(self, `start_${target.fn}`, ...(wait.args ?? []).map(arg => this.expr(arg))))], value("Join", [{ name: "target", value: rp("joined") }, { name: "wrapped", value: rl(wait.wrapped) }]));
    }
    if (wait.kind === "service") return block([let_("request", request), re(rm(field("commands"), "push", { kind: "struct", path: ["Cmd", "Request"], fields: [ { name: "service", value: rc(rp("String", "from"), rl(wait.module)) }, { name: "call", value: rc(rp("String", "from"), rl(wait.call)) }, { name: "args", value: { kind: "macro", name: ["alloc", "vec"], args: wait.args.map(arg => rm(this.expr(arg), "model_value")) } }, { name: "request", value: rp("request") } ] }))], { kind: "struct", path: ["Wait", "Delivery"], fields: [{ name: "request", value: rp("request") }] });
    throw new Error(`Model Rust awaitable ${wait.kind} is not implemented`);
  }
  generate(): string {
    this.items.push({ kind: "extern", name: "alloc" }, { kind: "use", path: ["alloc", "string"], names: ["String"] }, { kind: "use", path: ["alloc", "vec"], names: ["Vec"] }, { kind: "use", path: ["pocket_vapor", "model"], names: ["Cmd", "Ready", "Depth", "NodeSlot", "TaskId", "RequestId", "heapless", "Wait", "TaskState", "TaskOutcome", "Completion", "Value", "ModelValue"] });
    if (this.view) this.items.push({ kind: "use", path: ["super"], names: ["*"] }); else this.emitTypes();
    for (const module of this.program.modules) this.module(module);
    return printRust({ items: this.items, attributes: [{ name: "allow", args: ["dead_code", "unused_imports", "unused_mut", "non_snake_case", "unused_variables"] }] });
  }
}

export function generateModelRust(program: ModelProgram, view?: AotProgram): string {
  checkModelVersion(program);
  return new ModelRust(program, view).generate();
}
