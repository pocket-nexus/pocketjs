import { expect, test } from "bun:test";
import { createRoot, createSignal } from "solid-js";
import { Text } from "../framework/src/primitives.ts";
import { installHost, type HostOps } from "../framework/src/host.ts";
import { render, resetRendererState, rootMirror, type NodeMirror } from "../framework/src/renderer.ts";
import type { PreparedText } from "../framework/src/fonts.ts";
import type { RuntimeFont, RuntimeLayoutOptions, RuntimeTextLayout } from "../framework/src/runtime-fonts.ts";
import { pending, ready, type ResourceState } from "../framework/src/resource-state.ts";

if (Bun.resolveSync("solid-js", import.meta.dir).endsWith("server.js")) throw Error("Runtime font UI tests require --conditions=browser");

test("ordinary Text owns runtime leases and color changes preserve its prepared layout", () => {
  let nextNode = 2, paints = 0;
  const bakedText: string[] = [];
  installHost({ kind: "injected", target: "test", strict: true, ops: {
    createNode: () => nextNode++, destroyNode() {}, insertBefore() {}, removeChild() {}, setStyle() {}, setProp() {},
    setText: (_node: number, text: string) => { bakedText.push(text); }, replaceText() {},
  } as unknown as HostOps });
  resetRendererState();
  const leases: { text: string; options?: RuntimeLayoutOptions; resolve(): void; disposed: boolean }[] = [];
  const font = { prepareText(text: string, options?: RuntimeLayoutOptions) {
    const subscribers = new Set<() => void>();
    let state: ResourceState<PreparedText> = pending();
    const layout = { text, width: options?.width ?? 40, height: 20 } as RuntimeTextLayout;
    const lease = { text, options, disposed: false, resolve() {
      state = ready({ text, slot: 0, layout, paint: () => { paints++; return true; }, clear() {} });
      subscribers.forEach(fn => fn());
    } };
    leases.push(lease);
    return { state: () => state, layout: () => layout,
      subscribe(fn: () => void) { subscribers.add(fn); return () => { subscribers.delete(fn); }; },
      dispose() { lease.disposed = true; },
    };
  } } as RuntimeFont;
  const ui = createRoot(dispose => {
    const [text, setText] = createSignal("AV ffi"), [width, setWidth] = createSignal(60), [color, setColor] = createSignal("#ffffff");
    let node: NodeMirror | undefined;
    const unmount = render(() => Text({ font, get children() { return text(); }, get textLayout() { return { width: width() }; },
      get style() { return { textColor: color() }; }, nodeRef: value => { node = value; },
    }) as unknown as NodeMirror, rootMirror);
    return { setText, setWidth, setColor, node: () => node, dispose: () => { unmount(); dispose(); } };
  });
  expect(leases).toHaveLength(1); expect(rootMirror.children).toHaveLength(0);
  leases[0].resolve(); expect(ui.node()?.text).toBe("AV ffi"); expect(paints).toBe(1);
  expect(bakedText).toEqual([]);
  ui.setColor("#ff0000"); expect(leases).toHaveLength(1); expect(paints).toBe(1);
  ui.setWidth(30); expect(leases).toHaveLength(2); expect(leases[0].disposed).toBe(true);
  leases[1].resolve(); expect(ui.node()?.text).toBe("AV ffi"); expect(paints).toBe(2);
  ui.setText("e\u0301"); expect(leases).toHaveLength(3); expect(leases[1].disposed).toBe(true);
  leases[2].resolve(); expect(ui.node()?.text).toBe("e\u0301");
  ui.dispose(); expect(leases.every(lease => lease.disposed)).toBe(true);
  resetRendererState();
});
