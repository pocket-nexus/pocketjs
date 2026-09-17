// vapor/oracle/entry.ts — bundle entry for the oracle build.
//
// Bundled with the repo's vue-vapor jsx plugin: `vue` resolves to the real
// runtime-with-vapor build and `document` is rewritten to
// globalThis.__vaporDocument. Executing the bundle just installs hooks; the
// test side owns the micro-DOM and drives boot/press/tick through them.

import { createVaporApp, nextTick } from "vue";
import TodoApp from "../examples/todo/todo.tsx";
import {
  __dispatchAxisDelta,
  __dispatchButton,
  __dispatchButtonRepeat,
  __resetButtons,
} from "../host/input.ts";

type AnyApp = { mount(container: unknown): void; unmount(): void };

const hooks = globalThis as Record<string, unknown>;

hooks.__vaporBoot = (container: unknown): AnyApp => {
  __resetButtons();
  const app = (createVaporApp as unknown as (comp: unknown) => AnyApp)({
    setup: () => (TodoApp as () => unknown)(),
  });
  app.mount(container);
  return app;
};

hooks.__vaporPress = (button: number): void => {
  __dispatchButton(button);
};

hooks.__vaporRepeat = (button: number): void => {
  __dispatchButtonRepeat(button);
};

hooks.__vaporAxisDelta = (axis: number, delta: number): void => {
  __dispatchAxisDelta(axis as 0 | 1, delta);
};

hooks.__vaporTick = (): Promise<void> => nextTick();
