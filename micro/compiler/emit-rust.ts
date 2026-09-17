// micro/compiler/emit-rust.ts — Micro IR -> one Rust module against the
// pocket-micro runtime.
//
// The generated `struct App` holds every signal as a typed field, the
// `NodeId` of every template element, one cache per dynamic binding (the
// previous text run, style value or style id) and a dirty bitmask over
// signals. Writes go through generated setters that compare first (Solid's
// `===` gate) and set the signal's dirty bit; `flush` re-applies every
// binding whose dependency mask intersects the dirty word, then re-runs the
// effects that read a written signal, until a pass writes nothing.

import { fontSlotInfo } from "../../framework/compiler/tailwind.ts";
import {
  collectDeps,
  isNumeric,
  tyOf,
  walkNodes,
  type Binding,
  type ElementNode,
  type Expr,
  type Node,
  type Program,
  type ShowNode,
  type Stmt,
  type Ty,
} from "./ir.ts";

export interface EmitOptions {
  /** Class literal -> styles.bin record index (framework/compiler/tailwind.ts). */
  styleIds: Record<string, number>;
  /** Font slots baked into the pak, for the header comment. */
  fontSlots?: number[];
}

const PROP_CONST: Record<string, string> = {
  width: "WIDTH", height: "HEIGHT", minW: "MIN_W", minH: "MIN_H", maxW: "MAX_W", maxH: "MAX_H",
  paddingT: "PADDING_T", paddingR: "PADDING_R", paddingB: "PADDING_B", paddingL: "PADDING_L",
  marginT: "MARGIN_T", marginR: "MARGIN_R", marginB: "MARGIN_B", marginL: "MARGIN_L",
  gap: "GAP", flexDir: "FLEX_DIR", justify: "JUSTIFY", align: "ALIGN", grow: "GROW", shrink: "SHRINK",
  basis: "BASIS", flexWrap: "FLEX_WRAP", posType: "POS_TYPE", insetT: "INSET_T", insetR: "INSET_R",
  insetB: "INSET_B", insetL: "INSET_L", display: "DISPLAY", overflow: "OVERFLOW", zIndex: "Z_INDEX",
  hitPass: "HIT_PASS", bgColor: "BG_COLOR", gradFrom: "GRAD_FROM", gradTo: "GRAD_TO", gradDir: "GRAD_DIR",
  radius: "RADIUS", opacity: "OPACITY", borderColor: "BORDER_COLOR", borderWidth: "BORDER_WIDTH",
  shadow: "SHADOW", bevelOuterLight: "BEVEL_OUTER_LIGHT", bevelOuterDark: "BEVEL_OUTER_DARK",
  bevelInnerLight: "BEVEL_INNER_LIGHT", bevelInnerDark: "BEVEL_INNER_DARK", bevelWidth: "BEVEL_WIDTH",
  gradVia: "GRAD_VIA", gradViaPos: "GRAD_VIA_POS", textColor: "TEXT_COLOR", fontSlot: "FONT_SLOT",
  textAlign: "TEXT_ALIGN", lineHeight: "LINE_HEIGHT", tracking: "TRACKING", translateX: "TRANSLATE_X",
  translateY: "TRANSLATE_Y", scale: "SCALE", rotate: "ROTATE", scaleX: "SCALE_X", scaleY: "SCALE_Y",
  originX: "ORIGIN_X", originY: "ORIGIN_Y", rotateX: "ROTATE_X", rotateY: "ROTATE_Y", translateZ: "TRANSLATE_Z",
  perspective: "PERSPECTIVE", arcStart: "ARC_START", arcSweep: "ARC_SWEEP", arcWidth: "ARC_WIDTH",
};

const NODE_TYPE_CONST = { view: "View", text: "Text", image: "Image" } as const;

export function rustStr(s: string): string {
  let out = '"';
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (cp < 0x20 || cp === 0x7f) out += `\\u{${cp.toString(16)}}`;
    else out += ch;
  }
  return out + '"';
}

function rustF64(v: number): string {
  if (Number.isNaN(v)) return "f64::NAN";
  if (v === Infinity) return "f64::INFINITY";
  if (v === -Infinity) return "f64::NEG_INFINITY";
  const text = `${v}f64`;
  return v < 0 || Object.is(v, -0) ? `(${text})` : text;
}

function rustI32(v: number): string {
  return v < 0 ? `(${v}i32)` : `${v}i32`;
}

function rustTy(t: Ty): string {
  switch (t) {
    case "int": return "i32";
    case "num": return "f64";
    case "bool": return "bool";
    case "str": return "String";
    default: throw new Error(`Micro emit: no Rust type for ${t}`);
  }
}

function propConst(name: string): string {
  const c = PROP_CONST[name];
  if (!c) throw new Error(`Micro emit: unknown prop ${name}`);
  return `prop::${c}`;
}

function mask(deps: number[]): string {
  let m = 0n;
  for (const d of deps) m |= 1n << BigInt(d);
  return `0x${m.toString(16)}u64`;
}

class Emitter {
  private lines: string[] = [];
  private indent = 0;

  constructor(private readonly p: Program, private readonly styleIds: Record<string, number>) {}

  line(s = ""): void {
    this.lines.push(s.length ? "    ".repeat(this.indent) + s : "");
  }

  block(open: string, body: () => void, close = "}"): void {
    this.line(open);
    this.indent++;
    body();
    this.indent--;
    this.line(close);
  }

  styleId(literal: string): number {
    const id = this.styleIds[literal];
    if (id === undefined) throw new Error(`Micro emit: class literal has no style id: ${JSON.stringify(literal)}`);
    return id;
  }

  // ---- expressions ---------------------------------------------------------

  cast(code: string, from: Ty, to: Ty): string {
    if (from === to) return code;
    if (from === "int" && to === "num") return `(${code} as f64)`;
    throw new Error(`Micro emit: cannot cast ${from} to ${to}`);
  }

  ex(e: Expr): string {
    switch (e.k) {
      case "int": return rustI32(e.v);
      case "num": return rustF64(e.v);
      case "bool": return e.v ? "true" : "false";
      case "str": return `String::from(${rustStr(e.v)})`;
      case "undef": throw new Error("Micro emit: an undefined value reached the backend");
      case "signal": return tyOf(e) === "str" ? `self.s${e.id}.clone()` : `self.s${e.id}`;
      case "local": return e.ty === "str" ? `l_${e.name}.clone()` : `l_${e.name}`;
      case "noderef": return `self.n[${e.element}]`;
      case "unary":
        if (e.op === "!") return `(!${this.ex(e.e)})`;
        return e.ty === "int" ? `${this.ex(e.e)}.wrapping_neg()` : `(-${this.ex(e.e)})`;
      case "truthy": return this.truthy(e.e);
      case "cond": {
        const ty = e.ty;
        return `(if ${this.ex(e.c)} { ${this.cast(this.ex(e.t), tyOf(e.t), ty)} } else { ${this.cast(this.ex(e.f), tyOf(e.f), ty)} })`;
      }
      case "concat":
      case "tostr":
        return `{ let mut __s = String::new(); ${this.pushStr("__s", e)} __s }`;
      case "call": {
        const args = e.args.map((a) => this.cast(this.ex(a), tyOf(a), e.fn === "min" || e.fn === "max" ? e.ty : tyOf(a)));
        if (e.fn === "min" || e.fn === "max") {
          return e.ty === "int" ? `core::cmp::${e.fn}(${args[0]}, ${args[1]})` : `fmt::f${e.fn}(${args[0]}, ${args[1]})`;
        }
        if (e.fn === "abs") return e.ty === "int" ? `${args[0]}.wrapping_abs()` : `fmt::fabs(${args[0]})`;
        return `fmt::${e.fn}(${args[0]})`;
      }
      case "binary": return this.binary(e);
    }
  }

  truthy(e: Expr): string {
    const ty = tyOf(e);
    switch (ty) {
      case "bool": return this.ex(e);
      case "int": return `(${this.ex(e)} != 0)`;
      case "num": return `fmt::truthy_num(${this.ex(e)})`;
      case "str": return `(!${this.ex(e)}.is_empty())`;
      case "undef": return "false";
      case "node": return "true";
      default: throw new Error(`Micro emit: truthiness of ${ty}`);
    }
  }

  binary(e: Extract<Expr, { k: "binary" }>): string {
    const lt = tyOf(e.l);
    const rt = tyOf(e.r);
    const l = this.ex(e.l);
    const r = this.ex(e.r);
    switch (e.op) {
      case "+": case "-": case "*":
        if (e.ty === "int") {
          const fn = e.op === "+" ? "wrapping_add" : e.op === "-" ? "wrapping_sub" : "wrapping_mul";
          return `${l}.${fn}(${r})`;
        }
        return `(${this.cast(l, lt, "num")} ${e.op} ${this.cast(r, rt, "num")})`;
      case "/":
        return `(${this.cast(l, lt, "num")} / ${this.cast(r, rt, "num")})`;
      case "%":
        if (e.ty === "int") return `fmt::imod(${l}, ${r})`;
        return `fmt::fmod(${this.cast(l, lt, "num")}, ${this.cast(r, rt, "num")})`;
      case "<": case "<=": case ">": case ">=": case "==": case "!=": {
        if (isNumeric(lt) && isNumeric(rt)) {
          const ty: Ty = lt === "int" && rt === "int" ? "int" : "num";
          return `(${this.cast(l, lt, ty)} ${e.op} ${this.cast(r, rt, ty)})`;
        }
        return `(${l} ${e.op} ${r})`;
      }
      case "&&": case "||":
        return `(${l} ${e.op} ${r})`;
    }
  }

  /** Statements appending the JS string form of `e` to `target`: a `String`
   *  local (`byRef` false) or a `&mut String` parameter (`byRef` true). */
  pushStr(target: string, e: Expr, byRef = false): string {
    const dest = byRef ? target : `&mut ${target}`;
    switch (e.k) {
      case "str": return e.v.length ? `${target}.push_str(${rustStr(e.v)});` : "";
      case "concat": return e.parts.map((p) => this.pushStr(target, p, byRef)).join(" ");
      case "tostr": return this.pushStr(target, e.e, byRef);
      case "cond":
        if (tyOf(e) === "str") return `if ${this.ex(e.c)} { ${this.pushStr(target, e.t, byRef)} } else { ${this.pushStr(target, e.f, byRef)} }`;
        break;
      default:
        break;
    }
    switch (tyOf(e)) {
      case "int": return `fmt::push_int(${dest}, ${this.ex(e)});`;
      case "num": return `fmt::push_num(${dest}, ${this.ex(e)});`;
      case "bool": return `${target}.push_str(if ${this.ex(e)} { "true" } else { "false" });`;
      case "str": return `${target}.push_str(&${this.ex(e)});`;
      default: throw new Error(`Micro emit: cannot stringify ${tyOf(e)}`);
    }
  }

  // ---- statements ----------------------------------------------------------

  stmts(body: Stmt[]): void {
    for (const s of body) this.stmt(s);
  }

  stmt(s: Stmt): void {
    switch (s.k) {
      case "let":
        this.line(`let mut l_${s.name}: ${rustTy(s.ty)} = ${this.cast(this.ex(s.init), tyOf(s.init), s.ty)};`);
        return;
      case "assign":
        this.line(`l_${s.name} = ${this.ex(s.e)};`);
        return;
      case "set": {
        const sig = this.p.signals[s.signal];
        this.line(`self.set_s${s.signal}(${this.cast(this.ex(s.e), tyOf(s.e), sig.ty)});`);
        return;
      }
      case "if":
        this.block(`if ${this.ex(s.c)} {`, () => this.stmts(s.then), s.else ? "} else {" : "}");
        if (s.else) {
          this.indent++;
          this.stmts(s.else);
          this.indent--;
          this.line("}");
        }
        return;
      case "animate":
        this.line(
          `rt.animate(self.n[${s.target}], ${propConst(s.prop)}, ${this.cast(this.ex(s.to), tyOf(s.to), "num")}, ` +
            `${this.ms(s.durMs)}, ${s.easing}u8, ${this.ms(s.delayMs)});`,
        );
        return;
      case "jump":
        this.line(`rt.set_prop(self.n[${s.target}], ${propConst(s.prop)}, ${this.cast(this.ex(s.value), tyOf(s.value), "num")});`);
        return;
      case "return":
        this.line("return;");
        return;
      case "nop":
        this.line(`// ${s.note}`);
        return;
    }
  }

  ms(e: Expr): string {
    if (e.k === "int") return `${Math.max(0, e.v)}u32`;
    if (tyOf(e) === "int") return `${this.ex(e)}.max(0) as u32`;
    return `fmt::ms(${this.ex(e)})`;
  }

  // ---- program ------------------------------------------------------------

  emit(): string {
    const p = this.p;
    const elements: ElementNode[] = [];
    const shows: ShowNode[] = [];
    const showOf = new Map<number, number>(); // element id -> enclosing show id
    const stack: number[] = [];
    const visit = (nodes: Node[]) => {
      for (const n of nodes) {
        if (n.k === "element") {
          elements.push(n);
          if (stack.length) showOf.set(n.id, stack[stack.length - 1]);
          visit(n.children);
        } else {
          shows.push(n);
          if (stack.length) showOf.set(-1 - n.id, stack[stack.length - 1]);
          stack.push(n.id);
          visit(n.children);
          stack.pop();
        }
      }
    };
    visit(p.root);
    elements.sort((a, b) => a.id - b.id);

    const dynText = elements.filter((e) => e.text && e.text.deps.length > 0);
    const dynClass = elements.filter((e) => e.class && e.class.deps.length > 0);
    const dynStyle: { el: ElementNode; prop: string; propId: number; value: Binding }[] = [];
    for (const el of elements) for (const s of el.style ?? []) if (s.value.deps.length > 0) dynStyle.push({ el, ...s });

    this.line(`// Generated by Pocket Micro from ${p.module} (component ${p.component}). Do not edit.`);
    this.line(`//`);
    this.line(`// Signals: ${p.signals.map((s) => `s${s.id} = ${s.name}: ${s.ty}`).join(", ") || "none"}`);
    this.line(`// Elements (${p.elements}):`);
    for (const el of elements) {
      const tags = [el.debugName ? `"${el.debugName}"` : "", el.focusable ? "focusable" : "", el.refs?.length ? `ref ${el.refs.join(",")}` : ""].filter(Boolean);
      this.line(`//   n[${el.id}] ${el.origin}${tags.length ? " " + tags.join(" ") : ""}`);
    }
    this.line(`// Style ids:`);
    for (const lit of p.assets.classes) this.line(`//   ${this.styleId(lit)} = ${JSON.stringify(lit)}`);
    this.line(`#[allow(unused_variables, unused_mut, unused_imports, dead_code, non_snake_case, unused_parens, clippy::all)]`);
    this.block("pub mod app {", () => {
      this.line("use alloc::string::String;");
      this.line("use pocket_micro::spec::{prop, NodeType};");
      this.line("use pocket_micro::{fmt, App as MicroApp, NodeId, Runtime, StyleId};");
      this.line();
      this.line(`pub const ELEMENTS: usize = ${p.elements};`);
      this.line(`pub const TITLE: &str = ${rustStr(p.title)};`);
      this.line();
      this.block("pub struct App {", () => {
        for (const s of p.signals) this.line(`s${s.id}: ${rustTy(s.ty)}, // ${s.name}`);
        this.line("n: [NodeId; ELEMENTS],");
        for (const s of shows) this.line(`show${s.id}: bool,`);
        for (const e of dynText) this.line(`t${e.id}: String,`);
        for (const d of dynStyle) this.line(`p${d.el.id}_${d.prop}: f64,`);
        for (const e of dynClass) this.line(`c${e.id}: i32,`);
        this.line("dirty: u64,");
      });
      this.line();
      this.block("impl App {", () => {
        this.block("pub const fn new() -> Self {", () => {
          this.block("App {", () => {
            for (const s of p.signals) this.line(`s${s.id}: ${this.constInit(s.init, s.ty)},`);
            this.line("n: [NodeId::NONE; ELEMENTS],");
            for (const s of shows) this.line(`show${s.id}: false,`);
            for (const e of dynText) this.line(`t${e.id}: String::new(),`);
            for (const d of dynStyle) this.line(`p${d.el.id}_${d.prop}: 0.0,`);
            for (const e of dynClass) this.line(`c${e.id}: -1,`);
            this.line("dirty: 0,");
          });
        });
        for (const s of p.signals) {
          this.line();
          this.block(`fn set_s${s.id}(&mut self, v: ${rustTy(s.ty)}) {`, () => {
            this.block("if v != self.s" + s.id + " {", () => {
              this.line(`self.s${s.id} = v;`);
              this.line(`self.dirty |= ${mask([s.id])};`);
            });
          });
        }
        for (const e of dynText) {
          this.line();
          this.block(`fn text_${e.id}(&self, out: &mut String) {`, () => {
            const code = this.pushStr("out", e.text!.expr, true);
            if (code) this.line(code);
          });
          this.block(`fn apply_text_${e.id}(&mut self, rt: &mut Runtime) {`, () => {
            this.line("let mut s = String::new();");
            this.line(`self.text_${e.id}(&mut s);`);
            this.block(`if s != self.t${e.id} {`, () => {
              this.line(`rt.set_text(self.n[${e.id}], &s);`);
              this.line(`self.t${e.id} = s;`);
            });
          });
        }
        for (const d of dynStyle) {
          this.line();
          this.block(`fn apply_style_${d.el.id}_${d.prop}(&mut self, rt: &mut Runtime) {`, () => {
            this.line(`let v: f64 = ${this.cast(this.ex(d.value.expr), tyOf(d.value.expr), "num")};`);
            this.block(`if v != self.p${d.el.id}_${d.prop} {`, () => {
              this.line(`self.p${d.el.id}_${d.prop} = v;`);
              this.line(`rt.set_prop(self.n[${d.el.id}], ${propConst(d.prop)}, v);`);
            });
          });
        }
        for (const e of dynClass) {
          this.line();
          this.block(`fn class_${e.id}(&self) -> i32 {`, () => {
            this.line(this.classExpr(e.class!.expr));
          });
          this.block(`fn apply_class_${e.id}(&mut self, rt: &mut Runtime) {`, () => {
            this.line(`let id = self.class_${e.id}();`);
            this.block(`if id != self.c${e.id} {`, () => {
              this.line(`self.c${e.id} = id;`);
              this.line(`rt.set_style(self.n[${e.id}], StyleId(id));`);
            });
          });
        }
        for (const s of shows) {
          const parent = this.parentOfShow(s, p.root);
          this.line();
          this.block(`fn mount_show${s.id}(&mut self, rt: &mut Runtime) {`, () => {
            const anchor = s.anchor === null ? "NodeId::NONE" : `self.n[${s.anchor}]`;
            this.mountNodes(s.children, parent, anchor);
            for (const f of s.focusables) {
              this.line(`rt.register_focusable(self.n[${f.element}], ${f.order}u32, ${f.handler === undefined ? "None" : `Some(${f.handler}u16)`});`);
            }
            this.line(`self.show${s.id} = true;`);
          });
          this.block(`fn unmount_show${s.id}(&mut self, rt: &mut Runtime) {`, () => {
            for (const f of s.focusables) this.line(`rt.unregister_focusable(self.n[${f.element}]);`);
            for (const c of s.children) if (c.k === "element") this.line(`rt.destroy(self.n[${c.id}]);`);
            walkNodes(s.children, (n) => {
              if (n.k === "element") this.line(`self.n[${n.id}] = NodeId::NONE;`);
              else this.line(`self.show${n.id} = false;`);
            });
            this.line(`self.show${s.id} = false;`);
          });
          this.block(`fn apply_show${s.id}(&mut self, rt: &mut Runtime) {`, () => {
            this.line(`let on = ${this.ex(s.when.expr)};`);
            this.block(`if on != self.show${s.id} {`, () => {
              this.line(`if on { self.mount_show${s.id}(rt); } else { self.unmount_show${s.id}(rt); }`);
            });
          });
        }
        for (const h of p.handlers) {
          this.line();
          this.block(`fn handler_${h.id}(&mut self, rt: &mut Runtime) {`, () => this.stmts(h.body));
        }
        for (const e of p.effects) {
          this.line();
          this.block(`fn effect_${e.id}(&mut self, rt: &mut Runtime) {`, () => this.stmts(e.body));
        }
        for (const m of p.mounts) {
          this.line();
          this.block(`fn mount_${m.id}(&mut self, rt: &mut Runtime) {`, () => this.stmts(m.body));
        }
      });
      this.line();
      this.block("impl MicroApp for App {", () => {
        this.block("fn mount(&mut self, rt: &mut Runtime) {", () => {
          this.line("let root = rt.app_root();");
          this.mountNodes(p.root, "root", "NodeId::NONE");
          for (const f of p.focusables) {
            this.line(`rt.register_focusable(self.n[${f.element}], ${f.order}u32, ${f.handler === undefined ? "None" : `Some(${f.handler}u16)`});`);
          }
          for (const step of p.setupOrder) this.line(`self.${step.kind}_${step.id}(rt);`);
        });
        this.line();
        this.block("fn press(&mut self, rt: &mut Runtime, handler: u16) {", () => {
          this.block("match handler {", () => {
            for (const h of p.handlers) this.line(`${h.id} => self.handler_${h.id}(rt),`);
            this.line("_ => {}");
          });
        });
        this.line();
        this.block("fn flush(&mut self, rt: &mut Runtime) {", () => {
          this.block("for _ in 0..32 {", () => {
            this.line("let d = core::mem::take(&mut self.dirty);");
            this.line("if d == 0 { break; }");
            // Bindings in template pre-order.
            const guard = (elementId: number, code: string) => {
              const show = showOf.get(elementId);
              return show === undefined ? code : `if self.show${show} { ${code} }`;
            };
            const emitBinding = (deps: number[], code: string) => {
              if (deps.length === 0) return;
              this.line(`if d & ${mask(deps)} != 0 { ${code} }`);
            };
            walkNodes(p.root, (n) => {
              if (n.k === "element") {
                if (n.class && n.class.deps.length) emitBinding(n.class.deps, guard(n.id, `self.apply_class_${n.id}(rt);`));
                for (const s of n.style ?? []) if (s.value.deps.length) emitBinding(s.value.deps, guard(n.id, `self.apply_style_${n.id}_${s.prop}(rt);`));
                if (n.text && n.text.deps.length) emitBinding(n.text.deps, guard(n.id, `self.apply_text_${n.id}(rt);`));
              } else {
                const outer = showOf.get(-1 - n.id);
                const code = `self.apply_show${n.id}(rt);`;
                emitBinding(n.when.deps, outer === undefined ? code : `if self.show${outer} { ${code} }`);
              }
            });
            for (const e of p.effects) emitBinding(e.deps, `self.effect_${e.id}(rt);`);
          });
        });
        this.line();
        this.block("fn state(&self, out: &mut String) {", () => {
          this.line('out.push_str("{");');
          p.signals.forEach((s, i) => {
            this.line(`out.push_str(${rustStr((i ? "," : "") + JSON.stringify(s.name) + ":")});`);
            const read: Expr = { k: "signal", id: s.id, ty: s.ty };
            if (s.ty === "str") this.line(`fmt::push_json_str(out, &self.s${s.id});`);
            else this.line(this.pushStr("out", read, true));
          });
          this.line('out.push_str("}");');
        });
      });
    });
    return this.lines.join("\n") + "\n";
  }

  constInit(e: Expr, ty: Ty): string {
    switch (e.k) {
      case "int": return ty === "num" ? rustF64(e.v) : rustI32(e.v);
      case "num": return rustF64(e.v);
      case "bool": return e.v ? "true" : "false";
      case "str": return "String::new()"; // seeded in mount (String::from is not const)
      default: throw new Error("Micro emit: signal seeds are literals");
    }
  }

  classExpr(e: Expr): string {
    if (e.k === "str") return `${this.styleId(e.v)}i32`;
    if (e.k === "cond") return `if ${this.ex(e.c)} { ${this.classExpr(e.t)} } else { ${this.classExpr(e.f)} }`;
    throw new Error("Micro emit: class binding is a literal or a ternary of literals");
  }

  parentOfShow(target: ShowNode, nodes: Node[], parent = "rt.app_root()"): string {
    for (const n of nodes) {
      if (n === target) return parent;
      const found = this.parentOfShow(target, n.children, n.k === "element" ? `self.n[${n.id}]` : parent);
      if (found) return found;
    }
    return "";
  }

  mountNodes(nodes: Node[], parent: string, anchor: string): void {
    for (const n of nodes) {
      if (n.k === "show") {
        this.line(`if ${this.ex(n.when.expr)} { self.mount_show${n.id}(rt); }`);
        continue;
      }
      const id = `self.n[${n.id}]`;
      this.line(`${id} = rt.create(NodeType::${NODE_TYPE_CONST[n.tag]} as u8, ${parent}, ${anchor}); // ${n.origin}${n.debugName ? ` "${n.debugName}"` : ""}`);
      if (n.class) {
        if (n.class.deps.length === 0) this.line(`rt.set_style(${id}, StyleId(${this.classExpr(n.class.expr)}));`);
        else {
          this.line(`self.c${n.id} = self.class_${n.id}();`);
          this.line(`rt.set_style(${id}, StyleId(self.c${n.id}));`);
        }
      }
      for (const s of n.style ?? []) {
        if (s.value.deps.length === 0) {
          this.line(`rt.set_prop(${id}, ${propConst(s.prop)}, ${this.cast(this.ex(s.value.expr), tyOf(s.value.expr), "num")});`);
        } else {
          this.line(`self.p${n.id}_${s.prop} = ${this.cast(this.ex(s.value.expr), tyOf(s.value.expr), "num")};`);
          this.line(`rt.set_prop(${id}, ${propConst(s.prop)}, self.p${n.id}_${s.prop});`);
        }
      }
      if (n.src !== undefined) this.line(`rt.set_image(${id}, ${rustStr(n.src)});`);
      if (n.sprite) this.line(`rt.set_sprite(${id}, ${rustStr(n.sprite.key)}, ${n.sprite.frameStep === undefined ? "None" : `Some(${n.sprite.frameStep}u16)`});`);
      if (n.text) {
        if (n.text.deps.length === 0) {
          if (n.text.expr.k === "str") {
            if (n.text.expr.v.length) this.line(`rt.set_text(${id}, ${rustStr(n.text.expr.v)});`);
          } else {
            this.line(`{ let mut s = String::new(); ${this.pushStr("s", n.text.expr)} rt.set_text(${id}, &s); }`);
          }
        } else {
          this.line(`{ let mut s = String::new(); self.text_${n.id}(&mut s); rt.set_text(${id}, &s); self.t${n.id} = s; }`);
        }
      }
      if (n.children.length) this.mountNodes(n.children, id, "NodeId::NONE");
    }
  }
}

export function emitRust(program: Program, options: EmitOptions): string {
  const e = new Emitter(program, options.styleIds);
  return e.emit();
}

/** Human-readable memory/plan summary printed by the CLI. */
export function planSummary(program: Program, styleCount: number, fontSlots: number[]): string {
  let dynText = 0;
  let dynStyle = 0;
  let dynClass = 0;
  walkNodes(program.root, (n) => {
    if (n.k !== "element") return;
    if (n.text && n.text.deps.length) dynText++;
    if (n.class && n.class.deps.length) dynClass++;
    for (const s of n.style ?? []) if (s.value.deps.length) dynStyle++;
  });
  const lines = [
    `  component: ${program.component} (${program.module})`,
    `  signals: ${program.signals.length} (${program.signals.map((s) => `${s.name}: ${s.ty}`).join(", ") || "none"})`,
    `  elements: ${program.elements}, conditional blocks: ${program.shows}, focusables: ${program.focusables.length}`,
    `  bindings: ${dynText} text, ${dynStyle} style, ${dynClass} class; effects: ${program.effects.length}; mounts: ${program.mounts.length}; handlers: ${program.handlers.length}`,
    `  styles: ${program.assets.classes.length} class literals -> ${styleCount} records; fonts: ${fontSlots.map((s) => { const i = fontSlotInfo(s); return `${i.px}px${i.bold ? " bold" : ""}`; }).join(", ")}`,
    `  assets: images ${program.assets.images.join(", ") || "none"}; sprites ${program.assets.sprites.join(", ") || "none"}`,
  ];
  return lines.join("\n");
}

export { collectDeps };
