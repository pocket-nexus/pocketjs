import type { RustBlock, RustExpr, RustFunction, RustGeneric, RustItem, RustModule, RustPattern, RustStatement, RustType } from "./rust-ast";

const keywords = new Set("abstract as async await become box break const continue crate do dyn else enum extern false final fn for gen if impl in let loop macro match mod move mut override priv pub ref return self Self static struct super trait true try type typeof union unsafe unsized use virtual where while yield".split(" "));

/** Rust names are escaped here; analysis retains the original contract names. */
export function rustIdentifier(name: string): string {
  if (!["self", "Self", "crate", "super", "_"].includes(name) && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) && !name.startsWith("__pocket_escaped_")) return keywords.has(name) ? `r#${name}` : name;
  return `__pocket_escaped_${[...name].map(c => c.codePointAt(0)!.toString(16)).join("_") || "empty"}`;
}
export function rustVariant(name: string): string {
  const result = name.split(/[^A-Za-z0-9]+/u).filter(Boolean).map(part => part[0]!.toUpperCase() + part.slice(1)).join("");
  return result || "EmptyLiteral";
}
const path = (parts: string[]) => parts.map((name, i) => i === 0 && ["self", "Self", "crate", "super"].includes(name) ? name : rustIdentifier(name)).join("::");
export function allocateRustTypeNames(names: string[], reserved: (name: string) => boolean): Map<string, string> {
  const used = new Set(names.filter(name => !reserved(name))); const result = new Map<string, string>();
  for (const name of names) {
    let candidate = name; let suffix = 2;
    if (reserved(name)) { while (reserved(candidate) || used.has(candidate)) candidate = `${name}_${suffix++}`; }
    used.add(candidate); result.set(name, candidate);
  }
  return result;
}
function literal(value: string | number | boolean, suffix?: string, rawNumber?: string): string {
  if (typeof value === "string") {
    let result = '"';
    for (const char of value) {
      const code = char.codePointAt(0)!;
      if (code >= 0xd800 && code <= 0xdfff) throw new Error("A Rust string cannot contain an unpaired UTF-16 surrogate");
      result += char === '"' ? '\\"' : char === "\\" ? "\\\\" : char === "\n" ? "\\n" : char === "\r" ? "\\r" : char === "\t" ? "\\t" : code < 0x20 || code === 0x7f ? `\\u{${code.toString(16)}}` : char;
    }
    return result + '"';
  }
  if (typeof value === "boolean") return String(value);
  const floatingValue = suffix === "f32" ? Math.fround(value) : value;
  if (!Number.isFinite(floatingValue)) return `${suffix === "f32" ? "f32" : "f64"}::${floatingValue === Infinity ? "INFINITY" : floatingValue === -Infinity ? "NEG_INFINITY" : "NAN"}`;
  if (rawNumber !== undefined) {
    if (!/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u.test(rawNumber)) throw new Error("Invalid normalized numeric literal in Rust AST");
    if (suffix && /^(?:[iu]\d+|usize)$/u.test(suffix) && /^-?\d+$/u.test(rawNumber)) return `${BigInt(rawNumber)}${suffix}`;
    if (!suffix || suffix.startsWith("f")) return `${rawNumber.replace(/^(-?)\./u, (_, sign) => `${sign}0.`).replace(/\.$/u, ".0")}${suffix ?? ""}`;
  }
  if (suffix && /^(?:[iu]\d+|usize)$/u.test(suffix) && Number.isInteger(value)) return `${BigInt(value)}${suffix}`;
  return `${Object.is(value, -0) ? "-0.0" : value}${suffix ?? ""}`;
}
function type(t: RustType): string {
  switch (t.kind) {
    case "path": return path(t.path) + (t.args?.length ? `<${t.args.map(type).join(", ")}>` : "");
    case "ref": return `&${t.lifetime ? `'${t.lifetime} ` : ""}${t.mutable ? "mut " : ""}${type(t.type)}`;
    case "tuple": return `(${t.elements.map(type).join(", ")}${t.elements.length === 1 ? "," : ""})`;
    case "slice": return `[${type(t.element)}]`;
    case "array": return `[${type(t.element)}; ${t.length}]`;
    case "lifetime": return `'${t.name}`;
    case "const": return String(t.value);
    case "dyn": return `dyn ${t.bounds.map(type).join(" + ")}`;
    case "binding": return `${rustIdentifier(t.name)} = ${type(t.type)}`;
    case "infer": return "_";
  }
}
function generics(gs?: RustGeneric[]): string {
  return gs?.length ? `<${gs.map(g => `${g.lifetime ? "'" : ""}${rustIdentifier(g.name)}${g.bounds?.length ? `: ${g.bounds.map(type).join(" + ")}` : ""}${g.default ? ` = ${type(g.default)}` : ""}`).join(", ")}>` : "";
}
function pattern(p: RustPattern): string {
  switch (p.kind) {
    case "name": return `${p.reference ? "ref " : ""}${p.mutable ? "mut " : ""}${rustIdentifier(p.name)}`;
    case "wildcard": return "_";
    case "tuple": return `(${p.elements.map(pattern).join(", ")}${p.elements.length === 1 ? "," : ""})`;
    case "variant": return path(p.path) + (p.tuple ? `(${p.tuple.map(pattern).join(", ")})` : p.fields ? ` { ${[...p.fields.map(f => rustIdentifier(f.name) + (f.pattern ? `: ${pattern(f.pattern)}` : "")), ...(p.rest ? [".."] : [])].join(", ")} }` : "");
    case "literal": return literal(p.value);
    case "reference": return `&${pattern(p.pattern)}`;
    case "or": return p.patterns.map(pattern).join(" | ");
  }
}
const precedence: Record<string, number> = { "||": 2, "&&": 3, "==": 4, "!=": 4, "<": 4, "<=": 4, ">": 4, ">=": 4, "|": 5, "^": 6, "&": 7, "<<": 8, ">>": 8, "+": 9, "-": 9, "*": 10, "/": 10, "%": 10 };

class Printer {
  level = 0;
  indent() { return "    ".repeat(this.level); }
  expression(e: RustExpr, parent = 0): string {
    let out: string; let p = 15;
    switch (e.kind) {
      case "path": out = path(e.path) + (e.typeArgs?.length ? `::<${e.typeArgs.map(type).join(", ")}>` : ""); break;
      case "qualifiedPath": out = `<${type(e.type)}>::${rustIdentifier(e.member)}`; break;
      case "literal": out = literal(e.value, e.suffix, e.rawNumber); break;
      case "call": out = `${this.expression(e.callee, 14)}(${e.args.map(a => this.expression(a)).join(", ")})`; p = 14; break;
      case "method": out = `${this.expression(e.object, 14)}.${rustIdentifier(e.method)}${e.typeArgs?.length ? `::<${e.typeArgs.map(type).join(", ")}>` : ""}(${e.args.map(a => this.expression(a)).join(", ")})`; p = 14; break;
      case "field": out = `${this.expression(e.object, 14)}.${typeof e.field === "number" ? e.field : rustIdentifier(e.field)}`; p = 14; break;
      case "index": out = `${this.expression(e.object, 14)}[${this.expression(e.index)}]`; p = 14; break;
      case "ref": out = `&${e.mutable ? "mut " : ""}${this.expression(e.expr, 12)}`; p = 12; break;
      case "unary": out = `${e.operator}${this.expression(e.expr, 12)}`; p = 12; break;
      case "binary": p = precedence[e.operator] ?? 1; out = `${this.expression(e.left, p)} ${e.operator} ${this.expression(e.right, p + 1)}`; break;
      case "cast": p = 11; out = `${this.expression(e.expr, p)} as ${type(e.type)}`; break;
      case "tuple": out = `(${e.elements.map(a => this.expression(a)).join(", ")}${e.elements.length === 1 ? "," : ""})`; break;
      case "array": out = `[${e.elements.map(a => this.expression(a)).join(", ")}]`; break;
      case "struct": out = `${path(e.path)} { ${[...e.fields.map(f => rustIdentifier(f.name) + (f.value ? `: ${this.expression(f.value)}` : "")), ...(e.rest ? [`..${this.expression(e.rest)}`] : [])].join(", ")} }`; break;
      case "block": out = this.block(e.block); p = 1; break;
      case "if": out = `if ${this.expression(e.condition)} ${this.block(e.then)}${e.otherwise ? ` else ${"kind" in e.otherwise ? this.expression(e.otherwise) : this.block(e.otherwise)}` : ""}`; p = 1; break;
      case "ifLet": out = `if let ${pattern(e.pattern)} = ${this.expression(e.value)} ${this.block(e.then)}${e.otherwise ? ` else ${"kind" in e.otherwise ? this.expression(e.otherwise) : this.block(e.otherwise)}` : ""}`; p = 1; break;
      case "match": {
        this.level++;
        const arms = e.arms.map(a => `${this.indent()}${pattern(a.pattern)}${a.guard ? ` if ${this.expression(a.guard)}` : ""} => ${this.expression(a.body)},`).join("\n");
        this.level--;
        out = `match ${this.expression(e.value)} {\n${arms}\n${this.indent()}}`; p = 1; break;
      }
      case "closure": out = `${e.move ? "move " : ""}|${e.params.map(pattern).join(", ")}| ${this.expression(e.body)}`; p = 1; break;
      case "macro": out = `${path(e.name)}!(${e.args.map(a => this.expression(a)).join(", ")})`; break;
      case "matches": out = `matches!(${this.expression(e.value)}, ${pattern(e.pattern)})`; break;
    }
    return p < parent ? `(${out})` : out;
  }
  statement(s: RustStatement): string {
    switch (s.kind) {
      case "let": return `let ${pattern(s.pattern)}${s.type ? `: ${type(s.type)}` : ""}${s.value ? ` = ${this.expression(s.value)}` : ""};`;
      case "expr": return this.expression(s.expr) + (s.semicolon === false ? "" : ";");
      case "assign": return `${this.expression(s.target)} ${s.operator ?? "="} ${this.expression(s.value)};`;
      case "for": return `for ${pattern(s.pattern)} in ${this.expression(s.iterable)} ${this.block(s.body)}`;
      case "while": return `while ${this.expression(s.condition)} ${this.block(s.body)}`;
      case "loop": return `loop ${this.block(s.body)}`;
      case "return": return `return${s.value ? ` ${this.expression(s.value)}` : ""};`;
      case "break": return "break;";
      case "continue": return "continue;";
    }
  }
  block(b: RustBlock): string {
    if (!b.statements.length && !b.result) return "{}";
    this.level++;
    const lines = b.statements.map(s => this.indent() + this.statement(s));
    if (b.result) lines.push(this.indent() + this.expression(b.result));
    this.level--;
    return `{\n${lines.join("\n")}\n${this.indent()}}`;
  }
  fn(f: RustFunction): string {
    const params = f.params.map(p => p.pattern.kind === "name" && p.pattern.name === "self" ? p.type?.kind === "ref" ? `&${p.type.mutable ? "mut " : ""}self` : `${p.pattern.mutable ? "mut " : ""}self` : `${pattern(p.pattern)}${p.type ? `: ${type(p.type)}` : ""}`).join(", ");
    return `${f.public ? "pub " : ""}fn ${rustIdentifier(f.name)}${generics(f.generics)}(${params})${f.returns ? ` -> ${type(f.returns)}` : ""}${f.body ? ` ${this.block(f.body)}` : ";"}`;
  }
  item(i: RustItem): string {
    const pub_ = "public" in i && i.public ? "pub " : "";
    const derives = "derives" in i && i.derives?.length ? `#[derive(${i.derives.map(rustIdentifier).join(", ")})]\n` : "";
    switch (i.kind) {
      case "extern": return `extern crate ${rustIdentifier(i.name)};`;
      case "use": return `${pub_}use ${path(i.path)}${i.names ? `::{${i.names.map(n => n === "*" ? "*" : rustIdentifier(n)).join(", ")}}` : ""};`;
      case "mod": return `${pub_}mod ${rustIdentifier(i.name)};`;
      case "const": return `${pub_}const ${rustIdentifier(i.name)}: ${type(i.type)} = ${this.expression(i.value)};`;
      case "typeAlias": return `${pub_}type ${rustIdentifier(i.name)}${generics(i.generics)} = ${type(i.type)};`;
      case "fn": return this.fn(i);
      case "struct": return derives + `${pub_}struct ${rustIdentifier(i.name)}${generics(i.generics)}` + (i.tuple ? `(${i.tuple.map(t => `${pub_}${type(t)}`).join(", ")});` : ` {\n${(i.fields ?? []).map(f => `    ${f.public ? "pub " : ""}${rustIdentifier(f.name)}: ${type(f.type)},`).join("\n")}\n}`);
      case "enum": return derives + `${pub_}enum ${rustIdentifier(i.name)}${generics(i.generics)} {\n${i.variants.map(v => `    ${rustIdentifier(v.name)}${v.tuple ? `(${v.tuple.map(type).join(", ")})` : v.fields?.length ? ` { ${v.fields.map(f => `${rustIdentifier(f.name)}: ${type(f.type)}`).join(", ")} }` : ""},`).join("\n")}\n}`;
      case "trait":
      case "impl": {
        this.level++;
        const body = [...(i.kind === "trait" ? (i.associatedTypes ?? []).map(t => `${this.indent()}type ${rustIdentifier(t.name)}: ${t.bounds.map(type).join(" + ")};`) : []), ...i.methods.map(f => this.indent() + this.fn(f))].join("\n\n");
        this.level--;
        return (i.kind === "trait" ? `${pub_}trait ${rustIdentifier(i.name)}${generics(i.generics)}${i.bounds?.length ? `: ${i.bounds.map(type).join(" + ")}` : ""}` : `impl${generics(i.generics)} ${i.trait ? `${type(i.trait)} for ` : ""}${type(i.type)}`) + ` {\n${body}\n}`;
      }
    }
  }
}
export function printRust(module: RustModule): string {
  const printer = new Printer();
  return "// Generated by Pocket Vapor. Do not edit.\n\n" + (module.attributes ?? []).map(a => `#![${rustIdentifier(a.name)}(${a.args.map(rustIdentifier).join(", ")})]\n`).join("") + "\n" + module.items.map(item => printer.item(item)).join("\n\n") + "\n";
}
