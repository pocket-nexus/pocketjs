// vapor/tests/overlay.test.ts — overlay allocation of frame-local temps.
//
// Materialized view chains and string scratch compile to shared static
// slots instead of permanent statics / C-stack frames. Two temps share a
// slot unless their owners can be live at once: same generated function,
// or one reachable from the other through helpers, computed accessors, or
// keymap dispatch.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { compileVaporApp } from "../compiler/compile.ts";

const ENTRY = join(import.meta.dir, "..", "examples", "todo", "todo.tsx");

const HEADER = `
import { computed, ref } from "vue";
import { Button, onButton } from "../../host/input.ts";
`;

function slots(c: string, kind: "view" | "sb"): string[] {
  return [...c.matchAll(new RegExp(`static vp_${kind} (ovl_${kind}\\d+);`, "g"))].map((m) => m[1]);
}

describe("overlay allocation", () => {
  test("todo/nes: all large frame-locals leave the C stack into 3 shared slots", async () => {
    const source = await Bun.file(ENTRY).text();
    const app = compileVaporApp(ENTRY, source, "VAPOR TODO", "nes");
    expect(app.plan).toContain("overlay RAM: 51 B in 3 shared slots (8 frame-local temps off the C stack)");
    expect(slots(app.c, "view")).toEqual(["ovl_view0"]);
    expect(slots(app.c, "sb")).toEqual(["ovl_sb0", "ovl_sb1"]);
    // no vp_sb/vp_view stack frames remain in function bodies
    expect(app.c).not.toMatch(/\{ vp_sb sb/);
    expect(app.c).not.toMatch(/\{ vp_view /);
    // and no permanent per-chain statics either
    expect(app.c).not.toMatch(/static vp_view vt/);
  });

  test("temps in mutually-exclusive keymap actions share one slot", () => {
    const src = `${HEADER}
export default () => {
  const a = ref("x");
  const bb = ref("y");
  const keys = {
    [Button.A]: () => { a.value = a.value + "!"; },
    [Button.B]: () => { bb.value = bb.value + "?"; },
  };
  onButton((b) => {
    keys[b]?.();
  });
  return (
    <>
      <row y={0}>{a.value}{bb.value}</row>
    </>
  );
};
`;
    const app = compileVaporApp("ovl.tsx", src);
    // two sb temps, one per action; actions are dispatch-exclusive, so they
    // interfere with the handler but not with each other -> one slot
    expect(slots(app.c, "sb")).toEqual(["ovl_sb0"]);
  });

  test("nested slice scratch interferes with its enclosing string build", () => {
    const src = `${HEADER}
export default () => {
  const s = ref("hello");
  onButton((b) => {
    if (b === Button.A) s.value = s.value.slice(0, -1);
  });
  return (
    <>
      <row y={0}>{s.value}</row>
    </>
  );
};
`;
    const app = compileVaporApp("ovl.tsx", src);
    // outer build target + nested slice scratch live at once -> two slots
    expect(slots(app.c, "sb")).toEqual(["ovl_sb0", "ovl_sb1"]);
  });

  test("view temps split when an effect's chain reads through a computed's chain", () => {
    const src = `${HEADER}
interface T { n: number; done: boolean; }
export default () => {
  const items = ref<T[]>([{ n: 1, done: false }]);
  const doneCount = computed(() => items.value.filter((t) => t.done).length);
  onButton((b) => {
    if (b === Button.A) items.value.push({ n: doneCount.value, done: false });
  });
  return (
    <>
      {items.value.slice(0, 0 + 4).map((t, i) => (
        <row y={i}>{t.n} of {doneCount.value}</row>
      ))}
    </>
  );
};
`;
    const app = compileVaporApp("ovl.tsx", src);
    // the map unit's slice temp is live across c_doneCount_update, whose
    // filter().length also materializes a temp -> reachability forces 2 slots
    expect(slots(app.c, "view")).toEqual(["ovl_view0", "ovl_view1"]);
  });

  test("GBA edge, repeat, and frame hooks share overlay slots without aliasing owners", () => {
    const src = `${HEADER.replace(
      'import { Button, onButton } from "../../host/input.ts";',
      'import { Button, onButton, onButtonRepeat } from "../../host/input.ts";',
    )}
import { onFrame } from "@pocketjs/framework/vue-vapor/lifecycle";
import { BTN } from "@pocketjs/framework/vue-vapor/input";
export default () => {
  const text = ref("x");
  onButton((b) => {
    if (b === Button.A) text.value = text.value + "a";
  });
  onButtonRepeat((b) => {
    if (b === Button.Right) text.value = text.value + "r";
  });
  onFrame((buttons) => {
    if (buttons & BTN.RIGHT) text.value = text.value + "f";
  });
  return (<><row y={0}>{text.value}</row></>);
};
`;
    const app = compileVaporApp("ovl-gba-hooks.tsx", src, "OVERLAY", "gba");
    // These entry points run sequentially and cannot nest, so their three
    // string builders may share one slot while retaining distinct owners.
    expect(slots(app.c, "sb")).toEqual(["ovl_sb0"]);
  });
});
