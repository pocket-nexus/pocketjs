// Vue Vapor renderer over the native `ui.*` tree.

import {
  createVaporApp,
  insert as vaporInsert,
  remove as vaporRemove,
  type VaporComponent,
} from "vue";
import {
  createElement as createNativeElement,
  createTextNode,
  detachNode,
  getFirstChild,
  getNextSibling,
  getParentNode,
  insertNode,
  isTextNode,
  missCounters,
  registerSprite,
  registerTexture,
  release,
  removeNode,
  replaceText,
  resetRendererState,
  resetSprites,
  resetTextures,
  retain,
  rootMirror,
  runSweep,
  setProp,
  setStyleResolver,
  type NodeMirror,
} from "./native-tree.ts";

const insertVaporBlock = vaporInsert as unknown as (
  block: unknown,
  parent: NodeMirror,
  anchor?: NodeMirror | null,
) => void;
const removeVaporBlock = vaporRemove as unknown as (block: unknown, parent: NodeMirror) => void;
const createPocketVueApp = createVaporApp as unknown as (component: VaporComponent) => {
  mount(root: NodeMirror): void;
  unmount(): void;
};

export type VaporRenderRoot = (() => unknown) | VaporComponent;

export {
  createTextNode,
  detachNode,
  getFirstChild,
  getNextSibling,
  getParentNode,
  insertNode,
  isTextNode,
  missCounters,
  registerSprite,
  registerTexture,
  release,
  replaceText,
  resetRendererState,
  resetSprites,
  resetTextures,
  retain,
  rootMirror,
  runSweep,
  setProp,
  setStyleResolver,
  type NodeMirror,
};

export interface RenderRoot {
  update(node: unknown): void;
  dispose(): void;
}

function normalizeVaporBlock(block: unknown): unknown | undefined {
  while (typeof block === "function" && block.length === 0) {
    block = (block as () => unknown)();
  }
  if (block == null || typeof block === "boolean") return undefined;
  if (!Array.isArray(block)) return block;
  const out: unknown[] = [];
  for (const child of block) {
    const normalized = normalizeVaporBlock(child);
    if (Array.isArray(normalized)) out.push(...normalized);
    else if (normalized !== undefined) out.push(normalized);
  }
  return out.length > 0 ? out : undefined;
}

export function createElement(type: string): NodeMirror {
  return createNativeElement(type);
}

export function createRenderRoot(root: NodeMirror): RenderRoot {
  let current: unknown;
  return {
    update(node: unknown) {
      if (current) removeVaporBlock(current, root);
      current = normalizeVaporBlock(node);
      if (current) insertVaporBlock(current, root);
    },
    dispose() {
      if (current) removeVaporBlock(current, root);
      current = undefined;
    },
  };
}

export function render(code: VaporRenderRoot, root: NodeMirror): () => void {
  // JSX callers pass a setup callback. Compiled SFCs are component option
  // objects and can be mounted directly, without a synthetic TSX wrapper.
  const component = (
    typeof code === "function" ? { setup: code as () => unknown } : code
  ) as VaporComponent;
  const app = createPocketVueApp(component);
  app.mount(root as never);
  return () => app.unmount();
}
