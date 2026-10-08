/**
 * Dynamic paint inside a `layout-baked` subtree, for hosts that present a
 * baked page as a static background plus hardware sprites (hosts/gba).
 *
 * The layout plan proves every rect; this pass lists what still changes on
 * screen at runtime and describes it as one recipe per **layer**: the nearest
 * element with a `debugName` above the change. A baker enumerates each
 * recipe's states against the running app, a packer turns the captures into
 * tiles, and the presenter reads the same state back from the core each frame.
 * Dynamics this pass cannot bound are compile errors that name the node.
 */
import { AotCompileError, type AotDiagnostic, type AotExpr, type AotNode, type AotProgram, type AotType, type SourceLocation } from "./aot-ir.ts";
import type { ModelProgram } from "./aot-model-ir.ts";
import { ANIMATABLE, LAYOUT_DIRTYING, PROP, bitsF32, type PropName, type StyleRecord } from "../../contracts/spec/spec.ts";
import { MICROTS_ELEMENTS } from "../../contracts/spec/microts.ts";
import { DEFAULT_FONT_SLOT } from "../../framework/compiler/tailwind.ts";

type ElementNode = Extract<AotNode, { kind: "element" }>;
export type Rect = [number, number, number, number];

/** Optional per-layer declarations (`apps/<app>/gba-layers.json`), keyed by layer name. */
export interface LayerDeclarations {
  /** Integer px range of a layer's size prop when the model's animate targets are not literals. */
  ranges?: Record<string, [number, number]>;
  /** Glyphs a string-typed text layer may show. */
  glyphs?: Record<string, string>;
  /** Longest dynamic tail of a string-typed text layer. */
  maxLength?: Record<string, number>;
}

/** One element the baker mounts to show a `<Show>` branch; `parent` indexes this list, -1 = the layer root. */
export interface BranchNode {
  parent: number;
  tag: "View" | "Text" | "Image";
  nodeType: number;
  style: number;
  text?: string;
  src?: string;
  /** Static rect relative to its parent; null inside a live island. */
  rect: Rect | null;
}

export type LayerRecipe =
  | { kind: "branches"; branches: { signature: { style: number; src?: string; text?: string }; nodes: BranchNode[] }[] }
  | { kind: "opacity" }
  | { kind: "size"; node: number[]; prop: "width" | "height"; range: [number, number] }
  | { kind: "color"; node: number[]; endpoints: number[]; steps: number }
  | { kind: "text"; node: number[]; prefix: string; glyphs: string; maxLength: number; fontSlot: number };

export interface DynamicLayer {
  /** `debugName` of the layer root. */
  name: string;
  /** Root rect, absolute within the baked root's coordinate space. */
  rect: Rect;
  /** The root is `contain-strict`: its children are live and need no baked rects. */
  island: boolean;
  /** translateX / translateY bindings on the root: a runtime position offset. */
  translate: boolean;
  recipe: LayerRecipe;
}

export interface PaintPlanInput {
  program: AotProgram;
  root: ElementNode;
  /** Static rect of each planned element (layout plan entries). */
  rectOf: (node: ElementNode) => Rect | null;
  islandOf: (node: ElementNode) => boolean;
  tickRate: number;
  declarations: LayerDeclarations;
}

function fail(loc: SourceLocation, message: string): never {
  const diagnostic: AotDiagnostic = { ...loc, severity: "error", message: `gba layers: ${message}` };
  throw new AotCompileError([diagnostic]);
}

const LAYOUT_PROPS = new Set<number>(LAYOUT_DIRTYING.map(name => PROP[name]));
const PROP_NAME = new Map<number, PropName>(Object.entries(PROP).map(([name, id]) => [id, name as PropName]));

function baseValue(record: StyleRecord | undefined, prop: number): number | undefined {
  let value: number | undefined;
  for (const entry of record?.base ?? []) if (entry.prop === prop) value = entry.value;
  return value;
}

function variantValue(record: StyleRecord | undefined, variant: "focus" | "active", prop: number): number | undefined {
  let value: number | undefined;
  for (const entry of record?.[variant] ?? []) if (entry.prop === prop) value = entry.value;
  return value;
}

function isConstant(e: AotExpr): boolean {
  switch (e.kind) {
    case "literal": return true;
    case "cast": case "unary": return isConstant(e.kind === "cast" ? e.value : e.operand);
    case "binary": return isConstant(e.left) && isConstant(e.right);
    default: return false;
  }
}

/** Literal `animate`/`jump` targets per ref and prop; "unknown" when any target is not a literal. */
function animateTargets(model: ModelProgram | undefined): { refs: Map<string, Map<number, number[] | "unknown">>; wildcard: boolean } {
  const refs = new Map<string, Map<number, number[] | "unknown">>();
  let wildcard = false;
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { for (const item of value) visit(item); return; }
    const record = value as Record<string, unknown>;
    const args = record.args as { kind: string; value?: unknown }[] | undefined;
    if ((record.kind === "external" && (record.op === "animate" || record.op === "jump") || record.kind === "animate") && Array.isArray(args)) {
      const [target, prop, to] = args;
      if (target?.kind === "literal" && typeof target.value === "string" && prop?.kind === "literal" && typeof prop.value === "string") {
        const id = PROP[prop.value as PropName];
        if (id !== undefined) {
          if (!refs.has(target.value)) refs.set(target.value, new Map());
          const props = refs.get(target.value)!;
          const known = props.get(id);
          if (to?.kind === "literal" && typeof to.value === "number" && known !== "unknown") props.set(id, [...(known ?? []), to.value]);
          else props.set(id, "unknown");
        }
      } else wildcard = true;
    }
    for (const key of Object.keys(record)) if (key !== "ledger" && key !== "loc") visit(record[key]);
  };
  visit(model?.modules);
  return { refs, wildcard };
}

function glyphsForType(type: AotType): string | null {
  const scalar = type.kind === "option" ? type.value : type;
  if (scalar.kind === "number") return scalar.name.startsWith("f") ? "0123456789-." : "0123456789-";
  return null;
}

function lengthForType(type: AotType): number | null {
  const scalar = type.kind === "option" ? type.value : type;
  if (scalar.kind !== "number") return null;
  if (scalar.name.startsWith("f")) return 24;
  const bits = Number(scalar.name.replace(/^[iu]/, "")) || 32;
  return (scalar.name.startsWith("i") ? 1 : 0) + Math.ceil(bits * Math.log10(2)) + (scalar.name === "usize" ? 10 : 0);
}

/** Describe every dynamic layer under one baked root. */
export function planPaint(input: PaintPlanInput): DynamicLayer[] {
  const { program, root, rectOf, islandOf, tickRate, declarations } = input;
  const records = program.styles.records;
  const targets = animateTargets(program.model);
  const layers: DynamicLayer[] = [];
  const describe = (node: ElementNode) => node.debugName ? `${node.tag} "${node.debugName}"` : `<${node.tag}>`;

  interface Found { kind: "branches" | "opacity" | "size" | "color" | "text" | "translate"; node: ElementNode; path: number[]; detail?: unknown }
  /** A named element: the layer every dynamic below it (down to the next named element) belongs to. */
  interface Named { node: ElementNode; absolute: [number, number]; found: Found[]; parent: Named | null }
  const named: Named[] = [];

  const visit = (node: ElementNode, nearest: Named | null, path: number[], absolute: [number, number]): void => {
    const record = records[node.style];
    let here = nearest;
    if (node.debugName) {
      here = { node, absolute, found: [], parent: nearest };
      named.push(here);
      path = [];
    }
    const own: Found[] = [];
    if (node.dynamicStyle) fail(node.loc, `${describe(node)}: a dynamic class is not a sprite layer recipe; use a <Show> branch per alternative`);
    for (const binding of node.props) {
      if (isConstant(binding.value)) continue;
      if (binding.prop === PROP.translateX || binding.prop === PROP.translateY) own.push({ kind: "translate", node, path });
      else if (binding.prop === PROP.opacity) own.push({ kind: "opacity", node, path });
      else if (binding.prop === PROP.width || binding.prop === PROP.height) own.push({ kind: "size", node, path, detail: PROP_NAME.get(binding.prop) });
      else fail(node.loc, `${describe(node)}: a runtime binding on ${PROP_NAME.get(binding.prop)} has no sprite layer recipe (supported: opacity 0/1, width/height of a formula leaf, translateX/Y)`);
    }
    // A transition paints only when a variant changes the prop; a keyframe
    // timeline paints on its own.
    const variantProps = new Set<number>();
    for (const variant of ["focus", "active"] as const) for (const entry of record?.[variant] ?? []) {
      if (entry.value !== baseValue(record, entry.prop)) variantProps.add(entry.prop);
    }
    for (const prop of variantProps) if (prop !== PROP.bgColor && !LAYOUT_PROPS.has(prop)) fail(node.loc, `${describe(node)}: the focus/active variant changes ${PROP_NAME.get(prop)}; only bgColor variants have a sprite layer recipe`);
    if (variantProps.has(PROP.bgColor)) {
      const durMs = record?.transition && record.transition.mask & (1 << ANIMATABLE.indexOf("bgColor")) ? record.transition.durMs : 0;
      own.push({ kind: "color", node, path, detail: { durMs } });
    }
    for (const anim of record?.animation?.anims ?? []) for (const track of program.styles.anims[anim]?.tracks ?? []) {
      if (!LAYOUT_PROPS.has(track.prop)) fail(node.loc, `${describe(node)}: ${PROP_NAME.get(track.prop)} animates by keyframe timeline; no sprite layer recipe covers it`);
    }
    if (node.ref) {
      if (targets.wildcard) fail(node.loc, `${describe(node)}: the model animates a non-constant ref`);
      for (const [prop] of targets.refs.get(node.ref) ?? []) {
        if (prop === PROP.width || prop === PROP.height) own.push({ kind: "size", node, path, detail: PROP_NAME.get(prop) });
        else if (prop === PROP.opacity) own.push({ kind: "opacity", node, path });
        else fail(node.loc, `${describe(node)}: the model animates ${PROP_NAME.get(prop)} on ref "${node.ref}"; only width, height and opacity have sprite layer recipes`);
      }
    }
    if (node.text && node.text.parts.some(part => typeof part !== "string")) own.push({ kind: "text", node, path });
    if (own.length) {
      if (!here) fail(node.loc, `${describe(node)}: dynamic paint needs a debugName on this node or an ancestor to become a sprite layer`);
      here.found.push(...own);
    }
    let index = 0;
    let conditionalBefore = false;
    for (const child of node.children) {
      if (child.kind === "if") {
        if (!here) fail(child.loc, `a <Show> needs a debugName on an ancestor to become a sprite layer`);
        if (here.node !== node) fail(child.loc, `a <Show> must be a direct child of its sprite layer root ("${here.node.debugName}")`);
        const branches = child.branches.map(branch => {
          const nodes: BranchNode[] = [];
          const flatten = (element: AotNode, parent: number): void => {
            if (element.kind !== "element") fail(element.loc, `a <Show> branch inside a sprite layer holds plain elements`);
            const rect = islandOf(node) ? null : rectOf(element);
            nodes.push({ parent, tag: element.tag, nodeType: MICROTS_ELEMENTS[element.tag].nodeType, style: element.style, rect,
              ...(element.text ? { text: element.text.parts.map(part => typeof part === "string" ? part : fail(element.loc, `${describe(element)}: dynamic text inside a <Show> branch has no recipe`)).join("") } : {}),
              ...(element.src ? { src: element.src } : {}) });
            const self = nodes.length - 1;
            for (const grand of element.children) flatten(grand, self);
          };
          for (const element of branch.children) flatten(element, -1);
          const first = nodes[0];
          if (!first) fail(child.loc, `an empty <Show> branch has nothing to bake`);
          return { signature: { style: first.style, ...(first.src ? { src: first.src } : {}), ...(first.text !== undefined ? { text: first.text } : {}) }, nodes };
        });
        here.found.push({ kind: "branches", node, path: [], detail: branches });
        conditionalBefore = true;
        continue;
      }
      if (child.kind !== "element") { if (child.kind === "input") continue; fail(child.loc, `${child.kind} has no sprite layer recipe`); }
      const childRect = rectOf(child);
      const childAbsolute: [number, number] = childRect ? [absolute[0] + childRect[0], absolute[1] + childRect[1]] : absolute;
      if (conditionalBefore) {
        // A static sibling after a <Show> shifts index at runtime.
        const dynamicBelow = (e: AotNode): boolean => e.kind === "element" && (e.props.some(p => !isConstant(p.value)) || !!e.text?.parts.some(p => typeof p !== "string") || e.children.some(dynamicBelow)) || e.kind === "if";
        if (dynamicBelow(child)) fail(child.loc, `${describe(child)}: a dynamic node after a <Show> sibling cannot be located at runtime; move the <Show> last`);
      }
      visit(child, here, [...path, index], childAbsolute);
      index++;
    }
  };
  visit(root, null, [], [rectOf(root)![0], rectOf(root)![1]]);

  for (const entry of named) {
    if (!entry.found.length) continue;
    for (let ancestor = entry.parent; ancestor; ancestor = ancestor.parent) {
      if (ancestor.found.length) fail(entry.node.loc, `${describe(entry.node)}: a sprite layer cannot sit inside layer "${ancestor.node.debugName}"`);
    }
    const rect = rectOf(entry.node);
    if (!rect) fail(entry.node.loc, `${describe(entry.node)}: a sprite layer root needs a static rect`);
    layers.push({ name: entry.node.debugName!, rect: [entry.absolute[0], entry.absolute[1], rect[2], rect[3]], island: islandOf(entry.node), translate: false, recipe: undefined as unknown as LayerRecipe });
    (layers[layers.length - 1] as unknown as { found: Found[]; root: ElementNode }).found = entry.found;
    (layers[layers.length - 1] as unknown as { found: Found[]; root: ElementNode }).root = entry.node;
  }

  for (const layer of layers) {
    const { found, root: layerRoot } = layer as unknown as { found: Found[]; root: ElementNode };
    const translate = found.some(item => item.kind === "translate");
    if (translate && found.filter(item => item.kind === "translate").some(item => item.node !== layerRoot)) fail(layerRoot.loc, `${layer.name}: translateX/Y must bind on the layer root`);
    // Every <Show> under the root is one state list: at most one branch is
    // mounted at a time (the presenter reports a fault otherwise).
    type Branches = Extract<LayerRecipe, { kind: "branches" }>["branches"];
    const branches = found.filter(item => item.kind === "branches").flatMap(item => item.detail as Branches);
    const main = found.filter(item => item.kind !== "translate" && item.kind !== "branches");
    if (branches.length) main.push({ kind: "branches", node: layerRoot, path: [], detail: branches });
    if (!main.length) fail(layerRoot.loc, `${layer.name}: only translate changes; a layer needs a state recipe or no dynamics`);
    if (main.length > 1) fail(layerRoot.loc, `${layer.name}: ${main.map(item => item.kind).join(" + ")} on one layer; a sprite layer has one state recipe`);
    const item = main[0]!;
    let recipe: LayerRecipe;
    switch (item.kind) {
      case "branches": recipe = { kind: "branches", branches: item.detail as Branches }; break;
      case "opacity": {
        if (item.node !== layerRoot) fail(item.node.loc, `${layer.name}: an opacity binding must sit on the layer root`);
        recipe = { kind: "opacity" };
        break;
      }
      case "size": {
        const prop = item.detail as "width" | "height";
        const record = records[item.node.style];
        const initial = baseValue(record, PROP[prop]);
        const literal = item.node.ref ? targets.refs.get(item.node.ref)?.get(PROP[prop]) : undefined;
        let range: [number, number] | undefined = declarations.ranges?.[layer.name];
        if (!range) {
          if (literal === "unknown" || !literal?.length) fail(item.node.loc, `${layer.name}: the ${prop} range is not a literal animate target; declare it in gba-layers.json ranges`);
          const values = [...literal, ...(initial !== undefined && Number.isFinite(bitsF32(initial)) && bitsF32(initial) >= 0 ? [bitsF32(initial)] : [])];
          range = [Math.floor(Math.min(...values)), Math.ceil(Math.max(...values))];
        }
        if (!Number.isInteger(range[0]) || !Number.isInteger(range[1]) || range[1] < range[0]) fail(item.node.loc, `${layer.name}: ${prop} range must be two ordered integers`);
        recipe = { kind: "size", node: item.path, prop, range };
        break;
      }
      case "color": {
        const record = records[item.node.style];
        const endpoints = [...new Set([baseValue(record, PROP.bgColor), variantValue(record, "focus", PROP.bgColor), variantValue(record, "active", PROP.bgColor)].filter((v): v is number => v !== undefined))];
        const durMs = (item.detail as { durMs: number }).durMs;
        // One sample per tick the transition can show, plus both endpoints.
        const steps = durMs > 0 ? Math.ceil(durMs * tickRate / 1000) + 1 : 2;
        recipe = { kind: "color", node: item.path, endpoints, steps };
        break;
      }
      case "text": {
        const parts = item.node.text!.parts;
        let prefix = "";
        let i = 0;
        for (; i < parts.length && typeof parts[i] === "string"; i++) prefix += parts[i] as string;
        let glyphs = declarations.glyphs?.[layer.name] ?? "";
        let maxLength = declarations.maxLength?.[layer.name] ?? 0;
        for (const part of parts.slice(i)) {
          if (typeof part === "string") { glyphs += part; maxLength += part.length; continue; }
          const set = glyphsForType(part.type), length = lengthForType(part.type);
          if (set === null || length === null) {
            if (!declarations.glyphs?.[layer.name] || !declarations.maxLength?.[layer.name]) fail(item.node.loc, `${layer.name}: string text needs gba-layers.json glyphs and maxLength`);
            continue;
          }
          glyphs += set;
          maxLength += length;
        }
        const fontSlot = baseValue(records[item.node.style], PROP.fontSlot) ?? DEFAULT_FONT_SLOT;
        recipe = { kind: "text", node: item.path, prefix, glyphs: [...new Set([...glyphs])].join(""), maxLength, fontSlot };
        break;
      }
      default: fail(layerRoot.loc, `${layer.name}: unreachable`);
    }
    layer.translate = translate;
    layer.recipe = recipe;
    delete (layer as unknown as { found?: unknown }).found;
    delete (layer as unknown as { root?: unknown }).root;
  }
  return layers;
}
