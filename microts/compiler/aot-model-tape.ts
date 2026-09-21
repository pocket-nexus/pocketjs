/** Button/axis tape adapter over the same mounted View IR used by native blocks. */
import { BTN } from "../../contracts/spec/spec.ts";
import type { AotComponent, AotExpr, AotHandler, AotNode, AotProgram } from "./aot-ir.ts";
import { checkAotVersion } from "./aot-ir.ts";
import type { ModelModule } from "./aot-model-ir.ts";
import { ModelInterpreter, type ModelFrame, type ModelFrameInput, type ModelInterpreterOptions } from "./model-interp.ts";

export interface ModelTapeFrame extends ModelFrameInput {
  axis?: number;
  axes?: readonly number[] | { primary?: number; secondary?: number };
  axis_deltas?: readonly number[];
  /** A host-resolved press target: a mounted node number or unique debugName. */
  target?: number | string;
}
export interface ModelTape { hz?: number; frames: ModelTapeFrame[] }
type Values = Record<string, any>;
interface Context {
  component: AotComponent; region: number; props: Values; locals: Values; events: Values;
  instance: Instance;
}
type ContextSource = () => Context | undefined;
interface SuppliedSlot { definition: Extract<AotNode, { kind: "component" }>["slots"][number]; parent: ContextSource }
interface Instance {
  component: AotComponent; region: number; owned: boolean; context: ContextSource;
  last?: Context; slots: Map<string, SuppliedSlot>;
  events: Map<string, (args: any[]) => void>;
  injections: Map<string, () => any>;
}
interface Mounted {
  node: AotNode; context: ContextSource; children: Mounted[]; uid: number;
  previous?: number; branch?: number; instance?: Instance;
  rows?: { key: any; children: Mounted[] }[];
}
const clone = <T>(value: T): T => value === undefined ? value : structuredClone(value);

export class ModelTapeInterpreter {
  readonly model: ModelInterpreter;
  private components: Map<string, AotComponent>;
  private instances = new Map<number, Instance>();
  private destroyed: Instance[] = [];
  private tree: Mounted[] = [];
  private nextNode = 0;
  private previousButtons = 0;
  private rendering = false;
  private active = true;

  constructor(readonly program: AotProgram, options: Omit<ModelInterpreterOptions, "dispatch" | "update" | "mount" | "cleanup" | "deferInitial"> = {}) {
    checkAotVersion(program);
    if (!program.model) throw new Error("Model tape replay requires app.model = compiled");
    this.components = new Map(program.components.map(component => [component.name, component]));
    this.model = new ModelInterpreter(program.model, {
      ...options, deferInitial: true,
      dispatch: (_model, input) => this.dispatch(input as ModelTapeFrame),
      update: () => this.update(),
      mount: (_model, region) => {
        const instance = this.instances.get(region);
        if (instance?.component.hooks?.mount) this.handler(instance.component.hooks.mount, instance.context() ?? instance.last!);
      },
      cleanup: () => this.cleanup(),
    });
    const component = this.components.get(program.root);
    if (!component) throw new Error(`Unknown root view ${program.root}`);
    const instance: Instance = { component, region: 1, owned: true, context: () => undefined, slots: new Map(), events: new Map(), injections: new Map() };
    instance.context = () => ({ component, region: 1, props: {}, locals: {}, events: {}, instance });
    this.instances.set(1, instance);
    this.rendering = true;
    this.tree = this.mountNodes(component.nodes, instance.context);
    this.update();
    this.rendering = false;
    this.model.initialize();
  }

  frame(input: ModelTapeFrame = {}): ModelFrame {
    if (!this.active) throw new Error("Cannot replay a disposed model view");
    return this.model.frame(input);
  }
  dispose(): void {
    if (!this.active) return;
    this.tree.forEach(node => this.disposeNode(node)); this.tree = [];
    const root = this.instances.get(1); if (root) this.destroyed.push(root);
    this.cleanup(); this.active = false;
  }
  private module(context: Context): ModelModule {
    const module = this.program.model!.modules.find(module => module.name === context.component.name || context.component.factory && module.factory === context.component.factory.sourceName);
    if (!module) {
      const owner = this.instances.get(context.region);
      if (owner && owner.component !== context.component) return this.module(owner.context() ?? owner.last!);
      throw new Error(`View ${context.component.name} has no compiled model region`);
    }
    return module;
  }
  private expression(expression: AotExpr, context: Context, handler = false): any {
    const evaluate = (expression: AotExpr) => this.expression(expression, context);
    switch (expression.kind) {
      case "literal": return expression.value;
      case "undefined": return undefined;
      case "constant": {
        const value = context.component.constants.find(value => value.name === expression.name);
        if (!value) throw new Error(`Unknown view constant ${expression.name}`);
        return clone(value.value);
      }
      case "binding": {
        if (expression.scope === "prop") return context.props[expression.name];
        if (expression.scope === "local") return context.locals[expression.name];
        if (expression.scope === "event") return context.events[expression.name];
        if (expression.scope === "inject") {
          const injection = context.component.injections?.find(value => value.name === expression.name);
          const source = injection && context.instance.injections.get(injection.key);
          if (!source) throw new Error(`Missing injected view context ${expression.name}`);
          return source();
        }
        const value = context.component.values.find(value => value.name === expression.name);
        const source = this.module(context);
        const member = [...source.signals, ...source.memos, ...source.fields].find(member => member.name === (value?.sourceName ?? expression.name));
        if (!member) throw new Error(`Unknown model value ${context.component.name}.${expression.name}`);
        return this.rendering ? this.model.state(context.region)[member.name] : this.model.read(member.id, context.region);
      }
      case "field": return evaluate(expression.object)?.[expression.name];
      case "index": { const value = evaluate(expression.object), index = evaluate(expression.index); return value?.[index]; }
      case "cast": return this.model.numeric(evaluate(expression.value), expression.type);
      case "narrow": return evaluate(expression.value);
      case "template": return expression.parts.map(part => typeof part === "string" ? part : String(evaluate(part))).join("");
      case "conditional": return evaluate(expression.condition) ? evaluate(expression.consequent) : evaluate(expression.alternate);
      case "unary": { const value = evaluate(expression.operand); return expression.operator === "!" ? !value : this.model.numeric(expression.operator === "-" ? -value : +value, expression.type); }
      case "call": {
        const args = expression.arguments.map(evaluate);
        if (expression.target === "builtin") return this.model.builtin(expression.name, args, expression.type);
        const fn = context.component.functions.find(fn => fn.name === expression.name);
        return this.model.call(fn?.sourceName ?? expression.name, args, context.region, handler);
      }
      case "binary": {
        const left = evaluate(expression.left);
        if (expression.operator === "&&") return left && evaluate(expression.right);
        if (expression.operator === "||") return left || evaluate(expression.right);
        if (expression.operator === "??") return left ?? evaluate(expression.right);
        const right = evaluate(expression.right);
        switch (expression.operator) {
          case "===": return left === right; case "!==": return left !== right;
          case "<": return left < right; case ">": return left > right; case "<=": return left <= right; case ">=": return left >= right;
        }
        let value: any;
        switch (expression.operator) {
          case "+": value = left + right; break; case "-": value = left - right; break;
          case "*": value = expression.type.kind === "number" && !expression.type.name.startsWith("f") ? Math.imul(left, right) : left * right; break;
          case "/": value = left / right; break; case "%": value = left % right; break;
          case "&": value = left & right; break; case "|": value = left | right; break; case "^": value = left ^ right; break;
          case "<<": value = left << right; break; case ">>": value = left >> right; break; case ">>>": value = left >>> right; break;
          default: throw new Error(`Unsupported view binary operator ${expression.operator}`);
        }
        return this.model.numeric(value, expression.type);
      }
    }
  }
  private handler(handler: AotHandler, context: Context): void {
    switch (handler.kind) {
      case "call": this.expression(handler.expression, context, true); break;
      case "assign": {
        const value = context.component.values.find(value => value.name === handler.name);
        this.model.write(value?.sourceName ?? handler.name, this.expression(handler.value, context), context.region); break;
      }
      case "sequence": handler.steps.forEach(step => this.handler(step, context)); break;
      case "if": (this.expression(handler.condition, context) ? handler.then : handler.else ?? []).forEach(step => this.handler(step, context)); break;
      case "emit": {
        const callback = context.instance.events.get(handler.name);
        if (!callback && !handler.optional) throw new Error(`Missing view callback ${handler.name}`);
        callback?.(handler.arguments.map(argument => this.expression(argument, context))); break;
      }
    }
  }
  private mountNodes(nodes: AotNode[], context: ContextSource): Mounted[] {
    return nodes.map(node => {
      const mounted: Mounted = { node, context, children: [], uid: ++this.nextNode };
      if (node.kind === "input") mounted.previous = node.input.kind === "button" && node.input.latched ? 0xffffffff : 0;
      if (node.kind === "element" || node.kind === "input") mounted.children = this.mountNodes(node.children, context);
      if (node.kind === "component") this.mountComponent(mounted, node);
      if (node.kind === "slot") {
        const instance = context()!.instance, slot = instance.slots.get(node.name);
        const source: ContextSource = slot ? () => {
          const parent = slot.parent(), child = context(); if (!parent || !child) return undefined;
          const values = Object.fromEntries((node.props ?? []).map(prop => [prop.name, this.expression(prop.value, child)]));
          return { ...parent, locals: { ...parent.locals, ...Object.fromEntries((slot.definition.bindings ?? []).map(binding => [binding.name, values[binding.prop]])) } };
        } : context;
        mounted.children = this.mountNodes(slot?.definition.children ?? node.fallback, source);
      }
      return mounted;
    });
  }
  private mountComponent(mounted: Mounted, node: Extract<AotNode, { kind: "component" }>): void {
    const component = this.components.get(node.component);
    if (!component) throw new Error(`Unknown component ${node.component}`);
    const parent = mounted.context()!;
    const instance: Instance = { component, region: parent.region, owned: !!component.factory, context: () => undefined, slots: new Map(node.slots.map(slot => [slot.name, { definition: slot, parent: mounted.context }])), events: new Map(), injections: new Map(parent.instance.injections) };
    for (const provided of parent.component.provides ?? []) instance.injections.set(provided.key, () => this.expression(provided.value, mounted.context()!));
    instance.context = () => {
      const parent = mounted.context(); if (!parent) return undefined;
      const props = Object.fromEntries(component.props.map(prop => {
        const supplied = node.props.find(value => value.name === prop.name);
        return [prop.name, supplied ? this.expression(supplied.value, parent) : prop.default];
      }));
      return { component, region: instance.region, props, locals: {}, events: {}, instance };
    };
    if (component.factory) {
      const context = instance.context()!;
      instance.region = this.model.mount(component.factory.sourceName, (component.factory.arguments ?? []).map(argument => this.expression(argument, context)), true);
      this.instances.set(instance.region, instance);
    }
    for (const listener of node.events) instance.events.set(listener.name, args => {
      const parent = mounted.context(); if (!parent) return;
      this.handler(listener.handler, { ...parent, events: Object.fromEntries(args.map((value, index) => [index ? `$event${index}` : "$event", value])) });
    });
    instance.last = instance.context(); mounted.instance = instance;
    mounted.children = this.mountNodes(component.nodes, instance.context);
  }
  private disposeNode(node: Mounted): void {
    node.children.forEach(child => this.disposeNode(child));
    node.rows?.forEach(row => row.children.forEach(child => this.disposeNode(child)));
    if (node.instance?.owned) this.destroyed.push(node.instance);
  }
  private cleanup(): boolean {
    const destroyed = this.destroyed.splice(0).sort((a, b) => b.region - a.region);
    for (const instance of destroyed) {
      if (instance.component.hooks?.unmount) this.handler(instance.component.hooks.unmount, instance.context() ?? instance.last!);
      this.model.unmount(instance.region); this.instances.delete(instance.region);
    }
    return destroyed.length > 0;
  }
  private update(): void {
    const previous = this.rendering; this.rendering = true;
    try { this.tree.forEach(node => this.updateNode(node)); } finally { this.rendering = previous; }
  }
  private updateNode(mounted: Mounted): void {
    const context = mounted.context(); if (!context) return;
    const node = mounted.node;
    if (mounted.instance) mounted.instance.last = mounted.instance.context();
    if (node.kind === "if") {
      const branch = node.branches.findIndex(branch => !branch.condition || this.expression(branch.condition, context));
      if (branch !== mounted.branch) { mounted.children.forEach(child => this.disposeNode(child)); mounted.children = this.mountNodes(node.branches[branch]?.children ?? [], mounted.context); mounted.branch = branch; }
    }
    if (node.kind === "for") {
      const values: any[] = this.expression(node.source, context), old = new Map((mounted.rows ?? []).map(row => [row.key, row]));
      const keys = new Set<any>();
      mounted.rows = values.map((value, index) => {
        const rowContext = { ...context, locals: { ...context.locals, [node.item]: value, ...(node.index ? { [node.index]: index } : {}) } };
        const key = this.expression(node.key, rowContext); if (keys.has(key)) throw new Error(`Duplicate view row key ${String(key)}`); keys.add(key);
        const previous = old.get(key); if (previous) { old.delete(key); return previous; }
        const source: ContextSource = () => {
          const parent = mounted.context(); if (!parent) return undefined;
          const items: any[] = this.expression(node.source, parent);
          for (let index = 0; index < items.length; index++) {
            const candidate = { ...parent, locals: { ...parent.locals, [node.item]: items[index], ...(node.index ? { [node.index]: index } : {}) } };
            if (this.expression(node.key, candidate) === key) return candidate;
          }
          return undefined;
        };
        return { key, children: this.mountNodes(node.children, source) };
      });
      for (const row of old.values()) row.children.forEach(child => this.disposeNode(child));
      mounted.rows.forEach(row => row.children.forEach(child => this.updateNode(child)));
    }
    mounted.children.forEach(child => this.updateNode(child));
  }
  private allNodes(): Mounted[] {
    const result: Mounted[] = [];
    const visit = (nodes: Mounted[]) => { for (const node of nodes) { result.push(node); visit(node.children); node.rows?.forEach(row => visit(row.children)); } };
    visit(this.tree); return result;
  }
  private dispatch(input: ModelTapeFrame): boolean {
    const buttons = input.buttons ?? 0, nodes = this.allNodes();
    const pressed = buttons & ~this.previousButtons; this.previousButtons = buttons;
    const targets = input.target === undefined ? [] : nodes.filter(node => node.node.kind === "element" && (node.uid === input.target || node.node.debugName === input.target));
    if (input.target !== undefined && targets.length !== 1) throw new Error(`Tape target ${input.target} must identify one mounted element; found ${targets.length}`);
    if (input.target === undefined && pressed & BTN.CIRCLE && nodes.some(node => node.node.kind === "element" && node.node.events.some(event => event.name === "press"))) throw new Error("Tape activation requires target: a host-resolved node number or unique debugName");
    const axis = (index: number) => input.axis_deltas?.[index] ?? (Array.isArray(input.axes) ? input.axes[index] : input.axes ? (input.axes as { primary?: number; secondary?: number })[index === 0 ? "primary" : "secondary"] : undefined) ?? (index === 0 ? input.axis : undefined) ?? 0;
    let handled = false;
    for (const mounted of nodes) {
      const node = mounted.node;
      if (node.kind === "input") {
        const pending = node.input.kind === "button" ? (buttons & ~mounted.previous! & node.input.button) !== 0 : axis(node.input.axis) !== 0;
        mounted.previous = buttons;
        if (!pending) continue;
        const context = mounted.context(); if (!context || !this.expression(node.active, context)) continue;
        this.handler(node.handler, { ...context, events: { ...context.events, $event: node.input.kind === "axis" ? axis(node.input.axis) : undefined } }); handled = true;
      } else if (node.kind === "element" && targets[0] === mounted) {
        const context = mounted.context(); if (!context) continue;
        for (const event of node.events) if (event.name === "press") { this.handler(event.handler, context); handled = true; }
      }
    }
    return handled;
  }
}

export function replayModelTape(program: AotProgram, tape: ModelTape | ModelTapeFrame[], options: ModelInterpreterOptions = {}): ModelFrame[] {
  const hz = Array.isArray(tape) ? 60 : tape.hz ?? 60;
  if (!Number.isFinite(hz) || hz <= 0) throw new Error("Tape hz must be a positive finite number");
  const interpreter = new ModelTapeInterpreter(program, options);
  return (Array.isArray(tape) ? tape : tape.frames).map((frame, index) => interpreter.frame({ ...frame, clock: frame.clock ?? index * 1000 / hz }));
}
