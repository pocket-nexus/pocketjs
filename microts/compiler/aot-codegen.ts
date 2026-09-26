import { attachAotModel, checkAotVersion } from "./aot-ir";
import type { AotComponent, AotExpr, AotHandler, AotNode, AotProgram, AotType, AotTypeDeclaration } from "./aot-ir";
import type { RustBlock, RustExpr, RustField, RustFunction, RustItem, RustModule, RustParam, RustPattern, RustStatement, RustType } from "./rust-ast";
import { rb, rc, re, ref, rf, rl, rm, rn, rp, rr, rt } from "./rust-ast";
import { allocateRustTypeNames, printRust, rustVariant } from "./rust-printer";
import { parseMicroTsColor, MICROTS_ELEMENTS } from "../../contracts/spec/microts";
import { generateAotApp, generateAotLifecycle, generateAotReconcile } from "./aot-app-codegen";
import { MOTION_VALUES, motionValueParameters, type MotionValueName } from "../../contracts/spec/motion";

const motionValueName = (id: number) => (Object.keys(MOTION_VALUES) as MotionValueName[]).find(name => MOTION_VALUES[name].id === id)!;

type Locals = Map<string, AotType>;
type ExpandedNode = AotNode;
interface Expansion {
  props: Map<string, AotExpr>;
  events: Map<string, { handler: AotHandler; expansion: Expansion }>;
  slots: Map<string, Extract<AotNode, { kind: "component" }>["slots"][number]>;
  locals?: Map<string, AotExpr>;
  slotExpansion?: Expansion;
  component: AotComponent;
}
interface GeneratedBlock { name: string; locals: Locals; generic: boolean; broadcast: boolean; states: string[] }
const self = rp("self"), ui = rp("ui"), vm = rp("vm"), props = rp("props"), anchor = rp("anchor"), parent = rp("parent");
const none = rp("None"), noNode = rp("NodeId", "NONE");
const unit: RustType = { kind: "tuple", elements: [] };
const stmtLet = (name: string, value: RustExpr, mutable = false, type?: RustType): RustStatement => ({ kind: "let", pattern: rn(name, mutable), value, type });
const assign = (target: RustExpr, value: RustExpr): RustStatement => ({ kind: "assign", target, value });
const binary = (operator: string, left: RustExpr, right: RustExpr): RustExpr => ({ kind: "binary", operator, left, right });
const cast = (expr: RustExpr, type: RustType): RustExpr => ({ kind: "cast", expr, type });
const blockExpr = (statements: RustStatement[], result?: RustExpr): RustExpr => ({ kind: "block", block: rb(statements, result) });
const ifExpr = (condition: RustExpr, statements: RustStatement[], otherwise?: RustBlock): RustExpr => ({ kind: "if", condition, then: rb(statements), otherwise });
const some = (e: RustExpr): RustExpr => rc(rp("Some"), e);
const param = (name: string, type: RustType): RustParam => ({ pattern: rn(name), type });
const receiver = (mutable = false): RustParam => param("self", rr(rt("Self"), mutable));
const ownedReceiver: RustParam = { pattern: rn("self") };
const nodeParams = [param("ui", rr(rt("Ui"), true)), param("parent", rt("NodeId")), param("anchor", rt("NodeId"))];
const emptyPattern: RustPattern = { kind: "wildcard" };

/** This pass creates only Rust AST nodes. The printer owns all Rust syntax. */
class Lowerer {
  items: RustItem[] = [];
  serial = 0;
  lifecycle: boolean;
  current!: AotComponent;
  declarations: Map<string, AotTypeDeclaration>;
  components: Map<string, AotComponent>;
  typeNames: Map<string, string>;
  variantNames = new Map<string, Map<string, string>>();
  blocks = new Map<string, { generic: boolean; broadcast: boolean; owner: string; states: string[]; pending?: RustExpr; sample?: RustStatement[]; count?: RustExpr; placement?: RustStatement[]; pendingAfter?: RustBlock }>();
  eventExpressions = new Map<string, RustExpr>();
  eventUses = new Map<string, number>();
  constantNames = new Map<string, string>();
  resolvedConstants = new WeakMap<AotExpr, string>();
  derives = new Map<string, Set<string>>();
  staticStates = new Map<string, Set<string>>();
  scopedLocals = new Set<string>();
  explicitSlotUpdates = new WeakSet<RustExpr>();
  asyncDispatch: boolean;
  constructor(readonly program: AotProgram) {
    this.asyncDispatch = program.components.some(component => component.functions.some(fn => fn.async));
    this.lifecycle = !!program.modelProtocol || program.components.some(component => !!component.hooks?.mount || !!component.hooks?.unmount);
    this.declarations = new Map(program.types.map(t => [t.name, t]));
    this.components = new Map(program.components.map(c => [c.name, c]));
    const usedConstants = new Set<string>();
    for (const component of [...program.components].sort((a, b) => Number(b.root) - Number(a.root))) for (const constant of component.constants) {
      const base = usedConstants.has(constant.name) ? `${component.name}_${constant.name}` : constant.name;
      let name = base, suffix = 2; while (usedConstants.has(name)) name = `${base}_${suffix++}`;
      usedConstants.add(name); this.constantNames.set(`${component.name}:${constant.name}`, name);
    }
    const reserved = new Set(["Ui", "NodeId", "StyleId", "Input", "Block", "KeyedList", "SlotHandle", "String", "ToString", "Vec", "Option", "ToOwned", "Write", "AotLifecycle", "Unmounted", "Default", "Self", "self", "crate", "super", "M", "H", "bool", "str", "i8", "i16", "i32", "i64", "u8", "u16", "u32", "u64", "usize", "f32", "f64"]);
    for (const c of program.components) { for (const suffix of ["View", "ViewState", "Props", "Event", "ViewModel", "App", "SlotArguments", "SlotEvent"]) reserved.add(`${c.name}${suffix}`); reserved.add(`State${c.name}`); }
    this.typeNames = allocateRustTypeNames(program.types.map(t => t.name), name => reserved.has(name) || program.components.some(c => ["Node", "Block", "If", "For", "Slot", "SlotContent", "Component", "Input"].some(s => name.startsWith(`${c.name}${s}`) && /^\d+$/.test(name.slice(c.name.length + s.length)))));
    for (const t of program.types) if (t.kind === "enum" || t.kind === "union") {
      const used = new Set<string>(); const map = new Map<string, string>();
      for (const value of t.kind === "enum" ? t.variants : t.variants.map(v => v.name)) {
        const base = rustVariant(value); let name = base; let suffix = 2;
        while (used.has(name)) name = `${base}${suffix++}`;
        used.add(name); map.set(value, name);
      }
      this.variantNames.set(t.name, map);
    }
  }
  constantName(name: string, component = this.current): string { return this.constantNames.get(`${component.name}:${name}`) ?? name; }
  constantExpressionName(expression: Extract<AotExpr, { kind: "constant" }>): string { return this.resolvedConstants.get(expression) ?? this.constantName(expression.name); }
  variant(type: string, value: string) { return this.variantNames.get(type)?.get(value) ?? rustVariant(value); }
  typeName(name: string): string { return this.typeNames.get(name) ?? name; }
  localName(name: string): string { return `__pocket_local_${name}`; }
  copy(type: AotType): boolean {
    if (type.kind === "style" || type.kind === "number" || type.kind === "boolean" || type.kind === "void") return true;
    if (type.kind === "option") return this.copy(type.value);
    if (type.kind === "tuple") return type.elements.every(t => this.copy(t));
    if (type.kind === "named") { const d = this.declarations.get(type.name); return d?.kind === "enum" || (d?.kind === "newtype" && this.copy(d.base)); }
    return false;
  }
  type(type: AotType, borrowed = false, lifetime?: string): RustType {
    switch (type.kind) {
      case "style": return rt("StyleId");
      case "number": return rt(type.name);
      case "boolean": return rt("bool");
      case "void": return unit;
      case "undefined": return rt("Option", unit);
      case "string": return borrowed ? rr(rt("str"), false, lifetime) : type.capacity === undefined ? rt("String") : rt("microts::model::heapless::String", { kind: "const", value: type.capacity });
      case "array": { const value: RustType = type.length === undefined ? borrowed ? { kind: "slice", element: this.type(type.element) } : type.capacity === undefined ? rt("Vec", this.type(type.element)) : rt("microts::model::heapless::Vec", this.type(type.element), { kind: "const", value: type.capacity }) : { kind: "array", element: this.type(type.element), length: type.length }; return borrowed ? rr(value, false, lifetime) : value; }
      case "option": return rt("Option", this.type(type.value, borrowed, lifetime));
      case "tuple": return { kind: "tuple", elements: type.elements.map(t => this.type(t, borrowed, lifetime)) };
      case "named": return borrowed && !this.copy(type) ? rr(rt(this.typeName(type.name)), false, lifetime) : rt(this.typeName(type.name));
    }
  }
  hasBorrow(type: AotType): boolean {
    return type.kind === "option" ? this.hasBorrow(type.value) : type.kind === "tuple" ? type.elements.some(t => this.hasBorrow(t)) : !this.copy(type);
  }
  propsType(component = this.current): RustType { return rt(`${component.name}Props`, ...(component.props.some(p => this.hasBorrow(p.type)) ? [{ kind: "lifetime", name: "_" } as RustType] : [])); }
  scopedSlots(component = this.current) { return component.slotProps?.filter(slot => slot.parameters.length) ?? []; }
  slotVariant(name: string, component = this.current): string { return `Slot${component.slots.indexOf(name)}`; }
  slotArgumentsType(component = this.current): RustType { return rt(`${component.name}SlotArguments`, ...(this.scopedSlots(component).some(slot => slot.parameters.some(p => this.hasBorrow(p.type))) ? [{ kind: "lifetime", name: "_" } as RustType] : [])); }
  borrowedValue(value: RustExpr, type: AotType): RustExpr {
    if (type.kind === "string") return rm(value, "as_str");
    if (type.kind === "array") return type.length === undefined ? rm(value, "as_slice") : ref(value);
    if (type.kind === "named" && !this.copy(type)) return ref(value);
    if (type.kind === "tuple" && !this.copy(type)) return { kind: "tuple", elements: type.elements.map((element, i) => this.borrowedValue(rf(value, i), element)) };
    if (type.kind === "option" && !this.copy(type.value)) return rm(rm(value, "as_ref"), "map", { kind: "closure", params: [rn("optional_value")], body: type.value.kind === "named" ? rp("optional_value") : this.borrowedValue(rp("optional_value"), type.value) });
    return value;
  }
  ownsExpression(e: AotExpr): boolean {
    return e.kind === "constant" && e.type.kind === "array" || e.kind === "call" || e.kind === "template" || e.kind === "index" || e.kind === "undefined"
      || e.kind === "literal" && e.type.kind === "named"
      || e.kind === "field" && this.ownsExpression(e.object)
      || e.kind === "conditional" && (this.ownsExpression(e.consequent) || this.ownsExpression(e.alternate))
      || e.kind === "binary" && e.operator === "??" && (this.ownsExpression(e.left) || this.ownsExpression(e.right))
      || e.kind === "narrow" && this.ownsExpression(e.value)
      || e.kind === "cast" && this.ownsExpression(e.value);
  }
  numericBase(type: AotType): AotType {
    const d = type.kind === "named" ? this.declarations.get(type.name) : undefined;
    return d?.kind === "newtype" ? this.numericBase(d.base) : type;
  }
  unwrapNumeric(value: RustExpr, type: AotType): RustExpr {
    const d = type.kind === "named" ? this.declarations.get(type.name) : undefined;
    return d?.kind === "newtype" ? this.unwrapNumeric(rf(value, 0), d.base) : value;
  }
  wrapNumeric(value: RustExpr, type: AotType): RustExpr {
    const d = type.kind === "named" ? this.declarations.get(type.name) : undefined;
    return d?.kind === "newtype" ? rc(rp(this.typeName(d.name)), this.wrapNumeric(value, d.base)) : value;
  }
  own(value: RustExpr, type: AotType): RustExpr {
    if (this.copy(type)) return value;
    if ((type.kind === "string" || type.kind === "array") && type.capacity !== undefined) {
      return rc({ kind: "path", path: ["microts", "model", type.kind === "string" ? "bounded_string" : "bounded_array"], typeArgs: type.kind === "string" ? [{ kind: "const", value: type.capacity }] : [this.type(type.element), { kind: "const", value: type.capacity }] }, type.kind === "string" ? value : rm(rm(value, "iter"), "cloned"), rl("view value"));
    }
    if (type.kind === "option") return rm(value, "map", { kind: "closure", params: [rn("value")], body: this.own(rp("value"), type.value) });
    if (type.kind === "tuple") return { kind: "tuple", elements: type.elements.map((element, i) => this.own(rf(value, i), element)) };
    this.requireDerive(type, "Clone"); return rm(value, "to_owned");
  }
  requireDerive(type: AotType, trait: string): void {
    if (type.kind === "option") { this.requireDerive(type.value, trait); return; }
    if (type.kind === "array") { this.requireDerive(type.element, trait); return; }
    if (type.kind === "tuple") { type.elements.forEach(t => this.requireDerive(t, trait)); return; }
    if (type.kind !== "named") return;
    const traits = this.derives.get(type.name) ?? new Set<string>(); if (traits.has(trait)) return;
    traits.add(trait); this.derives.set(type.name, traits);
    if (trait === "Copy") this.requireDerive(type, "Clone");
    if (trait === "Eq" || trait === "PartialOrd" || trait === "Ord") this.requireDerive(type, "PartialEq");
    if (trait === "Ord") { this.requireDerive(type, "Eq"); this.requireDerive(type, "PartialOrd"); }
    const d = this.declarations.get(type.name);
    if (d?.kind === "struct") d.fields.forEach(f => this.requireDerive(f.type, trait));
    if (d?.kind === "union") d.variants.forEach(v => v.fields.forEach(f => this.requireDerive(f.type, trait)));
    if (d?.kind === "newtype") this.requireDerive(d.base, trait);
  }
  expr(e: AotExpr, locals: Locals = new Map(), owned = false): RustExpr {
    if (this.copy(e.type)) this.requireDerive(e.type, "Copy");
    let result: RustExpr;
    switch (e.kind) {
      case "literal": {
        if (e.type.kind === "style") result = rc(rp("StyleId"), rl(e.value, "i32"));
        else if (e.type.kind === "named") {
          const d = this.declarations.get(e.type.name);
          if (d?.kind === "enum") result = rp(this.typeName(d.name), this.variant(d.name, String(e.value)));
          else if (d?.kind === "newtype") result = rc(rp(this.typeName(d.name)), d.unit === "Color" && typeof e.value === "string" ? rl(parseMicroTsColor(e.value), "u32") : this.expr({ ...e, type: d.base }, locals, true));
          else result = rl(e.value);
        } else result = rl(e.value, typeof e.value === "number" && e.type.kind === "number" ? e.type.name : undefined, "rawNumber" in e ? e.rawNumber as string | undefined : undefined);
        break;
      }
      case "constant": result = e.type.kind === "array" && e.type.element.kind === "string" ? rm(rp(this.constantExpressionName(e)), "map", { kind: "closure", params: [rn("value")], body: rm(rp("value"), "to_owned") }) : rp(this.constantExpressionName(e)); break;
      case "undefined": result = none; break;
      case "binding": {
        if (e.scope === "event" && this.eventExpressions.has(e.name)) {
          const value = this.eventExpressions.get(e.name)!;
          const key = JSON.stringify(value), remaining = (this.eventUses.get(key) ?? 1) - 1;
          this.eventUses.set(key, remaining);
          if (!owned) return this.borrowedValue(value, e.type);
          if (!this.copy(e.type) && remaining > 0) { this.requireDerive(e.type, "Clone"); return rm(value, "clone"); }
          return value;
        }
        if (e.scope === "vm") result = rm(vm, e.name);
        else if (e.scope === "prop") result = rf(props, e.name);
        else if (e.scope === "inject") result = this.injectionValue(e.name, locals);
        else result = locals.has(e.name) && this.copy(e.type) ? { kind: "unary", operator: "*", expr: rp(this.localName(e.name)) } : rp(e.scope === "local" ? this.localName(e.name) : e.name);
        break;
      }
      case "field": {
        const objectType = e.object.type.kind === "option" ? e.object.type.value : e.object.type;
        const declaration = objectType.kind === "named" ? this.declarations.get(objectType.name) : undefined;
        if (declaration?.kind === "union" && e.name === declaration.discriminant) {
          result = e.optional ? rm(this.expr(e.object, locals), "map", { kind: "closure", params: [rn("value")], body: rm(rp("value"), "discriminant") }) : rm(this.expr(e.object, locals), "discriminant");
        } else if (declaration?.kind === "union" && e.variant) {
          const value = this.expr(e.object, locals);
          result = { kind: "match", value, arms: [
            { pattern: { kind: "variant", path: [this.typeName(declaration.name), this.variant(declaration.name, e.variant)], fields: [{ name: e.name, pattern: rn("field_value") }], rest: true }, body: this.copy(e.type) ? { kind: "unary", operator: "*", expr: rp("field_value") } : e.type.kind === "string" ? rm(rp("field_value"), "as_str") : e.type.kind === "array" ? rm(rp("field_value"), "as_slice") : rp("field_value") },
            { pattern: emptyPattern, body: { kind: "macro", name: ["unreachable"], args: [rl("checked discriminant narrowing")] } },
          ] };
        } else if (e.optional) {
          const fieldType = declaration?.kind === "struct" ? declaration.fields.find(f => f.name === e.name)?.type : undefined;
          const selectedType = fieldType ?? (e.type.kind === "option" ? e.type.value : e.type);
          const selected = this.ownsExpression(e.object) ? rf(rp("value"), e.name) : this.borrowedValue(rf(rp("value"), e.name), selectedType);
          result = rm(this.expr(e.object, locals), fieldType?.kind === "option" ? "and_then" : "map", { kind: "closure", params: [rn("value")], body: selected });
        } else result = this.ownsExpression(e.object) ? rf(this.expr(e.object, locals), e.name) : this.borrowedValue(rf(this.expr(e.object, locals), e.name), e.type);
        break;
      }
      case "index": this.requireDerive(e.type, "Clone"); result = rm(rm(e.object.kind === "constant" ? rp(this.constantExpressionName(e.object)) : this.expr(e.object, locals), "get", cast(this.expr(e.index, locals), rt("usize"))), "cloned");
        if (e.object.kind === "constant" && e.type.kind === "option" && e.type.value.kind === "string") result = rm(result, "map", { kind: "closure", params: [rn("value")], body: rm(rp("value"), "to_owned") });
        break;
      case "unary": {
        if (e.operator === "-" && e.operand.kind === "literal" && typeof e.operand.value === "number") return this.expr({ ...e.operand, value: -e.operand.value, ...("rawNumber" in e.operand && e.operand.rawNumber ? { rawNumber: String(e.operand.rawNumber).startsWith("-") ? String(e.operand.rawNumber).slice(1) : `-${e.operand.rawNumber}` } : {}), type: e.type }, locals, owned);
        const value = this.unwrapNumeric(this.expr(e.operand, locals), e.operand.type); const base = this.numericBase(e.type);
        result = e.operator === "+" ? value : e.operator === "-" && base.kind === "number" && !base.name.startsWith("f") ? rm(value, "wrapping_neg") : { kind: "unary", operator: e.operator, expr: value };
        result = this.wrapNumeric(result, e.type); break;
      }
      case "binary": {
        if (["===", "!=="].includes(e.operator)) this.requireDerive(e.left.type, "PartialEq");
        const enumCondition = this.enumCondition(e);
        if (enumCondition?.declaration.kind === "union") {
          const variant = enumCondition.declaration.variants.find(v => v.name === enumCondition.literal)!;
          const matches: RustExpr = { kind: "matches", value: this.expr(enumCondition.value, locals), pattern: { kind: "variant", path: [this.typeName(enumCondition.declaration.name), this.variant(enumCondition.declaration.name, enumCondition.literal)], ...(variant.fields.length ? { fields: [], rest: true } : {}) } };
          return e.operator === "!==" ? { kind: "unary", operator: "!", expr: matches } : matches;
        }
        const numeric = ["+", "-", "*", "/", "%", "<", "<=", ">", ">="].includes(e.operator);
        const left = numeric ? this.unwrapNumeric(this.expr(e.left, locals), e.left.type) : this.expr(e.left, locals), right = numeric ? this.unwrapNumeric(this.expr(e.right, locals), e.right.type) : this.expr(e.right, locals);
        const base = this.numericBase(e.type);
        if (e.operator === "??") result = rm(this.ownsExpression(e) ? this.expr(e.left, locals, true) : left, "unwrap_or", this.expr(e.right, locals, this.ownsExpression(e)));
        else if ((e.operator === "===" || e.operator === "!==") && (e.right.kind === "undefined" || e.left.kind === "undefined")) result = rm(e.right.kind === "undefined" ? left : right, e.operator === "===" ? "is_none" : "is_some");
        else if (["<", "<=", ">", ">="].includes(e.operator) && this.numericBase(e.left.type).kind === "string") result = binary(e.operator, rc(rp("microts", "builtins", "string_compare"), ref(left), ref(right)), rl(0, "i32"));
        else if (["+", "-", "*"].includes(e.operator) && base.kind === "number" && !base.name.startsWith("f")) result = rm(left, { "+": "wrapping_add", "-": "wrapping_sub", "*": "wrapping_mul" }[e.operator]!, right);
        else result = binary(e.operator === "===" ? "==" : e.operator === "!==" ? "!=" : e.operator, left, right);
        if (numeric) result = this.wrapNumeric(result, e.type);
        break;
      }
      case "conditional": result = { kind: "if", condition: this.expr(e.condition, locals), then: rb([], this.expr(e.consequent, locals, owned || this.ownsExpression(e))), otherwise: rb([], this.expr(e.alternate, locals, owned || this.ownsExpression(e))) }; return result;
      case "call": {
        if (e.target === "vm") result = e.arguments.length ? blockExpr(e.arguments.map((a, i) => stmtLet(`call_arg${i}`, this.expr(a, locals, true))), rm(vm, e.name, ...e.arguments.map((_, i) => rp(`call_arg${i}`)))) : rm(vm, e.name);
        else result = this.wrapNumeric(rc(rp("microts", "builtins", e.name), ...e.arguments.map(a => e.name === "len" ? ref(this.expr(a, locals)) : this.unwrapNumeric(this.expr(a, locals), a.type))), e.type);
        break;
      }
      case "template": {
        const parts = this.textParts(e.parts, true); const format = parts.map(p => typeof p === "string" ? p.replaceAll("{", "{{").replaceAll("}", "}}") : "{}").join("");
        result = { kind: "macro", name: ["alloc", "format"], args: [rl(format), ...parts.filter((p): p is AotExpr => typeof p !== "string").map(p => this.displayExpr(p, this.expr(p, locals)))] }; break;
      }
      case "cast": {
        if (e.type.kind === "option") return e.value.type.kind === "option" ? this.expr(e.value, locals, owned) : some(this.expr(e.value, locals, owned));
        result = e.type.kind === "named" && this.declarations.get(e.type.name)?.kind === "newtype" ? this.wrapNumeric(cast(this.unwrapNumeric(this.expr(e.value, locals), e.value.type), this.type(this.numericBase(e.type))), e.type) : cast(this.unwrapNumeric(this.expr(e.value, locals), e.value.type), this.type(e.type)); break;
      }
      case "narrow": result = e.variant ? this.expr(e.value, locals) : rm(this.expr(e.value, locals), "expect", rl("checked option narrowing")); break;
    }
    return owned && !this.ownsExpression(e) ? this.own(result, e.type) : result;
  }
  textParts(parts: (string | AotExpr)[], template = false): (string | AotExpr)[] { return parts.flatMap(p => typeof p === "string" ? [p] : p.kind === "template" ? this.textParts(p.parts, true) : [{ ...p, templateDisplay: template }]); }
  displayExpr(expression: AotExpr, value: RustExpr): RustExpr {
    if (this.program.modelProtocol) {
      const type = expression.type.kind === "option" ? expression.type.value : expression.type, base = this.numericBase(type);
      if (base.kind === "number" && base.name === "f32") value = expression.type.kind === "option"
        ? rm(value,"map",{kind:"closure",params:[rn("value")],body:cast(this.unwrapNumeric(rp("value"),type),rt("f64"))})
        : cast(this.unwrapNumeric(value,type),rt("f64"));
    }
    return rc((expression as AotExpr & { templateDisplay?: boolean }).templateDisplay && expression.type.kind === "option" ? rp("microts", "template_option_display") : rp("display"), ref(value));
  }
  keyEqual(expected: RustExpr, expression: AotExpr, locals: Locals): RustExpr {
    if (expression.kind === "template") {
      const parts = this.textParts(expression.parts, true);
      const format = parts.map(p => typeof p === "string" ? p.replaceAll("{", "{{").replaceAll("}", "}}") : "{}").join("");
      return rc(rp("microts", "formatted_eq"), expected, { kind: "macro", name: ["format_args"], args: [rl(format), ...parts.filter((p): p is AotExpr => typeof p !== "string").map(p => this.displayExpr(p, this.expr(p, locals)))] });
    }
    if (expression.kind === "conditional") return { kind: "if", condition: this.expr(expression.condition, locals), then: rb([], this.keyEqual(expected, expression.consequent, locals)), otherwise: rb([], this.keyEqual(expected, expression.alternate, locals)) };
    return binary("==", expected, this.expr(expression, locals));
  }
  enumCondition(condition: AotExpr): { value: AotExpr; declaration: Extract<AotTypeDeclaration, { kind: "enum" | "union" }>; literal: string } | undefined {
    if (condition.kind !== "binary" || !["===", "!=="].includes(condition.operator)) return;
    const literal = condition.right.kind === "literal" ? condition.right : condition.left.kind === "literal" ? condition.left : undefined;
    const value = literal === condition.right ? condition.left : condition.right;
    if (!literal || typeof literal.value !== "string") return;
    const declaration = value.type.kind === "named" ? this.declarations.get(value.type.name) : undefined;
    if (declaration?.kind === "enum") return { value, declaration, literal: literal.value };
    if (value.kind === "field" && !value.optional) {
      const objectDeclaration = value.object.type.kind === "named" ? this.declarations.get(value.object.type.name) : undefined;
      if (objectDeclaration?.kind === "union" && value.name === objectDeclaration.discriminant) return { value: value.object, declaration: objectDeclaration, literal: literal.value };
    }
  }
  branchSelection(branches: Extract<ExpandedNode, { kind: "if" }>["branches"], locals: Locals): RustExpr | undefined {
    const conditions = branches.filter(b => b.condition).map(b => b.condition!);
    if (!conditions.length || conditions.some(c => c.kind !== "binary" || c.operator !== "===")) return;
    const analyzed = conditions.map(c => this.enumCondition(c)); const first = analyzed[0];
    if (!first || analyzed.some(c => !c || c.declaration.name !== first.declaration.name)) return;
    const identity = (e: AotExpr) => JSON.stringify(e, (key, value) => key === "loc" ? undefined : value);
    if (analyzed.some(c => identity(c!.value) !== identity(first.value))) return;
    const covered = new Set<string>();
    const arms: Extract<RustExpr, { kind: "match" }>["arms"] = [];
    analyzed.forEach((condition, i) => {
      if (covered.has(condition!.literal)) return;
      covered.add(condition!.literal);
      const fields = first.declaration.kind === "union" ? first.declaration.variants.find(v => v.name === condition!.literal)?.fields : undefined;
      arms.push({ pattern: { kind: "variant", path: [this.typeName(first.declaration.name), this.variant(first.declaration.name, condition!.literal)], ...(fields?.length ? { fields: [], rest: true } : {}) }, body: rl(i, "i32") });
    });
    const variants = first.declaration.kind === "enum" ? first.declaration.variants : first.declaration.variants.map(v => v.name);
    if (variants.some(v => !covered.has(v))) arms.push({ pattern: emptyPattern, body: rl(branches.findIndex(b => !b.condition), "i32") });
    return { kind: "match", value: this.expr(first.value, locals), arms };
  }
  rewriteExpr(e: AotExpr, context: Expansion, payload = new Map<string, AotExpr>()): AotExpr {
    if (e.kind === "constant") { const rewritten = { ...e }; this.resolvedConstants.set(rewritten, this.resolvedConstants.get(e) ?? this.constantName(e.name, context.component)); return rewritten; }
    if (e.kind === "binding") return e.scope === "prop" ? context.props.get(e.name) ?? e : e.scope === "local" ? context.locals?.get(e.name) ?? e : e.scope === "event" ? payload.get(e.name) ?? payload.get("$event") ?? e : e;
    switch (e.kind) {
      case "field": return { ...e, object: this.rewriteExpr(e.object, context, payload) };
      case "index": return { ...e, object: this.rewriteExpr(e.object, context, payload), index: this.rewriteExpr(e.index, context, payload) };
      case "unary": return { ...e, operand: this.rewriteExpr(e.operand, context, payload) };
      case "binary": return { ...e, left: this.rewriteExpr(e.left, context, payload), right: this.rewriteExpr(e.right, context, payload) };
      case "conditional": return { ...e, condition: this.rewriteExpr(e.condition, context, payload), consequent: this.rewriteExpr(e.consequent, context, payload), alternate: this.rewriteExpr(e.alternate, context, payload) };
      case "call": return { ...e, arguments: e.arguments.map(a => this.rewriteExpr(a, context, payload)) };
      case "template": return { ...e, parts: e.parts.map(p => typeof p === "string" ? p : this.rewriteExpr(p, context, payload)) };
      case "cast": case "narrow": return { ...e, value: this.rewriteExpr(e.value, context, payload) };
      default: return e;
    }
  }
  inlineHandlers = new WeakMap<AotHandler, { arguments: AotExpr[]; names: string[]; handler?: AotHandler }>();
  rewriteHandler(handler: AotHandler, context: Expansion, payload = new Map<string, AotExpr>()): AotHandler | undefined {
    if (handler.kind === "sequence") return { ...handler, steps: handler.steps.flatMap(step => { const rewritten = this.rewriteHandler(step, context, payload); return rewritten ? [rewritten] : []; }) };
    if (handler.kind === "if") return { ...handler, condition: this.rewriteExpr(handler.condition, context, payload), then: handler.then.flatMap(step => { const rewritten = this.rewriteHandler(step, context, payload); return rewritten ? [rewritten] : []; }), ...(handler.else ? { else: handler.else.flatMap(step => { const rewritten = this.rewriteHandler(step, context, payload); return rewritten ? [rewritten] : []; }) } : {}) };
    if (handler.kind === "call") return { ...handler, expression: this.rewriteExpr(handler.expression, context, payload) };
    if (handler.kind === "assign") return { ...handler, value: this.rewriteExpr(handler.value, context, payload) };
    const args = handler.arguments.map(a => this.rewriteExpr(a, context, payload));
    if (context.component === this.current) return { ...handler, arguments: args };
    const listener = context.events.get(handler.name);
    if (!listener && handler.optional) return { kind: "sequence", steps: [], id: handler.id, loc: handler.loc };
    const event = context.component.events.find(e => e.name === handler.name);
    const names = args.map((_, i) => `__pocket_emit_${this.serial++}_${i}`);
    const values = new Map<string, AotExpr>();
    const bindings = args.map((arg, i): AotExpr => ({ kind: "binding", scope: "event", name: names[i]!, type: arg.type, loc: arg.loc }));
    bindings.forEach((binding, i) => values.set(i === 0 ? "$event" : `$event${i}`, binding));
    event?.parameters.forEach((p, i) => { if (bindings[i]) values.set(p.name, bindings[i]!); });
    const rewritten = listener ? this.rewriteHandler(listener.handler, listener.expansion, values) : undefined;
    const result: AotHandler = { kind: "sequence", steps: [], id: handler.id, loc: handler.loc };
    this.inlineHandlers.set(result, { arguments: args, names, handler: rewritten });
    return result;
  }
  expand(nodes: AotNode[], context: Expansion): ExpandedNode[] {
    return nodes.flatMap(node => {
      if (node.kind === "component") {
        const component = this.components.get(node.component)!;
        const childProps = new Map<string, AotExpr>();
        for (const p of component.props) {
          const supplied = node.props.find(q => q.name === p.name);
          if (supplied) { const value = this.rewriteExpr(supplied.value, context); childProps.set(p.name, p.type.kind === "option" && value.type.kind !== "option" ? { kind: "cast", value, type: p.type, loc: node.loc } : value); }
          else if (p.default !== undefined) childProps.set(p.name, { kind: "literal", value: p.default, rawNumber: p.defaultRawNumber, type: p.type, loc: node.loc });
          else childProps.set(p.name, { kind: "undefined", type: p.type, loc: node.loc });
        }
        if (component.factory) return [{ ...node, props: [...childProps].map(([name, value]) => ({ name, value })), events: node.events.flatMap(e => { const handler = this.rewriteHandler(e.handler, context); return handler ? [{ ...e, handler }] : []; }), slots: node.slots.map(s => ({ ...s, children: this.expand(s.children, context) })) }];
        return this.expand(component.nodes, { component, props: childProps, events: new Map(node.events.map(e => [e.name, { handler: e.handler, expansion: context }])), slots: new Map(node.slots.map(s => [s.name, s])), slotExpansion: context });
      }
      if (node.kind === "slot") {
        const values = node.props?.map(prop => ({ ...prop, value: this.rewriteExpr(prop.value, context) }));
        if (context.component === this.current) return [{ ...node, props: values, fallback: this.expand(node.fallback, context) }];
        const supplied = context.slots.get(node.name);
        if (!supplied) return this.expand(node.fallback, context);
        const expansion = context.slotExpansion!, localValues = new Map(expansion.locals);
        for (const binding of supplied.bindings ?? []) { const value = values?.find(prop => prop.name === binding.prop)?.value; if (value) localValues.set(binding.name, value); }
        return this.expand(supplied.children, { ...expansion, locals: localValues });
      }
      if (node.kind === "if") return [{ ...node, branches: node.branches.map(b => ({ condition: b.condition ? this.rewriteExpr(b.condition, context) : undefined, children: this.expand(b.children, context) })) }];
      if (node.kind === "for") return [{ ...node, source: this.rewriteExpr(node.source, context), key: this.rewriteExpr(node.key, context), children: this.expand(node.children, context) }];
      if (node.kind === "input") return [{ ...node, active: this.rewriteExpr(node.active, context), handler: this.rewriteHandler(node.handler, context) ?? { kind: "emit", name: "__discard", arguments: [], id: node.handler.id, loc: node.handler.loc }, children: this.expand(node.children, context) }];
      return [{ ...node, dynamicStyle: node.dynamicStyle ? { ...node.dynamicStyle, expression: this.rewriteExpr(node.dynamicStyle.expression, context) } : undefined, props: node.props.map(p => ({ ...p, value: this.rewriteExpr(p.value, context) })), text: node.text ? { ...node.text, parts: node.text.parts.map(p => typeof p === "string" ? p : this.rewriteExpr(p, context)) } : undefined, events: node.events.flatMap(e => { const handler = this.rewriteHandler(e.handler, context); return handler ? [{ ...e, handler }] : []; }), children: this.expand(node.children, context) }];
    }) as ExpandedNode[];
  }
  contextParams(locals: Locals, dispatch = false): RustParam[] {
    return [param("props", rr(this.propsType())), param("vm", rr(rt("M"), dispatch)), ...this.injectionContext().map(value => param(this.injectionName(value.key), this.type(value.type, true))), ...this.slotParams(), ...[...locals].map(([name, type]) => param(this.localName(name), this.scopedLocals.has(name) && !this.copy(type) ? this.type(type, true) : rr(this.type(type))))];
  }
  eventSinkType(component = this.current): RustType { return { kind: "dyn", bounds: [rt("microts::EventSink", rt(`${component.name}Event`), ...(this.scopedSlots(component).length ? [rt(`${component.name}SlotEvent`)] : []))] }; }
  contextArgs(locals: Locals): RustExpr[] { return [props, vm, ...this.injectionContext().map(value => rp(this.injectionName(value.key))), ...this.slotArgs(), ...[...locals].map(([name]) => rp(this.localName(name)))]; }
  injectionContext(component = this.current): NonNullable<AotComponent["context"]> { return component.root ? [] : component.context ?? []; }
  injectionName(key: string): string {
    const root = this.program.components.find(component => component.root);
    return `__pocket_inject_${root?.provides?.findIndex(value => value.key === key) ?? 0}`;
  }
  injectionValue(key: string, locals: Locals): RustExpr {
    if (!this.current.root) return rp(this.injectionName(key));
    return this.expr(this.current.provides!.find(value => value.key === key)!.value, locals);
  }
  slotParams(): RustParam[] { return this.current.slots.map(name => param(`slot_${name}`, rt("Option", rr(rt("SlotHandle"))))); }
  slotArgs(): RustExpr[] { return this.current.slots.map(name => rp(`slot_${name}`)); }
  mountParams(): RustParam[] { return [...nodeParams, ...this.slotParams()]; }
  asyncCall(call: Extract<RustExpr,{kind:"method"}>, commands:RustExpr):RustExpr {
    const name=`__async_commands${this.serial++}`;
    return blockExpr([stmtLet(name,rc(rp("Vec","new")),true),re({...call,args:[...call.args,ref(rp(name),true)]}),re(rm(commands,"extend",rp(name)))]);
  }
  method(name: string, params: RustParam[], body: RustBlock, returns?: RustType, generic = false, public_ = false): RustFunction {
    if (name === "dispatch") {
      const memos = new Set(this.current.values.filter(value => value.memo).map(value => value.name));
      const companions = (value: unknown): unknown => {
        if (!value || typeof value !== "object") return value;
        if (Array.isArray(value)) return value.map(companions);
        const mapped = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, companions(child)])) as Record<string, any>;
        if (mapped.kind === "method" && mapped.object.kind === "path" && mapped.object.path[0] === "vm" && memos.has(mapped.method)) mapped.method += "_now";
        return mapped;
      };
      body = companions(body) as RustBlock;
      if(this.asyncDispatch){
        params=[...params,param("__model_commands",rr(rt("microts::CommandQueue")))];
        const methods=new Set(this.current.functions.filter(fn=>fn.async).map(fn=>fn.name));
        const thread=(value:unknown):unknown=>{
          if(!value||typeof value!=="object")return value;if(Array.isArray(value))return value.map(thread);
          const mapped=Object.fromEntries(Object.entries(value).map(([key,child])=>[key,thread(child)])) as Record<string,any>;
          if(mapped.kind==="method"){
            const receiver=mapped.object.kind==="path"&&mapped.object.path[0]==="vm";
            if(receiver&&methods.has(mapped.method))return this.asyncCall(mapped as Extract<RustExpr,{kind:"method"}>,rp("__model_commands"));
            if(!receiver&&["dispatch","dispatch_step"].includes(mapped.method))mapped.args.push(rp("__model_commands"));
          }
          return mapped;
        };
        body=thread(body) as RustBlock;
      }
    }
    if (["update", "update_at"].includes(name) && this.scopedSlots().length) {
      params = [...params, param("slot_updates", rr({ kind: "dyn", bounds: [{ kind: "fnTrait", name: "FnMut", params: [rr(rt("Ui"), true), rt("usize"), this.slotArgumentsType()] }] }, true))];
      const thread = (value: unknown): unknown => {
        if (!value || typeof value !== "object") return value;
        if (Array.isArray(value)) return value.map(thread);
        const mapped = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, thread(child)])) as Record<string, any>;
        if (mapped.kind === "method" && ["update", "update_at"].includes(mapped.method) && !this.explicitSlotUpdates.has(value as RustExpr)) mapped.args.push(rp("slot_updates"));
        return mapped;
      };
      body = thread(body) as RustBlock;
    }
    if (this.lifecycle && ["mount", "new", "update", "update_at"].includes(name)) {
      const traitMount = name === "mount" && params[0]?.pattern.kind === "name" && params[0].pattern.name === "self";
      if (!traitMount) params = [...params, param("lifecycle", rr(rt("AotLifecycle")))];
      const thread = (value: unknown): unknown => {
        if (!value || typeof value !== "object") return value;
        if (Array.isArray(value)) return value.map(thread);
        const mapped = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, thread(child)])) as Record<string, any>;
        if (mapped.kind === "call" && (mapped.callee.kind === "qualifiedPath" && mapped.callee.member === "mount" || mapped.callee.kind === "path" && (mapped.callee.path.at(-1) === "mount" && !mapped.callee.path.includes("Block") || mapped.callee.path.at(-1) === "new" && /SlotContent\d+$/.test(mapped.callee.path[0])))) mapped.args.push(rp("lifecycle"));
        if (mapped.kind === "method" && ["update", "update_at"].includes(mapped.method) && !(mapped.object.kind === "path" && mapped.object.path[0] === "vm")) mapped.args.push(rp("lifecycle"));
        return mapped;
      };
      body = thread(body) as RustBlock;
      if (traitMount) body.statements.unshift(stmtLet("lifecycle_owner", rm(rf(self, "lifecycle"), "clone")), stmtLet("lifecycle", ref(rp("lifecycle_owner"))));
    }
    return { kind: "fn", name, public: public_, params, returns, body, ...(generic ? { generics: [{ name: "M", bounds: [rt(`${this.current.name}ViewModel`)] }] } : {}) };
  }
  registerBlock(name: string, children: GeneratedBlock[] = [], _generic = false, broadcast = false, ownState?: string): void { const states = [...new Set([...(ownState ? [ownState] : []), ...children.flatMap(b => b.states)])]; this.blocks.set(name, { generic: !!states.length, states, broadcast: broadcast || children.some(b => b.broadcast), owner: this.current.name }); }
  inputTraversal(name: string, pending: RustExpr, sample: RustStatement[]): void { Object.assign(this.blocks.get(name)!, { pending, sample }); }
  structure(name: string, count: RustExpr, placement: RustStatement[], pendingAfter: RustBlock): void { Object.assign(this.blocks.get(name)!, { count, placement, pendingAfter }); }
  suffixPending(children: RustExpr[]): RustBlock {
    const statements: RustStatement[] = [stmtLet("remaining", rp("skip"), true)];
    children.slice(0, -1).forEach((child, i) => statements.push(stmtLet(`count${i}`, rm(child, "handler_count")), re(ifExpr(binary(">=", rp("remaining"), rp(`count${i}`)), [assign(rp("remaining"), binary("-", rp("remaining"), rp(`count${i}`)))], rb([re(ifExpr(rm(child, "pending_after", rp("input"), rp("remaining")), [{ kind: "return", value: rl(true) }])), assign(rp("remaining"), rl(0, "usize"))])))));
    return rb(statements, children.length ? rm(children[children.length - 1]!, "pending_after", rp("input"), rp("remaining")) : rl(false));
  }
  incrementalDispatch(method: RustFunction): RustFunction[] {
    // A callback may replace parent data. Yield after it so the next handler
    // receives props and row locals reconstructed from the current model.
    if (method.name !== "dispatch" || !method.body) return [method];
    const transform = (value: unknown): unknown => {
      if (!value || typeof value !== "object") return value;
      if (Array.isArray(value)) return value.map(transform);
      const mapped = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, transform(child)])) as Record<string, any>;
      if (mapped.kind === "method" && mapped.method === "dispatch" && !(mapped.object.kind === "path" && mapped.object.path[0] === "vm")) { mapped.method = "dispatch_step"; mapped.args.push(rp("cursor")); }
      if (mapped.kind === "assign" && mapped.target.kind === "path" && mapped.target.path[0] === "handled") {
        if (mapped.value.kind === "literal" && mapped.value.value === true) return { kind: "return", value: rl(true) };
        if (mapped.value.kind === "binary" && mapped.value.operator === "|") return re(ifExpr(mapped.value.right, [{ kind: "return", value: rl(true) }]));
        if (mapped.value.kind === "method" && mapped.value.method === "dispatch_step") return re(ifExpr(mapped.value, [{ kind: "return", value: rl(true) }]));
      }
      if (mapped.kind === "binary" && mapped.operator === "|" && mapped.left.kind === "path" && mapped.left.path[0] === "handled") return mapped.right;
      return mapped;
    };
    const body = transform(method.body) as RustBlock;
    if (body.result?.kind === "path" && body.result.path[0] === "handled") body.result = rl(false);
    const step: RustFunction = { ...method, name: "dispatch_step", public: false, params: [...method.params, param("cursor", rr(rt("microts::DispatchCursor"), true))], body: rb([
      re(ifExpr(rm(rp("cursor"), "skip_completed", rm(self, "handler_count")), [{ kind: "return", value: rl(false) }])),
      re(ifExpr({ kind: "unary", operator: "!", expr: rm(self, "pending_after", rp("input"), rm(rp("cursor"), "completed_offset")) }, [re(rm(rp("cursor"), "skip", rm(self, "handler_count"))), re(rm(self, "sample_idle", rp("input"))), { kind: "return", value: rl(false) }])),
      ...body.statements,
    ], body.result) };
    if (!method.public) return [step];
    const args = method.params.slice(1).map(p => rp((p.pattern as Extract<RustPattern, { kind: "name" }>).name));
    const wrapper: RustFunction = { ...method, body: rb([stmtLet("cursor", rc(rp("microts", "DispatchCursor", "new")), true), stmtLet("handled", rl(false), true), { kind: "loop", body: rb([
      re(rm(rp("cursor"), "restart")), re(ifExpr({ kind: "unary", operator: "!", expr: rm(self, "dispatch_step", ...args, ref(rp("cursor"), true)) }, [{ kind: "break" }])), assign(rp("handled"), rl(true)),
    ]) }], rp("handled")) };
    return [step, wrapper];
  }
  generatedBlock(name: string, locals: Locals): GeneratedBlock { return { name, locals, ...this.blocks.get(name)! }; }
  statefulChildren(component: AotComponent): string[] {
    const found = new Set<string>();
    const visit = (name: string) => { const child = this.components.get(name)!; if (child.factory) found.add(name); else child.children.forEach(visit); };
    component.children.forEach(visit); return [...found];
  }
  factoryBound(name: string): RustType {
    const params = this.components.get(name)?.factory?.params;
    return params?.length ? rt("microts::New", { kind: "tuple", elements: params.map(p => this.type(p.type)) }) : rt("Default");
  }
  finishGenerics(): RustItem[] {
    const stateParameter = (name: string) => `State${name}`;
    const stateName = (name: string) => this.blocks.get(name)?.generic && this.program.components.some(c => name === `${c.name}View`) ? `${name}State` : name;
    const result: RustItem[] = [];
    for (let item of this.items) {
      const originalName = item.kind === "struct" || item.kind === "enum" ? item.name : item.kind === "impl" && item.type.kind === "path" ? item.type.path[0] : undefined;
      const info = originalName ? this.blocks.get(originalName) : undefined;
      if (item.kind === "impl" && item.type.kind === "path") {
        if (info?.pending && (!item.trait || item.trait.kind === "path" && item.trait.path.join("::") === "microts::SlotBlock")) {
          item = { ...item, methods: [...item.methods.flatMap(method => this.incrementalDispatch(method)),
            this.method("pending", [receiver(), param("input", rr(rt("Input")))], rb([], info.pending), rt("bool")),
            this.method("sample_idle", [receiver(true), param("input", rr(rt("Input")))], rb(info.sample ?? [])),
            this.method("handler_count", [receiver()], rb([], info.count ?? rl(0, "usize")), rt("usize")),
            this.method("pending_after", [receiver(), param("input", rr(rt("Input"))), param("skip", rt("usize"))], info.pendingAfter ?? rb([], rl(false)), rt("bool")),
            this.method("refresh_slot_placement", [receiver(true), ...nodeParams], rb(info.placement ?? [])),
          ] };
        }
      }
      const visit = (value: unknown): unknown => {
        if (!value || typeof value !== "object") return value;
        if (Array.isArray(value)) return value.map(visit);
        const valueObject = value as Record<string, unknown>;
        const mapped = Object.fromEntries(Object.entries(valueObject).map(([key, child]) => [key, visit(child)])) as Record<string, unknown>;
        if (mapped.kind === "path" && Array.isArray(mapped.path)) {
          const parts = mapped.path as string[];
          if (info?.generic && parts[0] === "M" && parts[1] && info.states.includes(parts[1])) mapped.path = [stateParameter(parts[1]), ...parts.slice(2)];
          else {
            const target = this.blocks.get(parts[0]!);
            if (target?.generic && !mapped.args && !mapped.typeArgs) {
              if (info?.generic && target.owner === info.owner) {
                mapped.path = [stateName(parts[0]!), ...parts.slice(1)];
                if (parts.length === 1) mapped.args = target.states.map(name => rt(stateParameter(name)));
              } else if (parts.length === 1) mapped.args = [rt("M")];
            }
          }
        }
        return mapped;
      };
      const mapped = visit(item) as RustItem;
      if (mapped.kind === "trait") {
        const component = this.program.components.find(c => mapped.name === `${c.name}ViewModel`);
        if (component) mapped.associatedTypes = mapped.associatedTypes?.map(t => ({ ...t, bounds: [...t.bounds, ...((this.staticStates.get(component.name)?.has(t.name) || !!this.components.get(t.name)?.hooks || !!this.program.modelProtocol) ? [{ kind: "lifetime", name: "static" } as RustType] : [])] }));
      }
      if (mapped.kind === "struct" || mapped.kind === "enum") {
        const declaration = this.program.types.find(t => this.typeName(t.name) === mapped.name);
        if (declaration) mapped.derives = ["Clone", "Copy", "Debug", "PartialEq", "Eq", "PartialOrd", "Ord"].filter(trait => this.derives.get(declaration.name)?.has(trait)
          || this.program.modelProtocol && (["Clone", "Debug", "PartialEq"].includes(trait) || trait === "Copy" && this.copy({ kind: "named", name: declaration.name })));
      }
      if (info?.generic && (mapped.kind === "struct" || mapped.kind === "enum" || mapped.kind === "impl")) {
        mapped.generics = info.states.map(name => ({ name: stateParameter(name), bounds: [rt(`${name}ViewModel`), this.factoryBound(name), ...((this.staticStates.get(info.owner)?.has(name) || !!this.components.get(name)?.hooks || !!this.program.modelProtocol) ? [{ kind: "lifetime", name: "static" } as RustType] : [])] }));
        if (mapped.kind === "impl") mapped.methods = mapped.methods.map(method => ({ ...method, generics: method.generics?.map(g => g.name === "M" ? { ...g, bounds: [rt(`${info.owner}ViewModel`, ...info.states.map(name => ({ kind: "binding", name, type: rt(stateParameter(name)) } as RustType)))] } : g) }));
        else {
          mapped.name = stateName(originalName!);
          if (mapped.name !== originalName) result.push({ kind: "typeAlias", name: originalName!, public: true, generics: [{ name: "M", bounds: [rt(`${info.owner}ViewModel`)] }], type: rt(mapped.name, ...info.states.map(name => rt(`M::${name}`))) });
        }
      }
      result.push(mapped);
    }
    return result;
  }
  withEventValues<T>(values: Map<string, RustExpr>, callback: () => T): T { const previous = this.eventExpressions; this.eventExpressions = values; try { return callback(); } finally { this.eventExpressions = previous; } }
  blockImpl(name: string, first: RustExpr, move: RustStatement[], unmount: RustStatement[]) {
    this.items.push({ kind: "impl", type: rt(name), trait: rt("Block"), methods: [
      this.method("first_node", [receiver()], rb([], first), rt("NodeId")),
      this.method("move_before", [receiver(true), ...nodeParams], rb(move)),
      this.method("unmount", [ownedReceiver, param("ui", rr(rt("Ui"), true))], rb(unmount)),
    ] });
  }
  compileGroup(nodes: ExpandedNode[], locals: Locals, requestedName?: string): GeneratedBlock {
    const name = requestedName ?? `${this.current.name}Block${this.serial++}`;
    const children = nodes.map(node => this.compileNode(node, locals));
    this.registerBlock(name, children);
    const fields: RustField[] = [{ name: "parent", type: rt("NodeId") }, { name: "anchor", type: rt("NodeId") }, ...children.map((c, i) => ({ name: `child${i}`, type: rt(c.name) }))];
    this.items.push({ kind: "struct", name, public: !!requestedName, fields });
    const mount = children.map((c, i) => stmtLet(`child${i}`, rc(rp(c.name, "mount"), ui, parent, anchor, ...this.slotArgs())));
    const init: RustExpr = { kind: "struct", path: ["Self"], fields: fields.map(f => ({ name: f.name })) };
    const update: RustStatement[] = [];
    const dispatch: RustStatement[] = [stmtLet("handled", rl(false), true)];
    const childField = (i: number) => rf(self, `child${i}`);
    this.inputTraversal(name, children.map((_, i) => rm(childField(i), "pending", rp("input"))).reduce((a, b) => binary("||", a, b), rl(false)), children.map((_, i) => re(rm(childField(i), "sample_idle", rp("input")))));
    const following = (start: number, end: RustExpr): RustExpr => {
      let result = end;
      for (let j = children.length - 1; j >= start; j--) {
        const first = rm(childField(j), "first_node");
        result = { kind: "if", condition: binary("!=", first, noNode), then: rb([], first), otherwise: rb([], result) };
      }
      return result;
    };
    this.structure(name, children.map((_, i) => rm(childField(i), "handler_count")).reduce((a, b) => binary("+", a, b), rl(0, "usize")), [assign(rf(self, "parent"), parent), assign(rf(self, "anchor"), anchor), ...children.flatMap((_, index) => { const i = children.length - 1 - index; return [stmtLet(`placement_anchor${i}`, following(i + 1, anchor)), re(rm(childField(i), "refresh_slot_placement", ui, parent, rp(`placement_anchor${i}`)))]; })], this.suffixPending(children.map((_, i) => childField(i))));
    children.forEach((c, i) => {
      update[this.lifecycle ? "push" : "unshift"](stmtLet(`anchor${i}`, following(i + 1, anchor)), re(rm(childField(i), "update_at", ui, rf(self, "parent"), ...this.contextArgs(locals), rp(`anchor${i}`))));
      dispatch.push(assign(rp("handled"), binary("|", rp("handled"), rm(childField(i), "dispatch", rp("input"), ...this.contextArgs(locals), rp("events")))));
    });
    if (this.lifecycle) update.push(re(rm(self, "refresh_slot_placement", ui, rf(self, "parent"), anchor)));
    const methods = [
      this.method("mount", this.mountParams(), rb(mount, init), rt("Self"), false, !!requestedName),
      this.method("contains_node", [receiver(), param("target", rt("NodeId"))], rb([], children.map((_, i) => rm(childField(i), "contains_node", rp("target"))).reduce((a, b) => binary("||", a, b), rl(false))), rt("bool")),
      this.method("update_at", [receiver(true), param("ui", rr(rt("Ui"), true)), param("parent", rt("NodeId")), ...this.contextParams(locals), param("anchor", rt("NodeId"))], rb([assign(rf(self, "parent"), parent), assign(rf(self, "anchor"), anchor), ...update]), undefined, true),
      this.method("dispatch", [receiver(true), param("input", rr(rt("Input"))), ...this.contextParams(locals, true), param("events", rr(this.eventSinkType(), true))], rb(dispatch, rp("handled")), rt("bool"), true, !!requestedName),
    ];
    if (requestedName) methods.push(
      this.method("update", [receiver(true), param("ui", rr(rt("Ui"), true)), ...this.contextParams(locals)], rb([re(rm(self, "update_at", ui, rf(self, "parent"), ...this.contextArgs(locals), rf(self, "anchor")))]), undefined, true, true),
      this.method("unmount", [ownedReceiver, param("ui", rr(rt("Ui"), true))], rb([re(rc(rp("Block", "unmount"), self, ui))]), undefined, false, true),
      this.method("first_node", [receiver()], rb([], rc(rp("Block", "first_node"), self)), rt("NodeId"), false, true),
    );
    this.items.push({ kind: "impl", type: rt(name), methods });
    this.blockImpl(name, following(0, noNode), [assign(rf(self, "parent"), parent), assign(rf(self, "anchor"), anchor), ...children.map((_, i) => re(rm(childField(i), "move_before", ui, parent, anchor)))], children.map((_, i) => re(rm(childField(i), "unmount", ui))));
    return this.generatedBlock(name, locals);
  }
  compileNode(node: ExpandedNode, locals: Locals): GeneratedBlock {
    if (node.kind === "if") return this.compileIf(node, locals);
    if (node.kind === "for") return this.compileFor(node, locals);
    if (node.kind === "slot") return this.compileSlot(node, locals);
    if (node.kind === "component") return this.compileComponent(node, locals);
    if (node.kind === "input") return this.compileInput(node, locals);
    const name = `${this.current.name}Node${this.serial++}`;
    const children = this.compileGroup(node.children as ExpandedNode[], locals);
    this.registerBlock(name, [children]);
    const fields: RustField[] = [{ name: "node", type: rt("NodeId") }, { name: "children", type: rt(children.name) }];
    const initial: { name: string; value?: RustExpr }[] = [{ name: "node" }, { name: "children" }];
    const mount: RustStatement[] = [stmtLet("node", rm(ui, "create_node", rl(MICROTS_ELEMENTS[node.tag].nodeType, "u8"))), re(rm(ui, "insert_before", parent, rp("node"), anchor)), re(rm(ui, "set_style", rp("node"), rc(rp("StyleId"), rl(node.style, "i32"))))];
    if (node.focusable) mount.push(re(rm(ui, "set_focusable", rp("node"), rl(true))));
    if (node.src) mount.push(re(rm(ui, "set_image_asset", rp("node"), rl(node.src))));
    if (node.debugName) mount.push(re(rm(ui, "set_debug_name", rp("node"), rl(node.debugName))));
    mount.push(stmtLet("children", rc(rp(children.name, "mount"), ui, rp("node"), noNode, ...this.slotArgs())));
    const update: RustStatement[] = [];
    const nodeId = rf(self, "node");
    if (node.ref) {
      fields.push({ name: "node_ref", type: rt("Option", rt("microts::NodeSlot")) });
      initial.push({ name: "node_ref", value: none });
      update.push(re(ifExpr(rm(rf(self, "node_ref"), "is_none"), [
        stmtLet("node_ref", rm(rm(vm, node.ref), "clone")), re(rm(rp("node_ref"), "set", nodeId)), assign(rf(self, "node_ref"), some(rp("node_ref"))),
      ])));
    }
    this.inputTraversal(name, binary("||", node.events.length ? rm(rp("input"), "is_press", nodeId) : rl(false), rm(rf(self, "children"), "pending", rp("input"))), [re(rm(rf(self, "children"), "sample_idle", rp("input")))]);
    this.structure(name, binary("+", rl(node.events.length, "usize"), rm(rf(self, "children"), "handler_count")), [re(rm(rf(self, "children"), "refresh_slot_placement", ui, nodeId, noNode))], rb([...(node.events.length ? [re(ifExpr(binary("&&", binary("<", rp("skip"), rl(node.events.length, "usize")), rm(rp("input"), "is_press", nodeId)), [{ kind: "return", value: rl(true) }]))] : [])], rm(rf(self, "children"), "pending_after", rp("input"), rm(rp("skip"), "saturating_sub", rl(node.events.length, "usize")))));
    const memo = (key: string, expression: AotExpr, apply: (value: RustExpr) => RustExpr) => {
      this.requireDerive(expression.type, "PartialEq");
      fields.push({ name: key, type: rt("Option", this.type(expression.type)) }); initial.push({ name: key, value: none });
      const value = rp(`value_${key}`); const field = rf(self, key);
      update.push(stmtLet(`value_${key}`, this.expr(expression, locals)), re(ifExpr(binary("!=", field, some(value)), [re(apply(value)), assign(field, some(value))])));
    };
    if (node.dynamicStyle) memo("style_memo", node.dynamicStyle.expression, value => rm(ui, "set_style", nodeId, node.dynamicStyle!.expression.type.kind === "style" ? value : rc(rp("StyleId"), cast(value, rt("i32")))));
    node.props.forEach((p, i) => memo(`prop_memo${i}`, p.value, value => rm(ui, "set_prop", nodeId, rl(p.prop, "u8"), cast(this.unwrapNumeric(value, p.value.type), rt("f64")))));
    if (node.text) {
      const parts = this.textParts(node.text.parts);
      const expressions = parts.filter((p): p is AotExpr => typeof p !== "string");
      expressions.forEach(e => this.requireDerive(e.type, "PartialEq"));
      if (!expressions.length) mount.push(re(rm(ui, "set_text", rp("node"), rl(parts.join("")))));
      else {
        fields.push({ name: "text_inputs", type: rt("Option", { kind: "tuple", elements: expressions.map(e => this.type(e.type)) }) }, { name: "text_value", type: rt("String") }, { name: "text_scratch", type: rt("String") });
        initial.push({ name: "text_inputs", value: none }, { name: "text_value", value: rc(rp("String", "new")) }, { name: "text_scratch", value: rc(rp("String", "new")) });
        expressions.forEach((e, i) => update.push(stmtLet(`text_input${i}`, this.expr(e, locals))));
        const changed = expressions.map((e, i) => binary("!=", this.borrowedValue(rf(rp("previous"), i), e.type), this.ownsExpression(e) ? this.borrowedValue(rp(`text_input${i}`), e.type) : rp(`text_input${i}`))).reduce((a, b) => binary("||", a, b));
        const check = rm(rm(rf(self, "text_inputs"), "as_ref"), "map_or", rl(true), { kind: "closure", params: [rn("previous")], body: changed });
        const format = parts.map(p => typeof p === "string" ? p.replaceAll("{", "{{").replaceAll("}", "}}") : "{}").join("");
        const scratch = rf(self, "text_scratch"), output = rf(self, "text_value");
        const body = [re(rm(scratch, "clear")), re(rm({ kind: "macro", name: ["write"], args: [ref(scratch, true), rl(format), ...expressions.map((e, i) => this.displayExpr(e, rp(`text_input${i}`)))] }, "expect", rl("writing to String cannot fail"))), re(ifExpr(binary("!=", scratch, output), [re(rc(rp("core", "mem", "swap"), ref(scratch, true), ref(output, true))), re(rm(ui, "set_text", nodeId, ref(output)))])), assign(rf(self, "text_inputs"), some({ kind: "tuple", elements: expressions.map((e, i) => this.ownsExpression(e) ? rp(`text_input${i}`) : this.own(rp(`text_input${i}`), e.type)) }))];
        update.push(re(ifExpr(check, body)));
      }
    }
    update.push(re(rm(rf(self, "children"), "update_at", ui, nodeId, ...this.contextArgs(locals), noNode)));
    const dispatch: RustStatement[] = [stmtLet("handled", rl(false), true)];
    for (const event of node.events) dispatch.push(re(ifExpr(binary("&&", rm(rp("cursor"), "visit"), rm(rp("input"), "is_press", nodeId)), [...this.handler(event.handler, locals), assign(rp("handled"), rl(true))])));
    this.items.push({ kind: "struct", name, fields });
    this.items.push({ kind: "impl", type: rt(name), methods: [
      this.method("mount", this.mountParams(), rb(mount, { kind: "struct", path: ["Self"], fields: initial }), rt("Self")),
      this.method("contains_node", [receiver(), param("target", rt("NodeId"))], rb([], binary("||", binary("==", nodeId, rp("target")), rm(rf(self, "children"), "contains_node", rp("target")))), rt("bool")),
      this.method("update_at", [receiver(true), param("ui", rr(rt("Ui"), true)), param("parent", rt("NodeId")), ...this.contextParams(locals), param("anchor", rt("NodeId"))], rb(update), undefined, true),
      this.method("dispatch", [receiver(true), param("input", rr(rt("Input"))), ...this.contextParams(locals, true), param("events", rr(this.eventSinkType(), true))], rb(dispatch, binary("|", rp("handled"), rm(rf(self, "children"), "dispatch", rp("input"), ...this.contextArgs(locals), rp("events")))), rt("bool"), true),
    ] });
    this.blockImpl(name, nodeId, [re(rm(ui, "insert_before", parent, nodeId, anchor))], [re(rm(rf(self, "children"), "unmount", ui)),
      ...(node.ref ? [re({ kind: "ifLet", pattern: { kind: "variant", path: ["Some"], tuple: [rn("node_ref")] }, value: rf(self, "node_ref"), then: rb([re(ifExpr(binary("==", rm(rp("node_ref"), "get"), some(nodeId)), [re(rm(rp("node_ref"), "clear"))]))]) } as RustExpr)] : []),
      re(rm(ui, "destroy_node", nodeId))]);
    return this.generatedBlock(name, locals);
  }
  handler(handler: AotHandler, locals: Locals): RustStatement[] {
    const previous = this.eventUses; this.eventUses = new Map();
    const count = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) { value.forEach(count); return; }
      const inline = this.inlineHandlers.get(value as AotHandler);
      if (inline) { inline.arguments.forEach(count); if (inline.handler) count(inline.handler); return; }
      const e = value as AotExpr;
      if (e.kind === "binding" && e.scope === "event" && this.eventExpressions.has(e.name)) {
        const key = JSON.stringify(this.eventExpressions.get(e.name)); this.eventUses.set(key, (this.eventUses.get(key) ?? 0) + 1);
      }
      Object.values(value).forEach(count);
    };
    count(handler);
    try { return this.handlerStatements(handler, locals); } finally { this.eventUses = previous; }
  }
  handlerStatements(handler: AotHandler, locals: Locals): RustStatement[] {
    const inline = this.inlineHandlers.get(handler);
    if (inline) {
      const bindings = new Map(this.eventExpressions);
      const statements = inline.arguments.map((arg, i) => stmtLet(inline.names[i]!, this.expr(arg, locals, true)));
      inline.names.forEach(name => bindings.set(name, rp(name)));
      if (inline.handler) statements.push(...this.withEventValues(bindings, () => this.handler(inline.handler!, locals)));
      return statements;
    }
    if (handler.kind === "sequence") return handler.steps.flatMap(step => this.handlerStatements(step, locals));
    if (handler.kind === "if") return [re(ifExpr(this.expr(handler.condition, locals), handler.then.flatMap(step => this.handlerStatements(step, locals)), handler.else ? rb(handler.else.flatMap(step => this.handlerStatements(step, locals))) : undefined))];
    if (handler.kind === "emit" && handler.name === "__discard") return [];
    if (handler.kind === "assign") return [stmtLet("handler_value", this.expr(handler.value, locals, true)), re(rm(vm, `set_${handler.name}`, rp("handler_value")))];
    if (handler.kind === "call" && handler.expression.kind === "call") {
      const e = handler.expression;
      return [...e.arguments.map((a, i) => stmtLet(`handler_arg${i}`, this.expr(a, locals, true))), re(e.target === "vm" ? rm(vm, e.name, ...e.arguments.map((_, i) => rp(`handler_arg${i}`))) : rc(rp("microts", "builtins", e.name), ...e.arguments.map((_, i) => rp(`handler_arg${i}`))))];
    }
    if (handler.kind === "call") return [re(this.expr(handler.expression, locals))];
    const event = rp(`${this.current.name}Event`, this.eventVariant(this.current, handler.name));
    const statements = [...handler.arguments.map((a, i) => stmtLet(`handler_arg${i}`, this.expr(a, locals, true))), re(rm(rp("events"), "push", handler.arguments.length ? rc(event, ...handler.arguments.map((_, i) => rp(`handler_arg${i}`))) : event))];
    return handler.optional ? [re(ifExpr(rf(props, this.presenceFlag(handler.name)), statements))] : statements;
  }
  compileInput(node: Extract<ExpandedNode, { kind: "input" }>, locals: Locals): GeneratedBlock {
    const name = `${this.current.name}Input${this.serial++}`;
    const children = this.compileGroup(node.children, locals);
    this.registerBlock(name, [children], false, true);
    const fields: RustField[] = [{ name: "children", type: rt(children.name) }];
    const init: { name: string; value: RustExpr }[] = [{ name: "children", value: rc(rp(children.name, "mount"), ui, parent, anchor, ...this.slotArgs()) }];
    const input = node.input;
    if (input.kind === "button") { fields.push({ name: "latch", type: rt("microts::ButtonLatch") }); init.push({ name: "latch", value: rc(rp("microts", "ButtonLatch", "new"), rl(input.latched)) }); }
    const pending = input.kind === "button" ? rm(rf(self, "latch"), "pending", rp("input"), rl(input.button, "u32")) : input.kind === "axis" ? binary("!=", rm(rp("input"), "axis_delta", rl(input.axis, "u8")), rl(0, "i32")) : rm(rp("input"), "has_motion", rl(input.value, "u8"), rl(input.minQuality, "u8"));
    this.inputTraversal(name, binary("||", pending, rm(rf(self, "children"), "pending", rp("input"))), [...(node.input.kind === "button" ? [re(rm(rf(self, "latch"), "sample", rp("input"), rl(node.input.button, "u32"), rl(false)))] : []), re(rm(rf(self, "children"), "sample_idle", rp("input")))]);
    this.structure(name, binary("+", rl(1, "usize"), rm(rf(self, "children"), "handler_count")), [re(rm(rf(self, "children"), "refresh_slot_placement", ui, parent, anchor))], rb([re(ifExpr(binary("&&", binary("==", rp("skip"), rl(0, "usize")), pending), [{ kind: "return", value: rl(true) }]))], rm(rf(self, "children"), "pending_after", rp("input"), rm(rp("skip"), "saturating_sub", rl(1, "usize")))));
    const dispatch: RustStatement[] = [stmtLet("handled", rl(false), true)];
    let condition: RustExpr;
    let eventValues = new Map<string, RustExpr>();
    if (input.kind === "button") condition = rm(rf(self, "latch"), "sample", rp("input"), rl(input.button, "u32"), binary("&&", pending, this.expr(node.active, locals)));
    else if (input.kind === "axis") { dispatch.push(stmtLet("axis_delta", rm(rp("input"), "axis_delta", rl(input.axis, "u8")))); condition = binary("&&", binary("!=", rp("axis_delta"), rl(0, "i32")), this.expr(node.active, locals)); eventValues = new Map([["$event", rp("axis_delta")]]); }
    else {
      dispatch.push(stmtLet("motion", rm(rp("input"), "motion_sample", rl(input.value, "u8"), rl(input.minQuality, "u8"))));
      condition = binary("&&", rm(rp("motion"), "is_present"), this.expr(node.active, locals));
      const name = motionValueName(input.value);
      eventValues = new Map(motionValueParameters(name).map((parameter, index) => [index ? `$event${index}` : "$event", parameter.field.startsWith("component") ? rm(rp("motion"), "component", rl(Number(parameter.field.slice(9)), "u8")) : rm(rp("motion"), { referenceFrame: "reference_frame" }[parameter.field] ?? parameter.field)]));
    }
    const handler = this.withEventValues(eventValues, () => this.handler(node.handler, locals));
    dispatch.push(re(ifExpr(binary("&&", rm(rp("cursor"), "visit"), condition), [...handler, assign(rp("handled"), rl(true))])));
    this.items.push({ kind: "struct", name, fields }, { kind: "impl", type: rt(name), methods: [
      this.method("mount", this.mountParams(), rb([], { kind: "struct", path: ["Self"], fields: init }), rt("Self")),
      this.method("contains_node", [receiver(), param("target", rt("NodeId"))], rb([], rm(rf(self, "children"), "contains_node", rp("target"))), rt("bool")),
      this.method("update_at", [receiver(true), param("ui", rr(rt("Ui"), true)), param("parent", rt("NodeId")), ...this.contextParams(locals), param("anchor", rt("NodeId"))], rb([re(rm(rf(self, "children"), "update_at", ui, parent, ...this.contextArgs(locals), anchor))]), undefined, true),
      this.method("dispatch", [receiver(true), param("input", rr(rt("Input"))), ...this.contextParams(locals, true), param("events", rr(this.eventSinkType(), true))], rb(dispatch, binary("|", rp("handled"), rm(rf(self, "children"), "dispatch", rp("input"), ...this.contextArgs(locals), rp("events")))), rt("bool"), true),
    ] });
    this.blockImpl(name, rm(rf(self, "children"), "first_node"), [re(rm(rf(self, "children"), "move_before", ui, parent, anchor))], [re(rm(rf(self, "children"), "unmount", ui))]);
    return this.generatedBlock(name, locals);
  }
  compileSlotContent(nodes: AotNode[], locals: Locals): GeneratedBlock {
    const name = `${this.current.name}SlotContent${this.serial++}`;
    const content = this.compileGroup(nodes, locals);
    this.registerBlock(name, [content]);
    const fields: RustField[] = [...(this.lifecycle ? [{ name: "lifecycle", type: rt("AotLifecycle") }] : []), { name: "block", type: rt("Option", rt(content.name)) }, { name: "parent", type: rt("NodeId") }, { name: "anchor", type: rt("NodeId") }, ...this.current.slots.map(slot => ({ name: `slot_${slot}`, type: rt("Option", rt("SlotHandle")) }))];
    const storedSlots = this.current.slots.map(slot => rm(rf(self, `slot_${slot}`), "as_ref"));
    const whenMounted = (method: string, args: RustExpr[], fallback: RustExpr): RustExpr => ({ kind: "match", value: rm(rf(self, "block"), ["first_node", "pending", "handler_count", "pending_after"].includes(method) ? "as_ref" : "as_mut"), arms: [
      { pattern: { kind: "variant", path: ["Some"], tuple: [rn("block")] }, body: rm(rp("block"), method, ...args) }, { pattern: { kind: "variant", path: ["None"] }, body: fallback },
    ] });
    const empty: RustExpr = { kind: "tuple", elements: [] };
    this.inputTraversal(name, whenMounted("pending", [rp("input")], rl(false)), [re(whenMounted("sample_idle", [rp("input")], empty))]);
    this.structure(name, whenMounted("handler_count", [], rl(0, "usize")), [assign(rf(self, "parent"), parent), assign(rf(self, "anchor"), anchor), re(whenMounted("refresh_slot_placement", [ui, parent, anchor], empty))], rb([], whenMounted("pending_after", [rp("input"), rp("skip")], rl(false))));
    const remove: RustExpr = { kind: "ifLet", pattern: { kind: "variant", path: ["Some"], tuple: [rn("block")] }, value: rm(rf(self, "block"), "take"), then: rb([re(rm(rp("block"), "unmount", ui))]) };
    this.items.push({ kind: "struct", name, fields }, { kind: "impl", type: rt(name), methods: [
      this.method("new", this.slotParams(), rb([], { kind: "struct", path: ["Self"], fields: [...(this.lifecycle ? [{ name: "lifecycle", value: rm(rp("lifecycle"), "clone") }] : []), { name: "block", value: none }, { name: "parent", value: noNode }, { name: "anchor", value: noNode }, ...this.current.slots.map(slot => ({ name: `slot_${slot}`, value: rm(rp(`slot_${slot}`), "cloned") }))] }), rt("Self")),
      this.method("update", [receiver(true), param("ui", rr(rt("Ui"), true)), ...this.contextParams(locals)], rb([re(whenMounted("update_at", [ui, rf(self, "parent"), ...this.contextArgs(locals), rf(self, "anchor")], empty))]), undefined, true),
      this.method("dispatch", [receiver(true), param("input", rr(rt("Input"))), ...this.contextParams(locals, true), param("events", rr(this.eventSinkType(), true))], rb([], whenMounted("dispatch", [rp("input"), ...this.contextArgs(locals), rp("events")], rl(false))), rt("bool"), true),
    ] }, { kind: "impl", type: rt(name), trait: rt("microts::SlotBlock"), methods: [
      this.method("mount", [receiver(true), ...nodeParams], rb([re(remove), assign(rf(self, "parent"), parent), assign(rf(self, "anchor"), anchor), assign(rf(self, "block"), some(rc(rp(content.name, "mount"), ui, parent, anchor, ...storedSlots)))])),
      this.method("unmount", [receiver(true), param("ui", rr(rt("Ui"), true))], rb([re(remove)])),
      this.method("first_node", [receiver()], rb([], whenMounted("first_node", [], noNode)), rt("NodeId")),
      this.method("move_before", [receiver(true), ...nodeParams], rb([assign(rf(self, "parent"), parent), assign(rf(self, "anchor"), anchor), re(whenMounted("move_before", [ui, parent, anchor], empty))])),
    ] });
    return this.generatedBlock(name, locals);
  }
  compileComponent(node: Extract<ExpandedNode, { kind: "component" }>, locals: Locals): GeneratedBlock {
    const name = `${this.current.name}Component${this.serial++}`;
    const child = this.components.get(node.component)!;
    const childView = `${child.name}View`;
    const slots = node.slots.map(slot => {
      const slotLocals = new Map(locals);
      for (const binding of slot.bindings ?? []) { slotLocals.set(binding.name, binding.type); this.scopedLocals.add(binding.name); }
      return { slot, block: this.compileSlotContent(slot.children, slotLocals), locals: slotLocals };
    });
    const staticStates = this.staticStates.get(this.current.name) ?? new Set<string>();
    slots.forEach(slot => slot.block.states.forEach(state => staticStates.add(state))); this.staticStates.set(this.current.name, staticStates);
    const childInfo = this.blocks.get(childView)!;
    this.registerBlock(name, slots.map(s => s.block), true, childInfo.broadcast || slots.some(s => s.block.broadcast), child.name);
    this.inputTraversal(name, rm(rf(self, "view"), "pending", rp("input")), [re(rm(rf(self, "view"), "sample_idle", rp("input")))]);
    this.structure(name, rm(rf(self, "view"), "handler_count"), [re(rm(rf(self, "view"), "refresh_slot_placement", ui, parent, anchor))], rb([], rm(rf(self, "view"), "pending_after", rp("input"), rp("skip"))));
    const usesModelProtocol = !!this.program.modelProtocol;
    const parameterized = !!child.factory?.params?.length;
    const sharedModel = usesModelProtocol || !!child.hooks?.mount || !!child.hooks?.unmount;
    const actualModelType = rt(`M::${child.name}`);
    const storedModelType = sharedModel ? rt("alloc::rc::Rc", rt("core::cell::RefCell", actualModelType)) : actualModelType;
    const viewType = childInfo.generic ? rt(childView, actualModelType) : rt(childView);
    const fields: RustField[] = [{ name: "view", type: viewType }, { name: "model", type: parameterized ? rt("Option", storedModelType) : storedModelType }, ...(sharedModel ? [{ name: "lifecycle", type: rt("AotLifecycle") }, { name: "sequence", type: rt("usize") }] : []), ...slots.map((s, i) => ({ name: `slot${i}`, type: rt("microts::SlotRegistry", rt(s.block.name)) }))];
    const mountedSlots = child.slots.map(slot => { const index = slots.findIndex(s => s.slot.name === slot); return index < 0 ? none : some(ref(rp(`slot_handle${index}`))); });
    const updateSlots = child.slots.map(slot => { const index = slots.findIndex(s => s.slot.name === slot); return index < 0 ? none : some(ref(rp(`slot_handle${index}`))); });
    const mount: RustStatement[] = [];
    slots.forEach((s, i) => {
      this.current.slots.forEach(slot => mount.push(stmtLet(`slot${i}_${slot}`, rm(rp(`slot_${slot}`), "cloned"))));
      if (this.lifecycle) mount.push(stmtLet(`slot_lifecycle${i}`, rm(rp("lifecycle"), "clone")));
      const constructor = rc(rp(s.block.name, "new"), ...this.current.slots.map(slot => rm(rp(`slot${i}_${slot}`), "as_ref")));
      const factory: RustExpr = { kind: "closure", params: [], move: true, body: this.lifecycle ? blockExpr([stmtLet("lifecycle", ref(rp(`slot_lifecycle${i}`)))], constructor) : constructor };
      mount.push(stmtLet(`slot${i}`, rc(rp("microts", "SlotRegistry", "new"), factory)), stmtLet(`slot_handle${i}`, rm(rp(`slot${i}`), "handle")));
    });
    const initializeStart = mount.length;
    const previousComponent = this.current;
    this.current = child;
    const factoryArguments = (child.factory?.arguments ?? []).map(value => this.expr(value, new Map(), true));
    this.current = previousComponent;
    const modelDefault = parameterized ? rc(rp("microts", "New", "new"), { kind: "tuple", elements: factoryArguments }) : rc(rp("M", child.name, "default"));
    if (parameterized) mount.push(stmtLet("model_value", modelDefault, false, actualModelType));
    const modelValue = parameterized ? rp("model_value") : modelDefault;
    mount.push(stmtLet("model", sharedModel ? rc(rp("alloc", "rc", "Rc", "new"), rc(rp("core", "cell", "RefCell", "new"), modelValue)) : modelValue));
    const hookBody = (handler: AotHandler): RustStatement[] => {
      if (handler.kind === "sequence") return handler.steps.flatMap(hookBody);
      if (handler.kind !== "call" || handler.expression.kind !== "call" || handler.expression.arguments.length) throw new Error("Lifecycle hooks require zero-argument model calls");
      const method=handler.expression.name,call=rm(rm(rp("hook_model"), "borrow_mut"), method);
      return [re(child.functions.find(fn=>fn.name===method)?.async?this.asyncCall(call as Extract<RustExpr,{kind:"method"}>,rf(rp("hook_regions"),"commands")):call)];
    };
    const enqueue = (method: string, model: RustExpr, sequence: RustExpr, lifecycle: RustExpr, hook: AotHandler): RustStatement[] => [
      stmtLet("hook_model", model),
      re(rm(lifecycle, method, sequence, rc(rp("alloc", "boxed", "Box", "new"), { kind: "closure", params: [], move: true, body: blockExpr(hookBody(hook)) }))),
    ];
    if (sharedModel) {
      mount.push(stmtLet("sequence", rm(rp("lifecycle"), "next_sequence")));
      if (usesModelProtocol) {
        mount.push(
          re(rm(rm(rp("model"), "borrow_mut"), "bind_commands", rm(rf(rf(rp("lifecycle"), "models"), "commands"), "clone"))),
          stmtLet("phase_model", rm(rp("model"), "clone")),
          re(rm(rf(rp("lifecycle"), "models"), "register", rp("sequence"), rc(rp("alloc", "boxed", "Box", "new"), {
            kind: "closure", params: [rn("phase"), rn("ready"), rn("cmds")], move: true,
            body: blockExpr([stmtLet("model", rm(rp("phase_model"), "borrow_mut"), true), re({ kind: "match", value: rp("phase"), arms: [
              { pattern: { kind: "variant", path: ["microts", "ModelPhase", "Prepare"] }, body: rm(rp("model"), "prepare_resume", rp("ready")) },
              { pattern: { kind: "variant", path: ["microts", "ModelPhase", "Resume"] }, body: rm(rp("model"), "resume", rp("ready"), rp("cmds")) },
              { pattern: { kind: "variant", path: ["microts", "ModelPhase", "React"] }, body: rm(rp("model"), "react", rl(false), rp("cmds")) },
              { pattern: { kind: "variant", path: ["microts", "ModelPhase", "Settle"] }, body: rm(rp("model"), "settle") },
              { pattern: { kind: "variant", path: ["microts", "ModelPhase", "Dispose"] }, body: rm(rp("model"), "cancel_tasks", rp("cmds")) },
            ] })], rm(rp("model"), "model_changed")),
          }))),
          stmtLet("hook_model", rm(rp("model"), "clone")), stmtLet("hook_regions", rm(rf(rp("lifecycle"), "models"), "clone")),
          re(rm(rp("lifecycle"), "enqueue_mount", rp("sequence"), rc(rp("alloc", "boxed", "Box", "new"), {
            kind: "closure", params: [], move: true,
            body: blockExpr([
              stmtLet("cmds", rc(rp("Vec", "new")), true),
              re(rm(rm(rp("hook_model"), "borrow_mut"), "prepare_resume", ref(rm(rp("hook_regions"), "ready")))),
              re(rm(rm(rp("hook_model"), "borrow_mut"), "react", rl(true), ref(rp("cmds"), true))),
              re(rm(rm(rp("hook_model"), "borrow_mut"), "settle")),
              re(rm(rf(rp("hook_regions"), "commands"), "extend", rp("cmds"))),
              ...(child.hooks?.mount ? hookBody(child.hooks.mount) : []),
            ]),
          }))),
        );
      } else if (child.hooks?.mount) mount.push(...enqueue("enqueue_mount", rm(rp("model"), "clone"), rp("sequence"), rp("lifecycle"), child.hooks.mount));
    }
    const initialize = parameterized ? mount.splice(initializeStart) : [];
    if (parameterized) { mount.push(stmtLet("model", none)); if (sharedModel) mount.push(stmtLet("sequence", rl(0, "usize"))); }
    mount.push(stmtLet("view", rc({ kind: "qualifiedPath", type: viewType, member: "mount" }, ui, parent, anchor, ...mountedSlots)));
    if (sharedModel) mount.push(stmtLet("lifecycle", rm(rp("lifecycle"), "clone")));
    const modelStorage = (mutable = false): RustExpr => parameterized ? rm(rm(rf(self, "model"), mutable && !sharedModel ? "as_mut" : "as_ref"), "expect", rl("factory initialized before dispatch")) : rf(self, "model");
    const modelRef = (mutable = false): RustExpr => ref(sharedModel ? { kind: "unary", operator: "*", expr: rm(modelStorage(), mutable ? "borrow_mut" : "borrow") } : parameterized ? { kind: "unary", operator: "*", expr: modelStorage(mutable) } : rf(self, "model"), mutable);

    const propsExpr = (values: RustExpr[]): RustExpr => ({ kind: "struct", path: [`${child.name}Props`], fields: [...child.props.map((p, i) => ({ name: p.name, value: values[i]! })), ...child.events.filter(event => event.optional).map(event => ({ name: this.presenceFlag(event.name, child), value: rl(node.events.some(listener => listener.name === event.name)) }))] });
    const supplied = child.props.map(prop => node.props.find(p => p.name === prop.name)!.value);
    const injected = this.injectionContext(child);
    const updateInjections = injected.map(value => this.injectionValue(value.key, locals));
    const dispatchInjections = injected.map((value, i) => this.current.root ? this.borrowedValue(rp(`inject_owner${i}`), value.type) : this.injectionValue(value.key, locals));
    const update: RustStatement[] = [...slots.map((_, i) => stmtLet(`slot_handle${i}`, rm(rf(self, `slot${i}`), "handle"))), ...supplied.map((value, i) => stmtLet(`prop_value${i}`, this.expr(value, locals))), stmtLet("child_props", propsExpr(supplied.map((value, i) => this.ownsExpression(value) ? this.borrowedValue(rp(`prop_value${i}`), child.props[i]!.type) : rp(`prop_value${i}`))))];
    if (parameterized) update.push(re(ifExpr(rm(rf(self, "model"), "is_none"), [
      stmtLet("props", ref(rp("child_props"))), ...(sharedModel ? [stmtLet("lifecycle", ref(rf(self, "lifecycle")))] : []),
      ...initialize, assign(rf(self, "model"), some(rp("model"))), ...(sharedModel ? [assign(rf(self, "sequence"), rp("sequence"))] : []),
    ])));
    const boundArguments = (slot: typeof slots[number], contract: NonNullable<AotComponent["slotProps"]>[number], owned: boolean): RustStatement[] => (slot.slot.bindings ?? []).map(binding => {
      const index = contract.parameters.findIndex(parameter => parameter.name === binding.prop), value = rp(`slot_arg${index}`);
      return stmtLet(this.localName(binding.name), this.copy(binding.type) ? ref(value) : owned ? this.borrowedValue(value, binding.type) : value);
    });
    const slotUpdate: RustExpr = { kind: "closure", params: [rn("ui"), rn("slot_id"), rn("slot_arguments")], body: { kind: "match", value: rp("slot_arguments"), arms: this.scopedSlots(child).map(contract => {
      const index = slots.findIndex(slot => slot.slot.name === contract.name), suppliedSlot = slots[index];
      const statements = suppliedSlot ? [...boundArguments(suppliedSlot, contract, false), re(rm(rf(self, `slot${index}`), "with_instance", rp("slot_id"), { kind: "closure", params: [rn("slot")], body: rm(rp("slot"), "update", ui, ...this.contextArgs(suppliedSlot.locals)) }))] : [];
      return { pattern: { kind: "variant", path: [`${child.name}SlotArguments`, this.slotVariant(contract.name, child)], tuple: contract.parameters.map((_, i) => rn(`slot_arg${i}`)) }, body: blockExpr(statements) };
    }) } };
    const childUpdate = rm(rf(self, "view"), "update_at", ui, parent, ref(rp("child_props")), modelRef(), ...updateInjections, ...updateSlots, anchor, ...(this.scopedSlots(child).length ? [ref(slotUpdate, true)] : []));
    this.explicitSlotUpdates.add(childUpdate); update.push(re(childUpdate));
    slots.forEach((slot, i) => { if (!this.scopedSlots(child).some(contract => contract.name === slot.slot.name)) update.push(re(rm(rf(self, `slot${i}`), "for_each_mut", { kind: "closure", params: [rn("slot")], body: rm(rp("slot"), "update", ui, ...this.contextArgs(slot.locals)) }))); });
    // Registries retain creation order. Placement follows the child's current
    // tree, including roots that an empty slot gained during the update above.
    update.push(re(rm(rf(self, "view"), "refresh_slot_placement", ui, parent, anchor)));
    const dispatch: RustStatement[] = [
      ...(parameterized ? [re(ifExpr(rm(rf(self, "model"), "is_none"), [{ kind: "return", value: rl(false) }]))] : []),
      ...supplied.map((value, i) => stmtLet(`prop_owner${i}`, this.expr(value, locals, true))),
      ...(this.current.root ? injected.map((value, i) => stmtLet(`inject_owner${i}`, this.own(this.injectionValue(value.key, locals), value.type))) : []),
      stmtLet("child_props", propsExpr(child.props.map((prop, i) => this.borrowedValue(rp(`prop_owner${i}`), prop.type)))),
      ...slots.map((_, i) => stmtLet(`slot_handle${i}`, rm(rf(self, `slot${i}`), "handle"))),
    ];
    const eventArms: Extract<RustExpr, { kind: "match" }>["arms"] = child.events.map(event => {
      const listener = node.events.find(e => e.name === event.name);
      const values = new Map(event.parameters.map((p, i) => [p.name, rp(`event_arg${i}`)])); event.parameters.forEach((_, i) => values.set(i === 0 ? "$event" : `$event${i}`, rp(`event_arg${i}`)));
      const statements = listener ? this.withEventValues(values, () => this.handler(listener.handler, locals)) : [];
      return { pattern: { kind: "variant", path: [`${child.name}Event`, this.eventVariant(child, event.name)], ...(event.parameters.length ? { tuple: event.parameters.map((_, i) => rn(`event_arg${i}`)) } : {}) }, body: blockExpr(statements, rl(!!listener)) };
    });
    const scopedEventArms: Extract<RustExpr, { kind: "match" }>["arms"] = [];
    for (const contract of this.scopedSlots(child)) {
      const index = slots.findIndex(slot => slot.slot.name === contract.name), suppliedSlot = slots[index];
      const statements: RustStatement[] = suppliedSlot ? [stmtLet("cursor", rm(rp("dispatch_cursor"), "expect", rl("scoped slot dispatch cursor"))), ...boundArguments(suppliedSlot, contract, true)] : [];
      const handled = suppliedSlot ? rm(rm(rf(self, `slot${index}`), "with_instance", rp("slot_id"), { kind: "closure", params: [rn("slot")], body: rm(rp("slot"), "dispatch", ref(rp("slot_input")), ...this.contextArgs(suppliedSlot.locals), rp("events")) }), "unwrap_or", rl(false)) : rl(false);
      scopedEventArms.push({ pattern: { kind: "variant", path: [`${child.name}SlotEvent`, this.slotVariant(contract.name, child)], tuple: [rn("slot_input"), rn("slot_id"), ...contract.parameters.map((_, i) => rn(`slot_arg${i}`))] }, body: blockExpr(statements, handled) });
    }
    const slotDispatch: RustStatement[] = [];
    slots.forEach((slot, i) => { if (!this.scopedSlots(child).some(contract => contract.name === slot.slot.name)) slotDispatch.push(re({ kind: "ifLet", pattern: { kind: "variant", path: ["Some"], tuple: [rn("handled")] }, value: rm(rf(self, `slot${i}`), "with_instance", rp("slot_id"), { kind: "closure", params: [rn("slot")], body: rm(rp("slot"), "dispatch", ref(rp("slot_input")), ...this.contextArgs(locals), rp("events")) }), then: rb([{ kind: "return", value: rp("handled") }]) })); });
    const callback: RustExpr = { kind: "closure", params: [rn("dispatch"), rn("dispatch_cursor")], body: { kind: "match", value: rp("dispatch"), arms: [
      { pattern: { kind: "variant", path: ["microts", "Dispatch", "Event"], tuple: [rn("event")] }, body: { kind: "match", value: rp("event"), arms: eventArms } },
      { pattern: { kind: "variant", path: ["microts", "Dispatch", "ScopedSlot"], tuple: [rn("event")] }, body: scopedEventArms.length ? { kind: "match", value: rp("event"), arms: scopedEventArms } : rl(false) },
      { pattern: { kind: "variant", path: ["microts", "Dispatch", "Slot"], tuple: [rn("slot_input"), rn("slot_id")] }, body: blockExpr([stmtLet("cursor", rm(rp("dispatch_cursor"), "expect", rl("slot dispatch cursor"))), ...slotDispatch], rl(false)) },
    ] } };
    dispatch.push(stmtLet("child_events", rc(rp("microts", "dispatch_fn"), callback), true));
    this.items.push({ kind: "struct", name, fields }, { kind: "impl", type: rt(name), methods: [
      this.method("mount", this.mountParams(), rb(mount, { kind: "struct", path: ["Self"], fields: fields.map(f => ({ name: f.name })) }), rt("Self")),
      this.method("contains_node", [receiver(), param("target", rt("NodeId"))], rb([], rm(rf(self, "view"), "contains_node", rp("target"))), rt("bool")),
      this.method("update_at", [receiver(true), param("ui", rr(rt("Ui"), true)), param("parent", rt("NodeId")), ...this.contextParams(locals), param("anchor", rt("NodeId"))], rb(update), undefined, true),
      this.method("dispatch", [receiver(true), param("input", rr(rt("Input"))), ...this.contextParams(locals, true), param("events", rr(this.eventSinkType(), true))], rb(dispatch, rm(rf(self, "view"), "dispatch", rp("input"), ref(rp("child_props")), modelRef(true), ...dispatchInjections, ...updateSlots, ref(rp("child_events"), true))), rt("bool"), true),
    ] });
    const unmount = [re(rm(rf(self, "view"), "unmount", ui))];
    const modelOwned = parameterized ? rm(rf(self, "model"), "expect", rl("factory initialized before unmount")) : rf(self, "model");
    if (usesModelProtocol) unmount.push(
      stmtLet("hook_model", modelOwned), stmtLet("hook_regions", rm(rf(rf(self, "lifecycle"), "models"), "clone")), stmtLet("sequence", rf(self, "sequence")),
      re(rm(rf(self, "lifecycle"), "enqueue_unmount", rp("sequence"), rc(rp("alloc", "boxed", "Box", "new"), { kind: "closure", params: [], move: true, body: blockExpr([
        ...(child.hooks?.unmount ? hookBody(child.hooks.unmount) : []), re(rm(rp("hook_regions"), "remove", rp("sequence"))),
      ]) }))),
    );
    else if (child.hooks?.unmount) unmount.push(...enqueue("enqueue_unmount", modelOwned, rf(self, "sequence"), rf(self, "lifecycle"), child.hooks.unmount));
    else if (sharedModel) unmount.push(re(rm(rf(self, "lifecycle"), "cancel_mount", rf(self, "sequence"))));
    if (parameterized && sharedModel) unmount.splice(1, 0, re(ifExpr(rm(rf(self, "model"), "is_none"), [{ kind: "return" }])));
    this.blockImpl(name, rm(rf(self, "view"), "first_node"), [re(rm(rf(self, "view"), "move_before", ui, parent, anchor))], unmount);
    return this.generatedBlock(name, locals);
  }
  compileSlot(node: Extract<ExpandedNode, { kind: "slot" }>, locals: Locals): GeneratedBlock {
    const name = `${this.current.name}Slot${this.serial++}`;
    const fallback = this.compileGroup(node.fallback as ExpandedNode[], locals);
    this.registerBlock(name, [fallback], false, true);
    this.items.push({ kind: "enum", name, variants: [{ name: "Native", tuple: [rt("SlotHandle"), rt("NodeId"), rt("NodeId"), rt("NodeId")] }, { name: "Fallback", tuple: [rt(fallback.name)] }] });
    const native: RustPattern = { kind: "variant", path: ["Self", "Native"], tuple: [rn("slot"), rn("slot_parent"), rn("slot_anchor"), rn("slot_first")] };
    const fallbackPattern: RustPattern = { kind: "variant", path: ["Self", "Fallback"], tuple: [rn("block")] };
    const slotMatch = (nativeBody: RustExpr, fallbackBody: RustExpr): RustExpr => ({ kind: "match", value: self, arms: [{ pattern: native, body: nativeBody }, { pattern: fallbackPattern, body: fallbackBody }] });
    this.inputTraversal(name, slotMatch(rm(rp("slot"), "pending", rp("input")), rm(rp("block"), "pending", rp("input"))), [re(slotMatch(rm(rp("slot"), "sample_idle", rp("input")), rm(rp("block"), "sample_idle", rp("input"))))]);
    const derefSlot = (name: string): RustExpr => ({ kind: "unary", operator: "*", expr: rp(name) });
    const placeNative = blockExpr([stmtLet("first", rm(rp("slot"), "first_node")), re(ifExpr(binary("||", binary("||", binary("!=", derefSlot("slot_parent"), parent), binary("!=", derefSlot("slot_anchor"), anchor)), binary("!=", derefSlot("slot_first"), rp("first"))), [assign(derefSlot("slot_parent"), parent), assign(derefSlot("slot_anchor"), anchor), assign(derefSlot("slot_first"), rp("first")), re(rm(rp("slot"), "move_before", ui, parent, anchor))])), re(rm(rp("slot"), "refresh_slot_placement", ui, parent, anchor))]);
    this.structure(name, slotMatch(rm(rp("slot"), "handler_count"), rm(rp("block"), "handler_count")), [re(slotMatch(placeNative, rm(rp("block"), "refresh_slot_placement", ui, parent, anchor)))], rb([], slotMatch(rm(rp("slot"), "pending_after", rp("input"), rp("skip")), rm(rp("block"), "pending_after", rp("input"), rp("skip")))));
    const mount: RustExpr = { kind: "match", value: rp(`slot_${node.name}`), arms: [
      { pattern: { kind: "variant", path: ["Some"], tuple: [rn("slot")] }, body: blockExpr([stmtLet("slot", rm(rp("slot"), "instantiate")), re(rm(rp("slot"), "mount", ui, parent, anchor)), stmtLet("first", rm(rp("slot"), "first_node"))], rc(rp("Self", "Native"), rp("slot"), parent, anchor, rp("first"))) },
      { pattern: { kind: "variant", path: ["None"] }, body: rc(rp("Self", "Fallback"), rc(rp(fallback.name, "mount"), ui, parent, anchor, ...this.slotArgs())) },
    ] };
    const contract = this.scopedSlots().find(slot => slot.name === node.name);
    const arguments_ = contract?.parameters.map(parameter => node.props!.find(prop => prop.name === parameter.name)!.value) ?? [];
    const updateArguments: RustStatement[] = arguments_.map((value, i) => stmtLet(`slot_value${i}`, this.expr(value, locals), false, this.type(value.type, !this.ownsExpression(value))));
    if (contract) updateArguments.push(re(rc(rp("slot_updates"), ui, rm(rp("slot"), "instance_id"), rc(rp(`${this.current.name}SlotArguments`, this.slotVariant(node.name)), ...arguments_.map((value, i) => this.ownsExpression(value) ? this.borrowedValue(rp(`slot_value${i}`), contract.parameters[i]!.type) : rp(`slot_value${i}`))))));
    const nativeUpdate = blockExpr([re(ifExpr(binary("||", binary("!=", derefSlot("slot_parent"), parent), binary("!=", derefSlot("slot_anchor"), anchor)), [assign(derefSlot("slot_parent"), parent), assign(derefSlot("slot_anchor"), anchor), re(rm(rp("slot"), "move_before", ui, parent, anchor))])), ...updateArguments]);
    const nativeDispatch = contract ? rm(rp("events"), "slot_event", rc(rp(`${this.current.name}SlotEvent`, this.slotVariant(node.name)), { kind: "unary", operator: "*", expr: rp("input") }, rm(rp("slot"), "instance_id"), ...arguments_.map(value => this.expr(value, locals, true))), rp("cursor")) : rm(rp("events"), "slot", rp("input"), rm(rp("slot"), "instance_id"), rp("cursor"));
    this.items.push({ kind: "impl", type: rt(name), methods: [
      this.method("mount", this.mountParams(), rb([], mount), rt("Self")),
      this.method("contains_node", [receiver(), param("target", rt("NodeId"))], rb([], slotMatch(rl(false), rm(rp("block"), "contains_node", rp("target")))), rt("bool")),
      this.method("update_at", [receiver(true), param("ui", rr(rt("Ui"), true)), param("parent", rt("NodeId")), ...this.contextParams(locals), param("anchor", rt("NodeId"))], rb([re(slotMatch(nativeUpdate, rm(rp("block"), "update_at", ui, parent, ...this.contextArgs(locals), anchor)))]), undefined, true),
      this.method("dispatch", [receiver(true), param("input", rr(rt("Input"))), ...this.contextParams(locals, true), param("events", rr(this.eventSinkType(), true))], rb([], slotMatch(nativeDispatch, rm(rp("block"), "dispatch", rp("input"), ...this.contextArgs(locals), rp("events")))), rt("bool"), true),
    ] });
    this.blockImpl(name, slotMatch(rm(rp("slot"), "first_node"), rm(rp("block"), "first_node")), [re(slotMatch(blockExpr([assign(derefSlot("slot_parent"), parent), assign(derefSlot("slot_anchor"), anchor), assign(derefSlot("slot_first"), rm(rp("slot"), "first_node")), re(rm(rp("slot"), "move_before", ui, parent, anchor))]), rm(rp("block"), "move_before", ui, parent, anchor)))], [re(slotMatch(rm(rp("slot"), "unmount", ui), rm(rp("block"), "unmount", ui)))]);
    return this.generatedBlock(name, locals);
  }
  compileIf(node: Extract<ExpandedNode, { kind: "if" }>, locals: Locals): GeneratedBlock {
    const name = `${this.current.name}If${this.serial++}`;
    const branches = node.branches.map(b => this.compileGroup(b.children as ExpandedNode[], locals));
    this.registerBlock(name, branches);
    this.items.push({ kind: "enum", name, variants: [...branches.map((b, i) => ({ name: `B${i}`, tuple: [rt(b.name)] })), { name: "Empty" }] });
    const arm = (i: number): RustPattern => ({ kind: "variant", path: ["Self", `B${i}`], tuple: [rn("block")] });
    const empty: RustPattern = { kind: "variant", path: ["Self", "Empty"] };
    const matchBlock = (value: RustExpr, fn: string, args: RustExpr[], emptyValue: RustExpr): RustExpr => ({ kind: "match", value, arms: [...branches.map((_, i) => ({ pattern: arm(i), body: rm(rp("block"), fn, ...args) })), { pattern: empty, body: emptyValue }] });
    this.inputTraversal(name, matchBlock(self, "pending", [rp("input")], rl(false)), [re(matchBlock(self, "sample_idle", [rp("input")], { kind: "tuple", elements: [] }))]);
    this.structure(name, matchBlock(self, "handler_count", [], rl(0, "usize")), [re(matchBlock(self, "refresh_slot_placement", [ui, parent, anchor], { kind: "tuple", elements: [] }))], rb([], matchBlock(self, "pending_after", [rp("input"), rp("skip")], rl(false))));
    let selected: RustExpr = rl(-1, "i32");
    for (let i = node.branches.length - 1; i >= 0; i--) selected = node.branches[i]!.condition ? { kind: "if", condition: this.expr(node.branches[i]!.condition!, locals), then: rb([], rl(i, "i32")), otherwise: rb([], selected) } : rl(i, "i32");
    selected = this.branchSelection(node.branches, locals) ?? selected;
    const current: RustExpr = { kind: "match", value: ref({ kind: "unary", operator: "*", expr: self }), arms: [...branches.map((_, i) => ({ pattern: { kind: "variant", path: ["Self", `B${i}`], tuple: [emptyPattern] } as RustPattern, body: rl(i, "i32") })), { pattern: empty, body: rl(-1, "i32") }] };
    const mountSelected: RustExpr = { kind: "match", value: rp("selected"), arms: [...branches.map((b, i) => ({ pattern: { kind: "literal", value: i } as RustPattern, body: rc(rp("Self", `B${i}`), rc(rp(b.name, "mount"), ui, parent, anchor, ...this.slotArgs())) })), { pattern: emptyPattern, body: rp("Self", "Empty") }] };
    this.items.push({ kind: "impl", type: rt(name), methods: [
      this.method("mount", this.mountParams(), rb([], rp("Self", "Empty")), rt("Self")),
      this.method("contains_node", [receiver(), param("target", rt("NodeId"))], rb([], matchBlock(self, "contains_node", [rp("target")], rl(false))), rt("bool")),
      this.method("update_at", [receiver(true), param("ui", rr(rt("Ui"), true)), param("parent", rt("NodeId")), ...this.contextParams(locals), param("anchor", rt("NodeId"))], rb([
        stmtLet("selected", selected), stmtLet("current", current),
        re(ifExpr(binary("!=", rp("selected"), rp("current")), [
          stmtLet("old", rc(rp("core", "mem", "replace"), self, rp("Self", "Empty"))), re(rm(rp("old"), "unmount", ui)),
          assign({ kind: "unary", operator: "*", expr: self }, mountSelected),
        ])), re(matchBlock(self, "update_at", [ui, parent, ...this.contextArgs(locals), anchor], { kind: "tuple", elements: [] })),
      ]), undefined, true),
      this.method("dispatch", [receiver(true), param("input", rr(rt("Input"))), ...this.contextParams(locals, true), param("events", rr(this.eventSinkType(), true))], rb([], matchBlock(self, "dispatch", [rp("input"), ...this.contextArgs(locals), rp("events")], rl(false))), rt("bool"), true),
    ] });
    this.blockImpl(name, matchBlock(self, "first_node", [], noNode), [re(matchBlock(self, "move_before", [ui, parent, anchor], { kind: "tuple", elements: [] }))], [re(matchBlock(self, "unmount", [ui], { kind: "tuple", elements: [] }))]);
    return this.generatedBlock(name, locals);
  }
  compileFor(node: Extract<ExpandedNode, { kind: "for" }>, locals: Locals): GeneratedBlock {
    this.requireDerive(node.key.type, "Ord"); this.requireDerive(node.key.type, "Clone"); this.requireDerive(node.itemType, "Clone");
    const name = `${this.current.name}For${this.serial++}`;
    const rowLocals = new Map(locals); rowLocals.set(node.item, node.itemType); if (node.index) rowLocals.set(node.index, { kind: "number", name: "i32" });
    const row = this.compileGroup(node.children as ExpandedNode[], rowLocals);
    this.registerBlock(name, [row]);
    this.inputTraversal(name, rm(rm(rf(rf(self, "rows"), "rows"), "iter"), "any", { kind: "closure", params: [rn("row")], body: rm(rf(rp("row"), "block"), "pending", rp("input")) }), [{ kind: "for", pattern: rn("row"), iterable: rm(rf(rf(self, "rows"), "rows"), "iter_mut"), body: rb([re(rm(rf(rp("row"), "block"), "sample_idle", rp("input")))]) }]);
    this.items.push({ kind: "struct", name, fields: [{ name: "rows", type: rt("KeyedList", this.type(node.key.type), rt(row.name)) }, { name: "parent", type: rt("NodeId") }, { name: "handler_ends", type: rt("Vec", rt("usize")) }] });
    const rowField = rf(rp("row"), "block"), rowsField = rf(rf(self, "rows"), "rows"), ends = rf(self, "handler_ends");
    // Cached prefix counts let a resumed dispatch skip completed rows without
    // reading model values. Placement refreshes them after deferred slot work.
    const refreshCounts: RustStatement[] = [re(rm(ends, "clear")), stmtLet("handler_total", rl(0, "usize"), true), { kind: "for", pattern: rn("row"), iterable: rm(rowsField, "iter"), body: rb([assign(rp("handler_total"), rm(rp("handler_total"), "saturating_add", rm(rowField, "handler_count"))), re(rm(ends, "push", rp("handler_total")))]) }];
    const findFirst = (offset: RustExpr): RustExpr => rm(ends, "partition_point", { kind: "closure", params: [rn("end")], body: binary("<=", { kind: "unary", operator: "*", expr: rp("end") }, offset) });
    const prefixBefore = (index: RustExpr): RustExpr => ({ kind: "if", condition: binary("==", index, rl(0, "usize")), then: rb([], rl(0, "usize")), otherwise: rb([], { kind: "index", object: ends, index: binary("-", index, rl(1, "usize")) }) });
    const pendingAfter = rb([stmtLet("first_row", findFirst(rp("skip"))), stmtLet("remaining", rm(rp("skip"), "saturating_sub", prefixBefore(rp("first_row")))), { kind: "for", pattern: { kind: "tuple", elements: [rn("index"), rn("row")] }, iterable: rm(rm(rm(rowsField, "iter"), "enumerate"), "skip", rp("first_row")), body: rb([re(ifExpr(rm(rowField, "pending_after", rp("input"), { kind: "if", condition: binary("==", rp("index"), rp("first_row")), then: rb([], rp("remaining")), otherwise: rb([], rl(0, "usize")) }), [{ kind: "return", value: rl(true) }]))]) }], rl(false));
    this.structure(name, rm(rm(rm(ends, "last"), "copied"), "unwrap_or", rl(0, "usize")), [assign(rf(self, "parent"), parent), stmtLet("next", anchor, true), { kind: "for", pattern: rn("row"), iterable: rm(rm(rowsField, "iter_mut"), "rev"), body: rb([re(rm(rowField, "refresh_slot_placement", ui, parent, rp("next"))), stmtLet("first", rm(rowField, "first_node")), re(ifExpr(binary("!=", rp("first"), noNode), [assign(rp("next"), rp("first"))]))]) }, ...refreshCounts], pendingAfter);
    const keyBody: RustStatement[] = node.index ? [stmtLet(this.localName(node.index), ref(rp("row_index")))] : [];
    const keyClosure: RustExpr = { kind: "closure", params: [rn(this.localName(node.item)), rn("row_index")], body: blockExpr(keyBody, this.expr(node.key, rowLocals, true)) };
    const sameKey: RustExpr = { kind: "closure", params: [rn("old_key"), rn(this.localName(node.item)), rn("row_index")], body: blockExpr(keyBody, this.keyEqual(this.copy(node.key.type) ? { kind: "unary", operator: "*", expr: rp("old_key") } : rm(rp("old_key"), "as_str"), node.key, rowLocals)) };
    const updateBody: RustStatement[] = node.index ? [stmtLet(this.localName(node.index), ref(rp("row_index")))] : [];
    updateBody.push(re(rm(rp("block"), "update_at", ui, parent, ...this.contextArgs(rowLocals), rp("row_anchor"))));
    const dispatch: RustStatement[] = [stmtLet("handled", rl(false), true), stmtLet("first_row", findFirst(rm(rp("cursor"), "completed_offset"))), re(rm(rp("cursor"), "skip_completed", prefixBefore(rp("first_row")))), { kind: "for", pattern: { kind: "tuple", elements: [rn("row_index"), rn("row")] }, iterable: rm(rm(rm(rowsField, "iter_mut"), "enumerate"), "skip", rp("first_row")), body: rb([
      re(ifExpr(rm(rowField, "pending_after", rp("input"), rm(rp("cursor"), "completed_offset")), [
        stmtLet("row_context", none, true, rt("Option", { kind: "tuple", elements: [rt("i32"), this.type(node.itemType)] })),
        stmtLet("source", this.expr(node.source, locals)),
        re({ kind: "ifLet", pattern: { kind: "variant", path: ["Some"], tuple: [rn(this.localName(node.item))] }, value: rm(rp("source"), "get", rp("row_index")), then: rb([
          ...(node.index ? [stmtLet("candidate_index_i32", cast(rp("row_index"), rt("i32"))), stmtLet(this.localName(node.index), ref(rp("candidate_index_i32")))] : []),
          re(ifExpr(this.keyEqual(this.copy(node.key.type) ? rf(rp("row"), "key") : rm(rf(rp("row"), "key"), "as_str"), node.key, rowLocals), [assign(rp("row_context"), some({ kind: "tuple", elements: [cast(rp("row_index"), rt("i32")), rm(rp(this.localName(node.item)), "to_owned")] }))])),
        ]) }),
        re(ifExpr(rm(rp("row_context"), "is_none"), [{ kind: "for", pattern: { kind: "tuple", elements: [rn("candidate_index"), rn(this.localName(node.item))] }, iterable: rm(rm(rp("source"), "iter"), "enumerate"), body: rb([
          ...(node.index ? [stmtLet("candidate_index_i32", cast(rp("candidate_index"), rt("i32"))), stmtLet(this.localName(node.index), ref(rp("candidate_index_i32")))] : []),
          re(ifExpr(this.keyEqual(this.copy(node.key.type) ? rf(rp("row"), "key") : rm(rf(rp("row"), "key"), "as_str"), node.key, rowLocals), [assign(rp("row_context"), some({ kind: "tuple", elements: [cast(rp("candidate_index"), rt("i32")), rm(rp(this.localName(node.item)), "to_owned")] })), { kind: "break" }])),
        ]) }])),
        re({ kind: "ifLet", pattern: { kind: "variant", path: ["Some"], tuple: [{ kind: "tuple", elements: [rn("row_index"), rn("row_value")] }] }, value: rp("row_context"), then: rb([
          stmtLet(this.localName(node.item), ref(rp("row_value"))), ...(node.index ? [stmtLet(this.localName(node.index), ref(rp("row_index")))] : []),
          assign(rp("handled"), binary("|", rp("handled"), rm(rf(rp("row"), "block"), "dispatch", rp("input"), ...this.contextArgs(rowLocals), rp("events")))),
        ]), otherwise: rb([re(rm(rp("cursor"), "skip", rm(rowField, "handler_count"))), re(rm(rowField, "sample_idle", rp("input")))]) }),
      ], rb([re(rm(rp("cursor"), "skip", rm(rowField, "handler_count"))), re(rm(rowField, "sample_idle", rp("input")))]))),
    ]) }];
    this.items.push({ kind: "impl", type: rt(name), methods: [
      this.method("mount", this.mountParams(), rb([], { kind: "struct", path: ["Self"], fields: [{ name: "rows", value: rc(rp("KeyedList", "new")) }, { name: "parent" }, { name: "handler_ends", value: rc(rp("Vec", "new")) }] }), rt("Self")),
      this.method("contains_node", [receiver(), param("target", rt("NodeId"))], rb([], rm(rm(rf(rf(self, "rows"), "rows"), "iter"), "any", { kind: "closure", params: [rn("row")], body: rm(rf(rp("row"), "block"), "contains_node", rp("target")) })), rt("bool")),
      this.method("update_at", [receiver(true), param("ui", rr(rt("Ui"), true)), param("parent", rt("NodeId")), ...this.contextParams(locals), param("anchor", rt("NodeId"))], rb([
        re((this.lifecycle ? (...args: RustExpr[]) => rc(rp("aot_reconcile"), ref(rf(self, "rows"), true), ...args) : (...args: RustExpr[]) => rm(rf(self, "rows"), "reconcile", ...args))(ui, parent, anchor, ref(this.expr(node.source, locals)), ...(this.lifecycle ? [] : [sameKey]), keyClosure,
          { kind: "closure", params: [rn("ui"), rn("parent"), rn("anchor"), rn(this.localName(node.item)), rn("row_index")], body: rc(rp(row.name, "mount"), ui, parent, anchor, ...this.slotArgs()) },
          { kind: "closure", params: [rn("block"), rn("ui"), rn(this.localName(node.item)), rn("row_index"), rn("row_anchor")], body: blockExpr(updateBody) },
        )), ...(this.lifecycle ? [re(rm(self, "refresh_slot_placement", ui, parent, anchor))] : refreshCounts),
      ]), undefined, true),
      this.method("dispatch", [receiver(true), param("input", rr(rt("Input"))), ...this.contextParams(locals, true), param("events", rr(this.eventSinkType(), true))], rb(dispatch, rp("handled")), rt("bool"), true),
    ] });
    this.blockImpl(name, rm(rf(self, "rows"), "first_node"), [assign(rf(self, "parent"), parent), re(rm(rf(self, "rows"), "move_before", ui, parent, anchor))], [re(rm(rf(self, "rows"), "unmount", ui))]);
    return this.generatedBlock(name, locals);
  }
  presenceFlag(name: string, component = this.current): string {
    const used = new Set(component.props.map(prop => prop.name));
    for (const event of component.events.filter(event => event.optional)) {
      const base = `has_on_${event.name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replaceAll(/[^a-zA-Z0-9_]/g, "_").toLowerCase()}`;
      let flag = base, suffix = 2; while (used.has(flag)) flag = `${base}_${suffix++}`;
      used.add(flag); if (event.name === name) return flag;
    }
    throw new Error(`Optional callback ${name} is missing from ${component.name}'s event contract`);
  }
  eventVariant(component: AotComponent, name: string): string {
    const used = new Set<string>();
    for (const event of component.events) { const base = rustVariant(event.name); let value = base; let suffix = 2; while (used.has(value)) value = `${base}${suffix++}`; used.add(value); if (event.name === name) return value; }
    return rustVariant(name);
  }
  emitTypes() {
    for (const d of this.program.types) {
      if (d.kind === "struct") this.items.push({ kind: "struct", name: this.typeName(d.name), public: true, derives: ["Clone", "Debug", "PartialEq"], fields: d.fields.map(f => ({ name: f.name, type: this.type(f.type), public: true })) });
      if (d.kind === "newtype") {
        this.items.push({ kind: "struct", name: this.typeName(d.name), public: true, derives: this.copy(d.base) ? ["Clone", "Copy", "Debug", "PartialEq", ...((d.base.kind === "number" && !d.base.name.startsWith("f")) || d.base.kind === "boolean" ? ["Eq", "PartialOrd", "Ord"] : [])] : ["Clone", "Debug", "PartialEq"], tuple: [this.type(d.base)] });
        const base = this.numericBase(d.base);
        if (["number", "string", "boolean"].includes(base.kind) || base.kind === "named" && this.declarations.get(base.name)?.kind === "enum") this.items.push({ kind: "impl", type: rt(this.typeName(d.name)), trait: rt("microts::MicroTsDisplay"), methods: [this.method("fmt_microts", [receiver(), param("formatter", rr(rt("core::fmt::Formatter", { kind: "lifetime", name: "_" }), true))], rb([], d.unit === "Color" ? rc(rp("microts", "format_color"), rf(self, 0), rp("formatter")) : rc(rp("microts", "MicroTsDisplay", "fmt_microts"), ref(rf(self, 0)), rp("formatter"))), rt("core::fmt::Result"))] });
      }
      if (d.kind === "enum" || d.kind === "union") {
        const variants = d.kind === "enum" ? d.variants.map(v => ({ name: this.variant(d.name, v) })) : d.variants.map(v => ({ name: this.variant(d.name, v.name), fields: v.fields.map(f => ({ name: f.name, type: this.type(f.type) })) }));
        this.items.push({ kind: "enum", name: this.typeName(d.name), public: true, derives: d.kind === "enum" ? ["Clone", "Copy", "Debug", "PartialEq", "Eq", "PartialOrd", "Ord"] : ["Clone", "Debug", "PartialEq"], variants });
        const literals = d.kind === "enum" ? d.variants : d.variants.map(v => v.name);
        const literalMatch: RustExpr = { kind: "match", value: self, arms: literals.map((literal, i) => ({ pattern: { kind: "variant", path: ["Self", this.variant(d.name, literal)], ...(d.kind === "union" && d.variants[i]!.fields.length ? { fields: [], rest: true } : {}) }, body: rl(literal) })) };
        this.items.push({ kind: "impl", type: rt(this.typeName(d.name)), methods: [this.method("discriminant", [receiver()], rb([], literalMatch), rr(rt("str"), false, "static"), false, true)] });
        if (d.kind === "enum") this.items.push({ kind: "impl", type: rt(this.typeName(d.name)), trait: rt("microts::MicroTsDisplay"), methods: [this.method("fmt_microts", [receiver(), param("formatter", rr(rt("core::fmt::Formatter", { kind: "lifetime", name: "_" }), true))], rb([], rm(rp("formatter"), "write_str", rm(self, "discriminant"))), rt("core::fmt::Result"))] });
      }
    }
  }
  run(): RustModule {
    this.items.push({ kind: "extern", name: "alloc" }, { kind: "use", path: ["alloc", "string"], names: ["String", "ToString"] }, { kind: "use", path: ["alloc", "borrow"], names: ["ToOwned"] }, { kind: "use", path: ["alloc", "vec"], names: ["Vec"] }, { kind: "use", path: ["core", "fmt"], names: ["Write"] }, { kind: "use", path: ["microts"], names: ["Ui", "NodeId", "StyleId", "Input", "Block", "KeyedList", "SlotHandle", "display"] });
    if (this.lifecycle) this.items.push(...generateAotLifecycle(!!this.program.modelProtocol), generateAotReconcile());
    this.emitTypes();
    const emittedConstants = new Set<string>();
    for (const component of this.program.components) {
      this.current = component;
      const propsBorrow = component.props.some(p => this.hasBorrow(p.type));
      this.items.push({ kind: "struct", name: `${component.name}Props`, public: true, ...(propsBorrow ? { generics: [{ name: "a", lifetime: true }] } : {}), fields: [...component.props.map(p => ({ name: p.name, type: this.type(p.type, true, propsBorrow ? "a" : undefined), public: true })), ...component.events.filter(event => event.optional).map(event => ({ name: this.presenceFlag(event.name), type: rt("bool"), public: true }))] });
      this.items.push({ kind: "enum", name: `${component.name}Event`, public: true, variants: component.events.map(e => ({ name: this.eventVariant(component, e.name), ...(e.parameters.length ? { tuple: e.parameters.map(p => this.type(p.type)) } : {}) })) });
      if (this.scopedSlots().length) {
        const borrows = this.scopedSlots().some(slot => slot.parameters.some(p => this.hasBorrow(p.type)));
        this.items.push({ kind: "enum", name: `${component.name}SlotEvent`, public: true, variants: this.scopedSlots().map(slot => ({ name: this.slotVariant(slot.name), tuple: [rt("Input"), rt("usize"), ...slot.parameters.map(p => this.type(p.type))] })) });
        this.items.push({ kind: "enum", name: `${component.name}SlotArguments`, public: true, ...(borrows ? { generics: [{ name: "a", lifetime: true }] } : {}), variants: this.scopedSlots().map(slot => ({ name: this.slotVariant(slot.name), tuple: slot.parameters.map(p => this.type(p.type, true, borrows ? "a" : undefined)) })) });
      }
      const traitMethods: RustFunction[] = [];
      for (const v of component.values) {
        traitMethods.push({ kind: "fn", name: v.name, params: [receiver()], returns: this.type(v.type, true) });
        if (v.memo) traitMethods.push({ kind: "fn", name: `${v.name}_now`, params: [receiver(true)], returns: this.type(v.type, true), body: rb([], rm(self, v.name)) });
        if (v.writable) traitMethods.push({ kind: "fn", name: `set_${v.name}`, params: [receiver(true), param("value", this.type(v.type))] });
      }
      for (const f of component.functions) traitMethods.push({ kind: "fn", name: f.name, params: [receiver(!f.binding), ...f.parameters.map(p => param(this.localName(p.name), this.type(p.type))), ...(f.async?[param("cmds",rr(rt("Vec",rt("microts::Cmd")),true))]:[])], ...(!f.async&&f.returns.kind !== "void" ? { returns: this.type(f.returns) } : {}), ...(f.optional ? { body: rb() } : {}) });
      for (const reference of component.refs ?? []) traitMethods.push({ kind: "fn", name: reference.name, params: [receiver()], returns: rr(rt("microts::NodeSlot")) });
      traitMethods.push(
        this.method("react", [receiver(true), param("_initial", rt("bool")), param("_cmds", rr(rt("Vec", rt("microts::Cmd")), true))], rb()),
        this.method("settle", [receiver(true)], rb()),
        this.method("prepare_resume", [receiver(true), param("_ready", rr(rt("microts::Ready")))], rb()),
        this.method("resume", [receiver(true), param("_ready", rr(rt("microts::Ready"))), param("_cmds", rr(rt("Vec", rt("microts::Cmd")), true))], rb()),
        this.method("cancel_tasks", [receiver(true), param("_cmds", rr(rt("Vec", rt("microts::Cmd")), true))], rb()),
        this.method("bind_commands", [receiver(true), param("_queue", rt("microts::CommandQueue"))], rb()),
        this.method("model_changed", [receiver()], rb([], rl(false)), rt("bool")),
      );
      const associatedTypes = this.statefulChildren(component).map(name => ({ name, bounds: [rt(`${name}ViewModel`), this.factoryBound(name)] }));
      this.items.push({ kind: "trait", name: `${component.name}ViewModel`, public: true, associatedTypes, methods: traitMethods });
      if (!component.root && !component.factory && !associatedTypes.length) this.items.push({ kind: "impl", type: unit, trait: rt(`${component.name}ViewModel`), methods: [] });
      for (const c of component.constants) if (!emittedConstants.has(this.constantName(c.name))) {
        emittedConstants.add(this.constantName(c.name));
        const loc = { file: component.file, line: 1, column: 1, offset: 0 };
        const literal = (value: string | number | boolean, type: AotType, rawNumber = c.rawNumber): RustExpr => this.expr({ kind: "literal", value, type, loc, ...(rawNumber ? { rawNumber } : {}) });
        const array = Array.isArray(c.value) && c.type.kind === "array" ? c.type : undefined;
        this.items.push({ kind: "const", name: this.constantName(c.name), public: true,
          type: array ? { kind: "array", element: array.element.kind === "string" ? rr(rt("str"), false, "static") : this.type(array.element), length: (c.value as unknown[]).length } : c.type.kind === "string" ? rr(rt("str"), false, "static") : this.type(c.type),
          value: array ? { kind: "array", elements: (c.value as (string | number | boolean)[]).map((value, index) => literal(value, array.element, c.rawNumbers?.[index])) } : literal(c.value as string | number | boolean, c.type),
        });
      }
      const expanded = this.expand(component.nodes, { component, props: new Map(), events: new Map(), slots: new Map() });
      this.compileGroup(expanded, new Map(), `${component.name}View`);
      if (component.root) this.items.push(...generateAotApp(component, this.propsType(component), this.program.demands, this.blocks.get(`${component.name}View`)!.generic, this.lifecycle, this.program.version, !!this.program.modelProtocol, this.asyncDispatch));
    }
    return { items: this.finishGenerics(), attributes: [{ name: "allow", args: ["unused_variables", "unused_imports", "unused_mut", "dead_code", "non_snake_case", "non_camel_case_types", "non_upper_case_globals", "type_alias_bounds"] }] };
  }
}

export interface AotEmission { files: Record<string, string>; ast: RustModule }
export function lowerAot(program: AotProgram): RustModule { checkAotVersion(program); if (program.model && !program.modelProtocol) attachAotModel(program, program.model); return new Lowerer(program).run(); }
export function emitAot(program: AotProgram): AotEmission {
  const ast = lowerAot(program);
  const moduleName = program.root.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  return { ast, files: { [`${moduleName}.rs`]: printRust(ast), "mod.rs": printRust({ items: [{ kind: "mod", name: moduleName }, { kind: "use", path: ["self", moduleName], names: ["*"], public: true }] }) } };
}
