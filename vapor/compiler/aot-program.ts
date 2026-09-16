/** Shared program finalization: resolve context, bake styles and collect host demands. */
import { withIsolatedAnimationBake } from "../../framework/compiler/animation.ts";
import { compileClasses } from "../../framework/compiler/tailwind.ts";
import { resolveProvidedContext } from "./aot-provide-inject.ts";
import type { AotProgram, AotComponent, AotNode, AotExpr } from "./aot-ir.ts";
import { fail, location, type TypeMapper } from "./aot-types.ts";
export function finalizeAotProgram(root: string, components: AotComponent[], mapper: TypeMapper, classLiterals: Set<string>): AotProgram {
  resolveProvidedContext(components);
  function collectStyle(value: AotExpr, allowForward = true): void {
    if (value.kind === "literal" && typeof value.value === "string") { if (value.value) classLiterals.add(value.value); }
    else if (value.kind === "conditional") { collectStyle(value.consequent, false); collectStyle(value.alternate, false); }
    else if (!(allowForward && value.kind === "binding" && value.scope === "prop" && value.type.kind === "style")) fail(value.loc, "StyleClass values require full class literal leaves or an unchanged StyleClass prop");
  }
  function walk(nodes: AotNode[], visit: (node: AotNode) => void): void {
    for (const node of nodes) {
      visit(node);
      if (node.kind === "if") node.branches.forEach(branch => walk(branch.children, visit));
      else if (node.kind === "component") node.slots.forEach(slot => walk(slot.children, visit));
      else if (node.kind === "slot") walk(node.fallback, visit);
      else walk(node.children, visit);
    }
  }
  for (const component of components) for (const prop of component.props) {
    if (prop.type.kind === "style" && typeof prop.default === "string" && prop.default) classLiterals.add(prop.default);
  }
  for (const component of components) walk(component.nodes, node => {
    if (node.kind === "component") for (const prop of node.props) if (prop.value.type.kind === "style") collectStyle(prop.value);
  });
  const styles = withIsolatedAnimationBake(() => compileClasses(classLiterals));
  for (const classes of classLiterals) if (styles.ids[classes] === undefined) fail(components.find(c => c.root)?.nodes[0]?.loc ?? location(root, ""), `Unsupported class literal ${JSON.stringify(classes)}`);
  function finalize(nodes: AotNode[]) {
    for (const node of nodes) {
      if (node.kind === "element") {
        const temporary = node as typeof node & { classLiteral?: string };
        if (temporary.classLiteral) { node.style = styles.ids[temporary.classLiteral]!; delete temporary.classLiteral; }
        if (node.dynamicStyle) {
          const visit = (e: AotExpr) => { if (e.kind === "literal") e.value = e.value === "" ? -1 : styles.ids[e.value as string]!; else if (e.kind === "conditional") { visit(e.consequent); visit(e.alternate); } };
          visit(node.dynamicStyle.expression);
        }
        finalize(node.children);
      } else if (node.kind === "if") node.branches.forEach(b => finalize(b.children));
      else if (node.kind === "for" || node.kind === "input") finalize(node.children);
      else if (node.kind === "component") {
        const bake = (value: AotExpr): void => {
          if (value.kind === "literal" && typeof value.value === "string") value.value = value.value === "" ? -1 : styles.ids[value.value]!;
          else if (value.kind === "conditional") { bake(value.consequent); bake(value.alternate); }
        };
        for (const prop of node.props) if (prop.value.type.kind === "style") bake(prop.value);
        node.slots.forEach(s => finalize(s.children));
      }
      else finalize(node.fallback);
    }
  }
  components.forEach(c => {
    finalize(c.nodes);
    for (const prop of c.props) if (prop.type.kind === "style" && typeof prop.default === "string") prop.default = prop.default === "" ? -1 : styles.ids[prop.default]!;
  });
  const buttons = new Set<number>(), axes = new Set<number>(), visitedComponents = new Set<string>();
  function demands(nodes: AotNode[]): void {
    for (const node of nodes) {
      if (node.kind === "input") { if (node.input.kind === "button") buttons.add(node.input.button); else axes.add(node.input.axis); demands(node.children); }
      else if (node.kind === "component") {
        node.slots.forEach(slot => demands(slot.children));
        if (!visitedComponents.has(node.component)) { visitedComponents.add(node.component); demands(components.find(c => c.name === node.component)!.nodes); }
      } else if (node.kind === "if") node.branches.forEach(branch => demands(branch.children));
      else if (node.kind === "slot") demands(node.fallback);
      else demands(node.children);
    }
  }
  demands(components.find(c => c.name === root)!.nodes);
  return { version: 3, root: root, components, types: mapper.declarations, styles: { records: styles.records, anims: styles.anims, ids: styles.ids, bytes: [...styles.bin], usedFontSlots: styles.usedFontSlots }, diagnostics: mapper.diagnostics, demands: { buttons: [...buttons].sort((a, b) => a - b), axes: [...axes].sort((a, b) => a - b), capabilities: axes.size ? ["relative-axis"] : [] } };
}
