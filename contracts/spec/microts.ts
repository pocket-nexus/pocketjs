// MicroTS's admitted vocabulary, shared by the compiler and both runtimes.
import { NODE_TYPE, PROP, PROP_VALUE_KIND, VALUE_KIND } from "./spec.ts";
import { MOTION_LEVELS, MOTION_MIN_QUALITIES, MOTION_VALUES, MotionLevel, MotionQuality, MotionReferenceFrame, motionValueParameters, type MotionValueName } from "./motion.ts";

export const MICROTS_NUMERIC_TYPES = [
  "i8", "i16", "i32", "i64", "u8", "u16", "u32", "u64", "usize", "f32", "f64",
] as const;
export type MicroTsNumericType = (typeof MICROTS_NUMERIC_TYPES)[number];

export const RelativeAxis = { Primary: 0, Secondary: 1 } as const;
export const RelativeAxisUnits = { PerDegree: 1_000, PerTurn: 360_000 } as const;
export type RelativeAxisId = (typeof RelativeAxis)[keyof typeof RelativeAxis];
export const MICROTS_RELATIVE_AXES = { primary: RelativeAxis.Primary, secondary: RelativeAxis.Secondary } as const;
export const MICROTS_UNIT_TYPES = { Px: { base: "f32" }, Ms: { base: "f32" }, Deg: { base: "f32" }, Color: { base: "u32" } } as const;
export type MicroTsUnitType = keyof typeof MICROTS_UNIT_TYPES;
export const MICROTS_INPUT_ELEMENTS = {
  ActionHandler: { attributes: ["button", "active", "latched"], events: ["press"] },
  AxisHandler: { attributes: ["axis", "active"], events: ["delta"] },
  MotionHandler: { attributes: ["value", "minQuality", "active"], events: ["update"] },
} as const;

/** CSS hexadecimal RGB(A) syntax converted to core's ABGR bits. */
export function parseMicroTsColor(value: string): number {
  if (!/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(value)) throw new Error(`Invalid Color ${JSON.stringify(value)}; expected #rgb, #rgba, #rrggbb, or #rrggbbaa`);
  let hex = value.slice(1);
  if (hex.length <= 4) hex = [...hex].map(c => c + c).join("");
  if (hex.length === 6) hex += "ff";
  const rgba = Number.parseInt(hex, 16);
  return (((rgba & 255) << 24) | (((rgba >>> 8) & 255) << 16) | (((rgba >>> 16) & 255) << 8) | ((rgba >>> 24) & 255)) >>> 0;
}

const pixelProps = new Set<string>(["width", "height", "minW", "minH", "maxW", "maxH", "paddingT", "paddingR", "paddingB", "paddingL", "marginT", "marginR", "marginB", "marginL", "gap", "basis", "insetT", "insetR", "insetB", "insetL", "radius", "borderWidth", "bevelWidth", "lineHeight", "tracking", "translateX", "translateY", "translateZ", "perspective", "arcWidth"]);
const degreeProps = new Set<string>(["rotate", "rotateX", "rotateY", "arcStart", "arcSweep"]);

export const MICROTS_ELEMENTS = {
  View: {
    nodeType: NODE_TYPE.view,
    attributes: ["class", "style", "focusable", "debug-name"],
    events: ["press"],
  },
  Text: { nodeType: NODE_TYPE.text, attributes: ["class"], events: [] },
  Image: { nodeType: NODE_TYPE.image, attributes: ["class", "src"], events: [] },
} as const;

export const MICROTS_STYLE_PROPS = Object.fromEntries(
  Object.entries(PROP).map(([name, id]) => {
    const kind = PROP_VALUE_KIND[name as keyof typeof PROP];
    const unit: MicroTsUnitType | undefined = kind === VALUE_KIND.color ? "Color" : pixelProps.has(name) ? "Px" : degreeProps.has(name) ? "Deg" : undefined;
    return [name, { id, type: kind === VALUE_KIND.f32 ? "f32" : kind === VALUE_KIND.color ? "u32" : "i32", ...(unit ? { unit } : {}) }];
  }),
) as { [P in keyof typeof PROP]: { id: (typeof PROP)[P]; type: "f32" | "i32" | "u32"; unit?: MicroTsUnitType } };

export const MICROTS_BUILTINS = {
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
export type MicroTsBuiltin = keyof typeof MICROTS_BUILTINS;

const generated = "// GENERATED — do not edit; run `bun contracts/spec/gen-rust.ts`.\n";

export function generateMicroTsNumericTypes(): string {
  return generated + MICROTS_NUMERIC_TYPES.map((name) =>
    `export type ${name} = number & { readonly __type?: ${JSON.stringify(name)} };`,
  ).join("\n") + "\n" + Object.entries(MICROTS_UNIT_TYPES).map(([name, unit]) =>
    `export type ${name} = ${name === "Color" ? '`#${string}`' : unit.base} & { readonly __newtype?: ${JSON.stringify(name)} };`,
  ).join("\n") + "\n";
}

export function generateMicroTsStdDeclarations(): string {
  const lines = [generated.trimEnd(), 'export type * from "./numeric-microts.ts";',
    'export type StyleClass = string & { readonly __style?: true };',
    'export type Cap<T extends string | readonly unknown[], N extends number> = T & { readonly __capacity?: N };',
    'export { copy, equals } from "./model-reactive.ts";',
    'export { capacity as __capacity } from "./model-reactive.ts";',
    'export { frames, after, until, join, all, any, cancel, type Join } from "./model-tasks.ts";',
    'export declare function map<T, U>(value: readonly T[], fn: (value: T, index: i32) => U): U[];',
    'export declare function filter<T>(value: readonly T[], fn: (value: T, index: i32) => boolean): T[];',
    'export declare function find<T>(value: readonly T[], fn: (value: T, index: i32) => boolean): T | undefined;',
    'export declare function some<T>(value: readonly T[], fn: (value: T, index: i32) => boolean): boolean;',
    'import type { i32, f32, f64, Color, u32 } from "./numeric-microts.ts";',
    'export type MicroTsPlainNumber = number & { readonly __type?: never; readonly __newtype?: never };',
    'export type MicroTsNumericResult<T extends number> = T extends MicroTsPlainNumber ? number : T;'];
  for (const [name, spec] of Object.entries(MICROTS_BUILTINS)) {
    if (name === "len") lines.push("export declare function len<T>(value: string | readonly T[]): i32;");
    else if (name === "fixed") lines.push("export declare function fixed(value: f32 | f64, digits: i32): string;");
    else if (spec.result === "i32") lines.push(`export declare function ${name}(value: f32 | f64): i32;`);
    else {
      const args = spec.parameters.map((_, index) => `${["value", "other", "upper"][index]}: ${index === 0 ? "T" : "NoInfer<T> | MicroTsPlainNumber"}`);
      lines.push(`export declare function ${name}<T extends number>(${args.join(", ")}): MicroTsNumericResult<T>;`);
    }
  }
  lines.push("export declare function __colorBits(value: Color): u32;", "export declare function __colorText(value: Color | undefined, missing?: string): string;");
  lines.push("export declare function __modelNumber(value: number, type: string): number;", "export declare function __modelMultiply(left: number, right: number): number;");
  return lines.join("\n") + "\n";
}

export function generateMicroTsComponentTypes(): string {
  const numericInputs = MICROTS_NUMERIC_TYPES.filter(name => name !== "f64");
  const lines = [generated.trimEnd(), `import type { ${[...numericInputs, ...Object.keys(MICROTS_UNIT_TYPES)].join(", ")} } from "./numeric-microts.ts";`,
    `export type MicroTsFloatInput = ${numericInputs.join(" | ")};`,
    `export type MicroTsIntegerInput = ${MICROTS_NUMERIC_TYPES.filter(name => !name.startsWith("f")).join(" | ")};`,
    "export type MicroTsValue<T> = T | (() => T);",
    "export interface MicroTsStyleProps {"];
  for (const [name, prop] of Object.entries(MICROTS_STYLE_PROPS)) lines.push(`  ${name}?: ${prop.unit ? prop.unit === "Color" ? "Color" : `${prop.unit} | MicroTsIntegerInput` : prop.type === "f32" ? "MicroTsFloatInput" : prop.type};`);
  lines.push("}");
  for (const [element, spec] of Object.entries(MICROTS_ELEMENTS)) {
    lines.push(`export interface MicroTs${element}${element === "View" ? "Base" : ""}Props {`);
    for (const attribute of spec.attributes) {
      if (attribute === "focusable") continue;
      const type = attribute === "style" ? "MicroTsStyleProps" : "string";
      lines.push(`  ${JSON.stringify(attribute)}?: MicroTsValue<${type}>;`);
    }
    lines.push("}");
    if (element === "View") lines.push('export type MicroTsViewProps = MicroTsViewBaseProps & ({ focusable: true; onPress?: () => void } | { focusable?: false; onPress?: never });');
  }
  lines.push('export interface MicroTsActionHandlerProps { button: number; active?: MicroTsValue<boolean>; latched?: boolean; onPress?: (pressed: number, buttons: number) => void }',
    'export interface MicroTsAxisHandlerProps { axis: "primary" | "secondary"; active?: MicroTsValue<boolean>; onDelta?: (delta: i32) => void }',
    `export type MicroTsMotionHandlerProps = { active?: MicroTsValue<boolean>; minQuality?: ${Object.keys(MOTION_MIN_QUALITIES).map(name => JSON.stringify(name)).join(" | ")} } & (${(Object.keys(MOTION_VALUES) as MotionValueName[]).map(name => `\n  | { value: ${JSON.stringify(name)}; onUpdate?: (${motionValueParameters(name).map(p => `${p.name}: ${p.type}`).join(", ")}) => void }`).join("")});`);
  return lines.join("\n") + "\n";
}

export function generateMicroTsRust(): string {
  const lines = [generated.trimEnd(), "pub use pocketjs_core::spec::{btn, prop, Display, NodeType};", "",
    `pub const NUMERIC_TYPES: &[&str] = &[${MICROTS_NUMERIC_TYPES.map((name) => JSON.stringify(name)).join(", ")}];`,
    `pub const BUILTINS: &[&str] = &[${Object.keys(MICROTS_BUILTINS).map((name) => JSON.stringify(name)).join(", ")}];`,
    "pub const HOST_ELEMENTS: &[(&str, u8)] = &["];
  for (const [name, spec] of Object.entries(MICROTS_ELEMENTS)) lines.push(`    (${JSON.stringify(name)}, ${spec.nodeType}),`);
  lines.push("];", "pub const STYLE_PROPS: &[(&str, u8, &str)] = &[");
  for (const [name, prop] of Object.entries(MICROTS_STYLE_PROPS)) lines.push(`    (${JSON.stringify(name)}, ${prop.id}, ${JSON.stringify(prop.type)}),`);
  lines.push("];", "pub const HOST_ATTRIBUTES: &[(&str, &[&str])] = &[");
  for (const [name, spec] of Object.entries(MICROTS_ELEMENTS)) lines.push(`    (${JSON.stringify(name)}, &[${spec.attributes.map((a) => JSON.stringify(a)).join(", ")}]),`);
  lines.push("];", "pub const HOST_EVENTS: &[(&str, &[&str])] = &[");
  for (const [name, spec] of Object.entries(MICROTS_ELEMENTS)) lines.push(`    (${JSON.stringify(name)}, &[${spec.events.map((a) => JSON.stringify(a)).join(", ")}]),`);
  lines.push("];", "pub const BUILTIN_SIGNATURES: &[(&str, &[&str], &str, &str)] = &[");
  for (const [name, spec] of Object.entries(MICROTS_BUILTINS)) lines.push(`    (${JSON.stringify(name)}, &[${spec.parameters.map((a) => JSON.stringify(a)).join(", ")}], ${JSON.stringify(spec.result)}, ${JSON.stringify(spec.numeric)}),`);
  lines.push("];");
  lines.push("pub mod relative_axis {");
  for (const [name, id] of Object.entries(MICROTS_RELATIVE_AXES)) lines.push(`    pub const ${name.toUpperCase()}: u8 = ${id};`);
  lines.push(`    pub const PER_DEGREE: i32 = ${RelativeAxisUnits.PerDegree};`, `    pub const PER_TURN: i32 = ${RelativeAxisUnits.PerTurn};`, "}", "pub mod motion {");
  const constant = (name: string) => name.replace(/[A-Z]/g, c => "_" + c).toUpperCase();
  for (const [name, spec] of Object.entries(MOTION_VALUES)) lines.push(`    pub const ${constant(name)}: u8 = ${spec.id};`);
  lines.push(`    pub const VALUES: usize = ${Object.keys(MOTION_VALUES).length};`, `    pub const VALUE_LEVELS: [u8; VALUES] = [${Object.values(MOTION_VALUES).map(spec => MOTION_LEVELS[spec.level]).join(", ")}];`);
  for (const [module, table] of [["level", MotionLevel], ["quality", MotionQuality], ["reference_frame", MotionReferenceFrame]] as const) {
    lines.push(`    pub mod ${module} {`);
    for (const [name, id] of Object.entries(table)) lines.push(`        pub const ${constant(name).replace(/^_/, "")}: u8 = ${id};`);
    lines.push("    }");
  }
  lines.push("}", "pub const UNIT_TYPES: &[(&str, &str)] = &[");
  for (const [name, unit] of Object.entries(MICROTS_UNIT_TYPES)) lines.push(`    (${JSON.stringify(name)}, ${JSON.stringify(unit.base)}),`);
  lines.push("];", "pub const STYLE_UNITS: &[(&str, &str)] = &[");
  for (const [name, prop] of Object.entries(MICROTS_STYLE_PROPS)) if (prop.unit) lines.push(`    (${JSON.stringify(name)}, ${JSON.stringify(prop.unit)}),`);
  lines.push("];", "pub const INPUT_ELEMENTS: &[(&str, &[&str], &[&str])] = &[");
  for (const [name, spec] of Object.entries(MICROTS_INPUT_ELEMENTS)) lines.push(`    (${JSON.stringify(name)}, &[${spec.attributes.map(a => JSON.stringify(a)).join(", ")}], &[${spec.events.map(e => JSON.stringify(e)).join(", ")}]),`);
  lines.push("];");
  return lines.join("\n") + "\n";
}
