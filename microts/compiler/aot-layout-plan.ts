/**
 * Build-time layout for `layout-baked` subtrees.
 *
 * A `layout-baked` node (`contain` = Baked) asserts that every rect in its
 * subtree is a build-time constant. This pass checks the assertion against the
 * View IR and the model's node writes, solves the subtree once in the no_std
 * wasm core (the same crate and float math the device runs, so the rects are
 * the device's bits), and hands codegen one entry per element:
 *
 * - `static`: the rect is a constant; `Ui::set_layout_static` assigns it and
 *   the node never enters a solver projection.
 * - `formula`: an absolutely positioned leaf whose width, height or inset
 *   changes at runtime (a binding, a transition, a timeline or a model
 *   `animate`/`jump`); `Ui::set_layout_formula` recomputes its rect from its
 *   own style without a solver pass.
 *
 * Anything else inside the subtree is a compile error that names the node and
 * the reason. `contain-strict` nodes inside a baked subtree are leaves here:
 * their box is a constant, their children stay live in their own region.
 */
import { AotCompileError, type AotComponent, type AotDiagnostic, type AotExpr, type AotNode, type AotProgram, type SourceLocation } from "./aot-ir.ts";
import type { ModelProgram } from "./aot-model-ir.ts";
import { ANIMATABLE, ENUMS, LAYOUT_DIRTYING, PROP, PROP_VALUE_KIND, VALUE_KIND, bitsF32, f32Bits, type PropName, type StyleProp, type StyleRecord } from "../../contracts/spec/spec.ts";
import { MICROTS_ELEMENTS } from "../../contracts/spec/microts.ts";

export interface LayoutEnvironment {
  /** Logical viewport the baked rects hold for (`app.viewport.fixed.logical`). */
  viewport: [number, number];
  /** Baked font atlases loaded before the solve (bake-font output). */
  fontAtlases: Uint8Array[];
  /** pocketjs.wasm: the no_std core that solves the static set. */
  wasm: ArrayBuffer | Uint8Array;
}

export type LayoutPlanEntry =
  | { mode: "static"; rect: [number, number, number, number] }
  | { mode: "formula" };

export interface LayoutPlan {
  /** Per expanded element node (object identity). */
  entries: WeakMap<object, LayoutPlanEntry>;
  report: LayoutReport;
}

export interface LayoutReport {
  /** One row per `layout-baked` root. */
  regions: { name: string; file: string; line: number; nodes: number; formulas: number; islands: number }[];
}

type ElementNode = Extract<AotNode, { kind: "element" }>;
type IfNode = Extract<AotNode, { kind: "if" }>;

const LAYOUT_PROPS = new Set<number>(LAYOUT_DIRTYING.map(name => PROP[name]));
const PROP_NAME = new Map<number, PropName>(Object.entries(PROP).map(([name, id]) => [id, name as PropName]));
/** Props a formula leaf may change at runtime. */
const FORMULA_PROPS = new Set<number>([PROP.width, PROP.height, PROP.insetT, PROP.insetR, PROP.insetB, PROP.insetL]);

function fail(loc: SourceLocation, message: string): never {
  const diagnostic: AotDiagnostic = { ...loc, severity: "error", message: `layout-baked: ${message}` };
  throw new AotCompileError([diagnostic]);
}

/** The last base value of `prop` in a record, as its raw u32. */
function baseValue(record: StyleRecord | undefined, prop: number): number | undefined {
  let value: number | undefined;
  for (const entry of record?.base ?? []) if (entry.prop === prop) value = entry.value;
  return value;
}

function layoutProps(entries: StyleProp[] | undefined): Map<number, number> {
  const out = new Map<number, number>();
  for (const entry of entries ?? []) if (LAYOUT_PROPS.has(entry.prop)) out.set(entry.prop, entry.value);
  return out;
}

function sameLayout(a: Map<number, number>, b: Map<number, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [prop, value] of a) if (b.get(prop) !== value) return false;
  return true;
}

/** A definite pixel length: finite and not negative (negative is the 100% sentinel). */
function definitePx(bits: number | undefined): boolean {
  if (bits === undefined) return false;
  const value = bitsF32(bits);
  return Number.isFinite(value) && value >= 0;
}

function finitePx(bits: number | undefined): boolean {
  return bits !== undefined && Number.isFinite(bitsF32(bits));
}

/** Fold a literal-only expression to its number, or null. */
function constantNumber(e: AotExpr): number | null {
  switch (e.kind) {
    case "literal": return typeof e.value === "number" ? e.value : typeof e.value === "boolean" ? Number(e.value) : null;
    case "cast": return constantNumber(e.value);
    case "unary": { const v = constantNumber(e.operand); return v === null ? null : e.operator === "-" ? -v : e.operator === "+" ? v : null; }
    case "binary": {
      const l = constantNumber(e.left), r = constantNumber(e.right);
      if (l === null || r === null) return null;
      switch (e.operator) { case "+": return l + r; case "-": return l - r; case "*": return l * r; case "/": return r === 0 ? null : l / r; default: return null; }
    }
    default: return null;
  }
}

/** Props the model writes through `animate`/`jump` on each named ref; "*" = a non-literal target or prop. */
function modelWrites(model: ModelProgram | undefined): Map<string, Set<number | "*">> {
  const out = new Map<string, Set<number | "*">>();
  const note = (ref: string, prop: number | "*") => { if (!out.has(ref)) out.set(ref, new Set()); out.get(ref)!.add(prop); };
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { for (const item of value) visit(item); return; }
    const record = value as Record<string, unknown>;
    const kind = record.kind;
    const args = record.args as { kind: string; value?: unknown }[] | undefined;
    if ((kind === "external" && (record.op === "animate" || record.op === "jump") || kind === "animate") && Array.isArray(args)) {
      const target = args[0], prop = args[1];
      if (target?.kind === "literal" && typeof target.value === "string") {
        const id = prop?.kind === "literal" && typeof prop.value === "string" ? PROP[prop.value as PropName] : undefined;
        note(target.value, id === undefined ? "*" : id);
      } else note("*", "*");
    }
    for (const key of Object.keys(record)) if (key !== "ledger" && key !== "loc") visit(record[key]);
  };
  visit(model?.modules);
  return out;
}

interface Analysis {
  /** Every element in solve order (DFS, parent before children). */
  elements: { node: ElementNode; parent: ElementNode | null; mode: "static" | "formula"; leaf: boolean; constantProps: [number, number][]; placeholderText: boolean }[];
  islands: number;
  formulas: number;
}

/** Check one `layout-baked` subtree and list its elements for the solve. */
function analyze(program: AotProgram, writes: Map<string, Set<number | "*">>, root: ElementNode): Analysis {
  const records = program.styles.records;
  const styleIds = program.styles.ids;
  const analysis: Analysis = { elements: [], islands: 0, formulas: 0 };
  const describe = (node: ElementNode) => node.debugName ? `${node.tag} "${node.debugName}"` : `<${node.tag}>`;

  const visitElement = (node: ElementNode, parent: ElementNode | null, conditional: boolean): void => {
    const record = records[node.style];
    const base = layoutProps(record?.base);
    const name = describe(node);
    for (const variant of ["focus", "active"] as const) {
      const changed = [...layoutProps(record?.[variant]).keys()].map(prop => PROP_NAME.get(prop));
      if (changed.length) fail(node.loc, `${name}: the ${variant}: variant changes layout props (${changed.join(", ")}); layout inside a baked subtree cannot depend on focus or press state`);
    }
    if (node.dynamicStyle) {
      const leaves: string[] = [];
      const collect = (e: AotExpr): void => {
        if (e.kind === "conditional") { collect(e.consequent); collect(e.alternate); return; }
        if (e.kind === "literal" && typeof e.value === "string") { leaves.push(e.value); return; }
        fail(node.loc, `${name}: a dynamic class must be a ternary of class literals inside a baked subtree`);
      };
      collect(node.dynamicStyle.expression);
      for (const leaf of leaves) {
        const id = styleIds[leaf];
        if (id === undefined) fail(node.loc, `${name}: class literal "${leaf}" has no style record`);
        if (!sameLayout(base, layoutProps(records[id]?.base))) fail(node.loc, `${name}: class alternative "${leaf}" changes layout props; only paint props may differ inside a baked subtree`);
      }
    }
    // Runtime layout inputs on this node: a formula leaf may carry them.
    const frameProps = new Set<number>();
    const constantProps: [number, number][] = [];
    for (const binding of node.props) {
      if (!LAYOUT_PROPS.has(binding.prop)) continue;
      const value = constantNumber(binding.value);
      if (value !== null) constantProps.push([binding.prop, value]);
      else frameProps.add(binding.prop);
    }
    if (record?.transition) {
      const mask = record.transition.mask;
      ANIMATABLE.forEach((prop, bit) => { if (mask & (1 << bit) && LAYOUT_PROPS.has(PROP[prop])) frameProps.add(PROP[prop]); });
    }
    for (const anim of record?.animation?.anims ?? []) {
      for (const track of program.styles.anims[anim]?.tracks ?? []) if (LAYOUT_PROPS.has(track.prop)) frameProps.add(track.prop);
    }
    if (node.ref) {
      for (const prop of writes.get(node.ref) ?? []) {
        if (prop === "*") fail(node.loc, `${name}: the model animates ref "${node.ref}" with a non-constant property; a baked subtree needs constant animate/jump targets`);
        if (LAYOUT_PROPS.has(prop)) frameProps.add(prop);
      }
    }
    if (writes.has("*")) fail(node.loc, `${name}: the model animates a non-constant ref; a baked subtree needs constant animate/jump targets`);
    // Effective base after constant style props (they are written at first update).
    const effective = new Map(base);
    for (const [prop, value] of constantProps) effective.set(prop, PROP_VALUE_KIND[PROP_NAME.get(prop)!] === VALUE_KIND.f32 ? f32Bits(value) : value >>> 0);
    const contain = effective.get(PROP.contain) ?? ENUMS.Contain.None;
    const absolute = effective.get(PROP.posType) === ENUMS.PosType.Absolute;
    const width = effective.get(PROP.width), height = effective.get(PROP.height);
    let placeholderText = false;
    if (node.text && node.text.parts.some(part => typeof part !== "string")) {
      if (!definitePx(width) || !definitePx(height)) fail(node.loc, `${name}: dynamic text inside a baked subtree needs a fixed cell (w-[n] h-[n] on the Text) so the run never sizes the box`);
      placeholderText = true;
    }
    let mode: "static" | "formula" = "static";
    if (frameProps.size) {
      const list = [...frameProps].map(prop => PROP_NAME.get(prop)).join(", ");
      if (!absolute) fail(node.loc, `${name}: ${list} changes at runtime; only an absolutely positioned leaf (absolute left-[n] top-[n]) may change its size or inset inside a baked subtree`);
      for (const prop of frameProps) if (!FORMULA_PROPS.has(prop)) fail(node.loc, `${name}: ${PROP_NAME.get(prop)} changes at runtime; a formula leaf may only change width, height and inset`);
      if (node.children.length || node.tag === "Text") fail(node.loc, `${name}: a node whose size changes at runtime must be a childless View or Image inside a baked subtree`);
      for (const prop of [PROP.minW, PROP.minH, PROP.maxW, PROP.maxH, PROP.marginT, PROP.marginR, PROP.marginB, PROP.marginL]) {
        if (effective.has(prop)) fail(node.loc, `${name}: ${PROP_NAME.get(prop)} is set; a formula leaf has no min/max size or margin`);
      }
      const h = finitePx(effective.get(PROP.insetL)) || finitePx(effective.get(PROP.insetR));
      const v = finitePx(effective.get(PROP.insetT)) || finitePx(effective.get(PROP.insetB));
      if (!h || !v || contain !== ENUMS.Contain.None) fail(node.loc, `${name}: a formula leaf needs a constant left or right inset and a constant top or bottom inset`);
      mode = "formula";
      analysis.formulas++;
    }
    if (conditional && !absolute) fail(node.loc, `${name}: a Show branch inside a baked subtree must be absolutely positioned with a constant inset and size, so its presence moves nothing else`);
    if (conditional && (!definitePx(width) || !definitePx(height))) fail(node.loc, `${name}: a Show branch inside a baked subtree needs a constant width and height`);
    const island = contain === ENUMS.Contain.Strict;
    if (island) {
      if (!definitePx(width) || !definitePx(height)) fail(node.loc, `${name}: contain-strict inside a baked subtree needs a constant width and height`);
      analysis.islands++;
    }
    analysis.elements.push({ node, parent, mode, leaf: island, constantProps, placeholderText });
    if (island) return; // its children stay live in their own region
    for (const child of node.children) visitChild(child, node, false);
  };
  const visitChild = (child: AotNode, parent: ElementNode | null, conditional: boolean): void => {
    switch (child.kind) {
      case "element": visitElement(child, parent, conditional); return;
      case "if": for (const branch of (child as IfNode).branches) for (const grand of branch.children) visitChild(grand, parent, true); return;
      case "input": for (const grand of child.children) visitChild(grand, parent, conditional); return;
      case "for": fail(child.loc, `a <For> list cannot sit inside a baked subtree; wrap it in a contain-strict View`);
      case "component": fail(child.loc, `component ${child.component} is a runtime instance; wrap it in a contain-strict View or give it a static body`);
      case "slot": fail(child.loc, `a slot cannot sit inside a baked subtree`);
    }
  };
  visitElement(root, null, false);
  return analysis;
}

/** The no_std core, instantiated synchronously for one solve. */
class BakeCore {
  private readonly ex: Record<string, (...args: number[]) => number> & { memory: WebAssembly.Memory };
  constructor(wasm: ArrayBuffer | Uint8Array, viewport: [number, number], styles: Uint8Array, atlases: Uint8Array[]) {
    const module = new WebAssembly.Module((wasm instanceof Uint8Array ? wasm : new Uint8Array(wasm)) as BufferSource);
    this.ex = new WebAssembly.Instance(module, {}).exports as BakeCore["ex"];
    if (!this.ex.ui_node_layout) throw new Error("layout-baked: this pocketjs.wasm predates ui_node_layout; rebuild it with bun tools/wasm.ts");
    this.ex.ui_init(1);
    this.ex.ui_set_viewport(viewport[0], viewport[1]);
    if (!this.withBytes(styles, (ptr, len) => this.ex.ui_load_styles(ptr, len))) throw new Error("layout-baked: the core rejected styles.bin");
    for (const atlas of atlases) if (!this.withBytes(atlas, (ptr, len) => this.ex.ui_load_font_atlas(ptr, len))) throw new Error("layout-baked: the core rejected a font atlas");
  }
  private withBytes(bytes: Uint8Array, call: (ptr: number, len: number) => number): number {
    const ptr = this.ex.ui_alloc(bytes.length);
    new Uint8Array(this.ex.memory.buffer, ptr, bytes.length).set(bytes);
    const result = call(ptr, bytes.length);
    this.ex.ui_free(ptr, bytes.length);
    return result;
  }
  createNode(type: number): number { return this.ex.ui_create_node(type); }
  insert(parent: number, child: number): void { this.ex.ui_insert_before(parent, child, 0); }
  setStyle(id: number, style: number): void { this.ex.ui_set_style(id, style); }
  setProp(id: number, prop: number, value: number): void { this.ex.ui_set_prop(id, prop, value); }
  setText(id: number, text: string): void { this.withBytes(new TextEncoder().encode(text), (ptr, len) => { this.ex.ui_set_text(id, ptr, len); return 0; }); }
  solve(): void { this.ex.ui_tick(); }
  /** Rounded (x, y, w, h) then unrounded (x, y, w, h). */
  layout(id: number): [number, number, number, number, number, number, number, number] {
    const ptr = this.ex.ui_alloc(32);
    if (!this.ex.ui_node_layout(id, ptr)) throw new Error(`layout-baked: node ${id} vanished during the solve`);
    const values = Array.from(new Float32Array(this.ex.memory.buffer, ptr, 8)) as [number, number, number, number, number, number, number, number];
    this.ex.ui_free(ptr, 32);
    return values;
  }
}

const ROOT_ID = 1;

/**
 * Plan every `layout-baked` subtree of the root component's expanded tree.
 * Returns an empty plan when the app has none; throws when one is used
 * without an environment or breaks the rules.
 */
export function planLayout(program: AotProgram, component: AotComponent, expanded: AotNode[], environment: LayoutEnvironment | undefined): LayoutPlan {
  const plan: LayoutPlan = { entries: new WeakMap(), report: { regions: [] } };
  const roots: { node: ElementNode; top: boolean }[] = [];
  const records = program.styles.records;
  const containOf = (node: ElementNode) => baseValue(records[node.style], PROP.contain) ?? ENUMS.Contain.None;
  const find = (nodes: AotNode[], top: boolean, bakedAbove: boolean): void => {
    for (const node of nodes) {
      if (node.kind === "element") {
        const contain = containOf(node);
        if (contain === ENUMS.Contain.Baked && !bakedAbove) {
          if (!top) fail(node.loc, `${node.debugName ?? node.tag} sits under a live parent; layout-baked needs the root position or a layout-baked parent, because its own rect would not be a constant`);
          roots.push({ node, top });
        }
        // Children of a contain-strict island are live again; a baked root
        // inside one would sit under a live parent.
        const childrenBaked = (bakedAbove || contain === ENUMS.Contain.Baked) && !(bakedAbove && contain === ENUMS.Contain.Strict);
        find(node.children, false, childrenBaked);
      } else if (node.kind === "if") for (const branch of node.branches) find(branch.children, false, bakedAbove);
      else if (node.kind === "for" || node.kind === "input") find(node.children, false, bakedAbove);
      else if (node.kind === "slot") find(node.fallback, false, bakedAbove);
    }
  };
  find(expanded, true, false);
  if (!roots.length) return plan;
  if (!environment) fail(roots[0]!.node.loc, "the build has no layout environment (viewport, font atlases and pocketjs.wasm); pass buildAot({ layoutEnvironment })");
  const writes = modelWrites(program.model);
  const core = new BakeCore(environment.wasm, environment.viewport, Uint8Array.from(program.styles.bytes), environment.fontAtlases);
  for (const { node: root } of roots) {
    const analysis = analyze(program, writes, root);
    // Mount the subtree as the generated code would: styles, constant props,
    // text. Formula leaves and contain-strict islands are leaves either way.
    const ids = new Map<ElementNode, number>();
    for (const element of analysis.elements) {
      const id = core.createNode(MICROTS_ELEMENTS[element.node.tag].nodeType);
      core.insert(element.parent ? ids.get(element.parent)! : ROOT_ID, id);
      core.setStyle(id, element.node.style);
      for (const [prop, value] of element.constantProps) core.setProp(id, prop, value);
      if (element.node.text) {
        const parts = element.node.text.parts;
        core.setText(id, element.placeholderText ? "0" : parts.join(""));
      }
      ids.set(element.node, id);
    }
    core.solve();
    const origins = new Map<ElementNode, [number, number]>();
    for (const element of analysis.elements) {
      const [x, y, w, h, ux, uy] = core.layout(ids.get(element.node)!);
      const parentOrigin = element.parent ? origins.get(element.parent)! : [0, 0];
      const origin: [number, number] = [parentOrigin[0] + ux, parentOrigin[1] + uy];
      origins.set(element.node, origin);
      if (element.mode === "formula") {
        if (!Number.isInteger(parentOrigin[0]) || !Number.isInteger(parentOrigin[1])) {
          fail(element.node.loc, `${element.node.debugName ?? element.node.tag}: its parent sits at a fractional position (${parentOrigin[0]}, ${parentOrigin[1]}); a formula leaf rounds against an integer parent origin`);
        }
        plan.entries.set(element.node, { mode: "formula" });
      } else plan.entries.set(element.node, { mode: "static", rect: [x, y, w, h] });
    }
    plan.report.regions.push({ name: root.debugName ?? root.tag, file: root.loc.file, line: root.loc.line, nodes: analysis.elements.length, formulas: analysis.formulas, islands: analysis.islands });
  }
  return plan;
}
