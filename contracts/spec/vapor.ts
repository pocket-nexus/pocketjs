// Pocket Vapor's admitted vocabulary, shared by the compiler and both runtimes.
import { NODE_TYPE, PROP, PROP_VALUE_KIND, VALUE_KIND } from "./spec.ts";

export const VAPOR_NUMERIC_TYPES = [
  "i8", "i16", "i32", "i64", "u8", "u16", "u32", "u64", "usize", "f32", "f64",
] as const;
export type VaporNumericType = (typeof VAPOR_NUMERIC_TYPES)[number];

export const VAPOR_ELEMENTS = {
  View: {
    nodeType: NODE_TYPE.view,
    attributes: ["class", "style", "focusable", "debug-name"],
    events: ["press"],
  },
  Text: { nodeType: NODE_TYPE.text, attributes: ["class"], events: [] },
  Image: { nodeType: NODE_TYPE.image, attributes: ["class", "src"], events: [] },
} as const;

export const VAPOR_STYLE_PROPS = Object.fromEntries(
  Object.entries(PROP).map(([name, id]) => {
    const kind = PROP_VALUE_KIND[name as keyof typeof PROP];
    return [name, { id, type: kind === VALUE_KIND.f32 ? "f32" : kind === VALUE_KIND.color ? "u32" : "i32" }];
  }),
) as { [P in keyof typeof PROP]: { id: (typeof PROP)[P]; type: "f32" | "i32" | "u32" } };

export const VAPOR_BUILTINS = {
  len: { parameters: ["string | T[]"], result: "i32", numeric: "none" },
  trunc: { parameters: ["float"], result: "i32", numeric: "float" },
  floor: { parameters: ["float"], result: "i32", numeric: "float" },
  ceil: { parameters: ["float"], result: "i32", numeric: "float" },
  round: { parameters: ["float"], result: "i32", numeric: "float" },
  idiv: { parameters: ["T", "T"], result: "T", numeric: "integer" },
  imod: { parameters: ["T", "T"], result: "T", numeric: "integer" },
  min: { parameters: ["T", "T"], result: "T", numeric: "same" },
  max: { parameters: ["T", "T"], result: "T", numeric: "same" },
  abs: { parameters: ["T"], result: "T", numeric: "same" },
  clamp: { parameters: ["T", "T", "T"], result: "T", numeric: "same" },
  fixed: { parameters: ["float", "i32"], result: "string", numeric: "float" },
} as const;
export type VaporBuiltin = keyof typeof VAPOR_BUILTINS;

const generated = "// GENERATED — do not edit; run `bun contracts/spec/gen-rust.ts`.\n";

export function generateVaporNumericTypes(): string {
  return generated + VAPOR_NUMERIC_TYPES.map((name) =>
    `export type ${name} = number & { readonly __type?: ${JSON.stringify(name)} };`,
  ).join("\n") + "\n";
}

export function generateVaporStdDeclarations(): string {
  const lines = [generated.trimEnd(), 'export type * from "./numeric-vue-vapor.ts";',
    'import type { i32, f32, f64 } from "./numeric-vue-vapor.ts";'];
  for (const [name, spec] of Object.entries(VAPOR_BUILTINS)) {
    if (name === "len") lines.push("export declare function len<T>(value: string | readonly T[]): i32;");
    else if (name === "fixed") lines.push("export declare function fixed(value: f32 | f64, digits: i32): string;");
    else if (spec.result === "i32") lines.push(`export declare function ${name}(value: f32 | f64): i32;`);
    else {
      const args = spec.parameters.map((_, index) => `${["value", "other", "upper"][index]}: T`);
      lines.push(`export declare function ${name}<T extends number>(${args.join(", ")}): T;`);
    }
  }
  return lines.join("\n") + "\n";
}

export function generateVaporComponentTypes(): string {
  const numericInputs = VAPOR_NUMERIC_TYPES.filter(name => name !== "f64");
  const lines = [generated.trimEnd(), `import type { ${numericInputs.join(", ")} } from "./numeric-vue-vapor.ts";`,
    `export type VaporFloatInput = ${numericInputs.join(" | ")};`,
    "export interface VaporStyleProps {"];
  for (const [name, prop] of Object.entries(VAPOR_STYLE_PROPS)) lines.push(`  ${name}?: ${prop.type === "f32" ? "VaporFloatInput" : prop.type};`);
  lines.push("}");
  for (const [element, spec] of Object.entries(VAPOR_ELEMENTS)) {
    lines.push(`export interface Vapor${element}Props {`);
    for (const attribute of spec.attributes) {
      const type = attribute === "style" ? "VaporStyleProps" : attribute === "focusable" ? "boolean" : "string";
      lines.push(`  ${JSON.stringify(attribute)}?: ${type};`);
    }
    for (const event of spec.events) lines.push(`  on${event[0].toUpperCase()}${event.slice(1)}?: () => void;`);
    lines.push("}");
  }
  return lines.join("\n") + "\n";
}

export function generateVaporRust(): string {
  const lines = [generated.trimEnd(), "pub use pocketjs_core::spec::{btn, prop, Display, NodeType};", "",
    `pub const NUMERIC_TYPES: &[&str] = &[${VAPOR_NUMERIC_TYPES.map((name) => JSON.stringify(name)).join(", ")}];`,
    `pub const BUILTINS: &[&str] = &[${Object.keys(VAPOR_BUILTINS).map((name) => JSON.stringify(name)).join(", ")}];`,
    "pub const HOST_ELEMENTS: &[(&str, u8)] = &["];
  for (const [name, spec] of Object.entries(VAPOR_ELEMENTS)) lines.push(`    (${JSON.stringify(name)}, ${spec.nodeType}),`);
  lines.push("];", "pub const STYLE_PROPS: &[(&str, u8, &str)] = &[");
  for (const [name, prop] of Object.entries(VAPOR_STYLE_PROPS)) lines.push(`    (${JSON.stringify(name)}, ${prop.id}, ${JSON.stringify(prop.type)}),`);
  lines.push("];", "pub const HOST_ATTRIBUTES: &[(&str, &[&str])] = &[");
  for (const [name, spec] of Object.entries(VAPOR_ELEMENTS)) lines.push(`    (${JSON.stringify(name)}, &[${spec.attributes.map((a) => JSON.stringify(a)).join(", ")}]),`);
  lines.push("];", "pub const HOST_EVENTS: &[(&str, &[&str])] = &[");
  for (const [name, spec] of Object.entries(VAPOR_ELEMENTS)) lines.push(`    (${JSON.stringify(name)}, &[${spec.events.map((a) => JSON.stringify(a)).join(", ")}]),`);
  lines.push("];", "pub const BUILTIN_SIGNATURES: &[(&str, &[&str], &str, &str)] = &[");
  for (const [name, spec] of Object.entries(VAPOR_BUILTINS)) lines.push(`    (${JSON.stringify(name)}, &[${spec.parameters.map((a) => JSON.stringify(a)).join(", ")}], ${JSON.stringify(spec.result)}, ${JSON.stringify(spec.numeric)}),`);
  lines.push("];");
  return lines.join("\n") + "\n";
}
