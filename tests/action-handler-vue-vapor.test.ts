import { beforeEach, describe, expect, mock, test } from "bun:test";
import { BTN } from "../contracts/spec/spec.ts";
import type { HostOps } from "../framework/src/host.ts";
import type { NodeMirror } from "../framework/src/native-tree.ts";
import { createVueVaporTestRuntime } from "./vue-vapor-test-runtime.ts";
import { insertNode, resetRendererState, rootMirror } from "../framework/src/native-tree.ts";

// Components are normally bundled with framework/compiler/jsx-plugin.ts, which aliases
// `vue` to the Vapor runtime. This focused unit test only needs enough of that
// runtime to execute ActionHandler's setup and lifecycle registration.
mock.module("vue", createVueVaporTestRuntime);

const { ActionHandler, View } = await import("../framework/src/components-vue-vapor.ts");
const { resetFrameHooks, runFrameHooks } = await import("../framework/src/frame-vue-vapor.ts");
const { installHost } = await import("../framework/src/host.ts");

function testHostOps(): HostOps {
  let nextId = 2;
  const noop = () => {};
  return {
    createNode: () => nextId++,
    destroyNode: noop,
    insertBefore: noop,
    removeChild: noop,
    setStyle: noop,
    setProp: noop,
    setText: noop,
    replaceText: noop,
    uploadTexture: () => 0,
    setImage: noop,
    setSprite: noop,
    animate: () => 1,
    cancelAnim: noop,
    setFocus: noop,
    measureText: () => 0,
  };
}

describe("Vue Vapor ActionHandler", () => {
  beforeEach(() => {
    resetFrameHooks();
    resetRendererState();
    installHost({ ops: testHostOps(), kind: "injected", target: "injected", strict: true });
  });

  test("normalizes Vue template attributes for primitive host components", () => {
    let captured: NodeMirror | null = null;
    const setup = View as unknown as (
      props: Record<string, never>,
      context: { attrs: Record<string, unknown>; slots: { default: () => null } },
    ) => NodeMirror;

    const node = setup({}, {
      attrs: {
        "debug-name": "CounterButton",
        "node-ref": () => (value: NodeMirror | null) => { captured = value; },
        focusable: "",
      },
      slots: { default: () => null },
    });

    expect(node.debugName).toBe("CounterButton");
    expect(node.focusable).toBe(true);
    expect(captured as NodeMirror | null).toBe(node);
  });

  test("forwards latched so a held opener must release before firing", () => {
    let presses = 0;
    const setup = ActionHandler as unknown as (
      props: Record<string, never>,
      context: { attrs: Record<string, unknown>; slots: { default: () => unknown } },
    ) => unknown;

    const block = setup({}, {
      attrs: {
        button: BTN.SELECT,
        latched: true,
        onPress: () => presses++,
      },
      // The marker must be attached: only connected declarative handlers take
      // part in document-ordered input dispatch.
      slots: { default: () => ({ testBlock: true }) },
    });
    insertNode(rootMirror, (block as NodeMirror[])[0]!);

    runFrameHooks(BTN.SELECT);
    expect(presses).toBe(0);
    runFrameHooks(0);
    runFrameHooks(BTN.SELECT);
    expect(presses).toBe(1);
  });
});
