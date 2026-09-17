// vapor/oracle/entry-playdate.ts — oracle bundle entry for the Playdate Todo.
//
// Identical hook installation to entry.ts, mounting the crank-driven
// todo.playdate.tsx variant so the relative-axis path replays under the real
// Vue Vapor runtime exactly like buttons do.

import { createVaporApp, nextTick } from "vue";
import TodoApp from "../examples/todo/todo.playdate.tsx";
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
