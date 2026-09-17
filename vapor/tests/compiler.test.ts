// vapor/test/compiler.test.ts — subset diagnostics + deterministic output.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadBoard } from "../compiler/boards.ts";
import { compileVaporApp, VAPOR_TARGETS, VaporCompileError } from "../compiler/compile.ts";
import { esp32BuildId } from "../compiler/esp32.ts";
import { FONT8 } from "../compiler/font.gen.ts";
import {
  __dispatchButton,
  __dispatchButtonRepeat,
  __resetButtons,
  Button,
  onButton,
  onButtonRepeat,
} from "../host/input.ts";

const ENTRY = join(import.meta.dir, "..", "examples", "todo", "todo.tsx");

const HEADER = `
import { computed, ref } from "vue";
import { Button, onButton } from "../../host/input.ts";
`;

function minimal(body: string, jsx = "<row y={0}>{count.value}</row>"): string {
  return `${HEADER}
export default () => {
  const count = ref(0);
  ${body}
  onButton((b) => {
    if (b === Button.A) count.value = count.value + 1;
  });
  return (
    <>
      ${jsx}
    </>
  );
};
`;
}

function compileErr(source: string): string {
  try {
    compileVaporApp("test.tsx", source);
  } catch (e) {
    expect(e).toBeInstanceOf(VaporCompileError);
    return (e as Error).message;
  }
  throw new Error("expected a VaporCompileError");
}

describe("pocket vapor compiler", () => {
  test("compiles the todo example deterministically", async () => {
    const source = await Bun.file(ENTRY).text();
    const a = compileVaporApp(ENTRY, source, "VAPOR TODO");
    const b = compileVaporApp(ENTRY, source, "VAPOR TODO");
    expect(a.c).toBe(b.c);
    expect(a.rpgEnabled).toBe(false);
    expect(a.c).toContain("vp_mark");
    expect(a.c).toContain("vp_row_clear");
    expect(a.graph).toContain("visible: view(maxLen 12)");
    expect(a.plan).toContain("pools");
  });

  test("esp32 uses its 20x18 display grid and emits 1bpp RGB565 data", () => {
    expect(VAPOR_TARGETS.esp32).toEqual({
      name: "esp32",
      width: 20,
      height: 18,
      poolCap: 32,
      strCap: 24,
    });

    const compiled = compileVaporApp(
      "esp32.tsx",
      minimal("", '<row y={0} class="text-[#ff0000] bg-[#00ff00]">{count.value}</row>'),
      "ESP32",
      "esp32",
    );
    expect(compiled.c).toContain("/* target: esp32 (20x18) */");
    expect(compiled.c).toContain("#define VP_STR_CAP 24");
    expect(compiled.c).toContain("#define VP_VIEW_CAP 32");

    const font = compiled.c.match(/const u8 vp_font_tiles\[\] = \{ ([^}]*) \};/);
    expect(font).not.toBeNull();
    const fontBytes = font![1].split(",").map(Number);
    expect(fontBytes).toHaveLength(95 * 8);
    expect(fontBytes).toEqual(FONT8.flat());

    const ink = compiled.c.match(/const u16 vp_ink565\[\] = \{ ([^}]*) \};/);
    const paper = compiled.c.match(/const u16 vp_paper565\[\] = \{ ([^}]*) \};/);
    expect(ink).not.toBeNull();
    expect(paper).not.toBeNull();
    expect(ink![1].split(",").map(Number)).toEqual([59262, 0xf800]);
    expect(paper![1].split(",").map(Number)).toEqual([0x10a4, 0x07e0]);
    expect(compiled.c).toContain("const u16 vp_backdrop = 4260;");
    expect(compiled.c).toContain("const u8 vp_pal_style[2] = { 0,1 };");
    expect(compiled.plan).toContain("760 B font + 12 B style data");
  });

  test("esp32 build identity is deterministic, source- and board-sensitive", async () => {
    const app = compileVaporApp("esp32.tsx", minimal(""), "ESP32", "esp32");
    const same = compileVaporApp("esp32.tsx", minimal(""), "ESP32", "esp32");
    const changed = compileVaporApp(
      "esp32.tsx",
      minimal("").replace("count.value + 1", "count.value + 2"),
      "ESP32",
      "esp32",
    );

    const board = loadBoard("meowbit");
    const id = await esp32BuildId(app, board);
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(await esp32BuildId(same, board)).toBe(id);
    expect(await esp32BuildId(changed, board)).not.toBe(id);

    const rewired = structuredClone(board);
    rewired.input.pins.b = 14;
    expect(await esp32BuildId(app, rewired)).not.toBe(id);
  });

  test("effect masks subscribe conditional reads on both arms", async () => {
    const source = await Bun.file(ENTRY).text();
    const app = compileVaporApp(ENTRY, source);
    // the footer reads only `editing`; the list block reads todos+cursor+filter
    expect(app.graph).toMatch(/eff_\d+: rows \[19, 20\) mask 0x8 \{editing\}/);
    expect(app.graph).toMatch(/rows \[3, 15\) mask 0x7 \{todos, cursor, filter\}/);
  });

  test("rejects loose equality", () => {
    const msg = compileErr(minimal("", "<row y={0}>{count.value == 1 ? 'a' : 'b'}</row>"));
    expect(msg).toContain("===");
  });

  test("rejects dynamic row y outside map", () => {
    const msg = compileErr(minimal("", "<row y={count.value}>{'X'}</row>"));
    expect(msg).toContain("compile-time constant");
  });

  test("rejects unknown vue imports", () => {
    const msg = compileErr(`
import { ref, computed, watch } from "vue";
import { Button, onButton } from "../../host/input.ts";
export default () => {
  const count = ref(0);
  onButton((b) => { count.value = 1; });
  return (<><row y={0}>{count.value}</row></>);
};
`);
    expect(msg).toContain("watch");
  });

  test("rejects computeds that read later computeds", () => {
    const msg = compileErr(minimal("const a = computed(() => b.value + 1);\n  const b = computed(() => count.value);"));
    expect(msg).toContain(".value on non-reactive: b");
  });

  test("rejects list refs without an interface annotation", () => {
    const msg = compileErr(`${HEADER}
export default () => {
  const items = ref([{ text: "A", done: false }]);
  onButton((b) => {});
  return (<><row y={0}>{items.value.length}</row></>);
};
`);
    expect(msg).toContain("ref<T[]>");
  });

  test("errors carry file:line:col", () => {
    const msg = compileErr(minimal("", "<row y={0}>{count.value == 1 ? 'a' : 'b'}</row>"));
    expect(msg).toMatch(/^test\.tsx:\d+:\d+/);
  });

  test("keymaps compile to ROM fnptr tables with null holes", async () => {
    const source = await Bun.file(ENTRY).text();
    const app = compileVaporApp(ENTRY, source);
    expect(app.c).toMatch(/static void \(\*const KM_listKeys\[10\]\)\(void\) = \{ .*km_listKeys_6.* \};/);
    expect(app.c).toContain("KM_editKeys");
    expect(app.c).toMatch(/\? KM_editKeys : KM_listKeys/); // dispatch ternary
    expect(app.c).toContain("fn_closeEditor"); // bare fn reference as keymap value
  });

  test("GBA button repeat is explicit and lowers to a separate native hook", () => {
    const source = minimal(`
  onButtonRepeat((b) => {
    if (b === Button.Right) count.value = count.value + 10;
  });`).replace("{ Button, onButton }", "{ Button, onButton, onButtonRepeat }");
    const app = compileVaporApp("repeat.tsx", source, "REPEAT", "gba");
    expect(app.c).toContain("void app_on_button_repeat(u8 b)");
    expect(app.c).toMatch(/app_on_button_repeat[\s\S]*g_count \+ 10/);
    expect(app.graph).toContain("button repeats: directional (gba)");
    expect(() => compileVaporApp("repeat.tsx", source, "REPEAT", "gb")).toThrow(
      /onButtonRepeat is currently supported only on the gba target/,
    );
  });

  test("official Vue Vapor onFrame and BTN imports lower to the fixed GBA frame hook", () => {
    const source = `${HEADER}
import { onFrame } from "@pocketjs/framework/vue-vapor/lifecycle";
import { BTN } from "@pocketjs/framework/vue-vapor/input";
export default () => {
  const count = ref(0);
  onFrame((buttons) => {
    if (buttons & (BTN.RIGHT | BTN.CROSS)) count.value = count.value + 2;
  });
  onButton((b) => {
    if (b === Button.A) count.value = count.value + 1;
  });
  return (<><row y={0}>{count.value}</row></>);
};
`;
    const app = compileVaporApp("frame.tsx", source, "FRAME", "gba");
    expect(app.c).toContain("void app_on_frame(u32 buttons)");
    expect(app.c).toMatch(/app_on_frame[\s\S]*buttons_arg & \(32 \| 16384\)/);
    expect(app.buttonsUsed).toEqual([0, 4]);
    expect(app.graph).toContain("frame hook: fixed (gba)");
    expect(() => compileVaporApp("frame.tsx", source, "FRAME", "gb")).toThrow(
      /onFrame is currently supported only on the gba target/,
    );
  });

  test("negative numeric ref seeds survive native initialization", () => {
    const source = minimal("const idle = ref<number>(-1);");
    const app = compileVaporApp("negative-seed.tsx", source, "NEGATIVE", "gba");
    expect(app.c).toContain("g_idle = -1;");
  });

  test("oracle repeat dispatch stays separate from physical press edges", () => {
    let presses = 0;
    let repeats = 0;
    __resetButtons();
    try {
      onButton(() => presses++);
      onButtonRepeat(() => repeats++);
      __dispatchButtonRepeat(Button.Right);
      expect([presses, repeats]).toEqual([0, 1]);
      __dispatchButton(Button.Right);
      expect([presses, repeats]).toEqual([1, 1]);
    } finally {
      __resetButtons();
    }
  });

  test("computed can yield a record reference (current todo)", async () => {
    const source = await Bun.file(ENTRY).text();
    const app = compileVaporApp(ENTRY, source);
    expect(app.graph).toContain("current: obj <- {cursor, filter, todos}");
    expect(app.c).toContain("static rec_todo * c_current_v;");
  });

  test("splice/indexOf remain in the subset", () => {
    const source = `${HEADER}
interface It { text: string; done: boolean }
export default () => {
  const items = ref<It[]>([{ text: "A", done: false }]);
  onButton((b) => {
    const t = items.value[0];
    if (t) items.value.splice(items.value.indexOf(t), 1);
  });
  return (<><row y={0}>{items.value.length}</row></>);
};
`;
    const app = compileVaporApp("test.tsx", source);
    expect(app.c).toContain("g_items_len--");
  });

  test("rejects keymap keys that are not compile-time constants", () => {
    const msg = compileErr(minimal("const keys = { [count.value]: () => {} };"));
    expect(msg).toContain("compile-time Button constants");
  });

  test("rejects helper params without a number annotation", () => {
    const msg = compileErr(minimal("function move(d) { count.value = count.value + d; }"));
    expect(msg).toContain("annotated `: number`");
  });

  test("components inline to zero-cost paint code", async () => {
    const source = await Bun.file(ENTRY).text();
    const app = compileVaporApp(ENTRY, source);
    // six components, yet the graph is unchanged: TitleBar folds to a static
    // boot-painted row, the rest merge into the same four effects
    expect(app.graph.match(/eff_\d+:/g)?.length).toBe(4);
    expect(app.c).not.toContain("TitleBar");
    expect(app.graph).toMatch(/rows \[3, 15\) mask 0x7 \{todos, cursor, filter\}/);
  });

  test("rejects props that collide with row attributes", () => {
    const msg = compileErr(`${HEADER}
function Bad(props: { y: number }) {
  return (<row y={props.y}>{"A"}</row>);
}
export default () => {
  const count = ref(0);
  onButton((b) => { count.value = 1; });
  return (<><Bad y={0} /></>);
};
`);
    expect(msg).toContain('collides with a <row> attribute');
  });

  test("rejects unknown and missing props", () => {
    const comp = `
function Line(props: { line: number; text: string }) {
  return (<row y={props.line}>{props.text}</row>);
}
`;
    const unknown = compileErr(`${HEADER}${comp}
export default () => {
  const count = ref(0);
  onButton((b) => { count.value = 1; });
  return (<><Line line={0} text="A" extra={1} /></>);
};
`);
    expect(unknown).toContain("unknown prop extra");
    const missing = compileErr(`${HEADER}${comp}
export default () => {
  const count = ref(0);
  onButton((b) => { count.value = 1; });
  return (<><Line line={0} /></>);
};
`);
    expect(missing).toContain("missing prop text");
  });

  test("rejects list assignment from a different list", () => {
    const source = `${HEADER}
interface It { text: string; done: boolean }
export default () => {
  const a = ref<It[]>([]);
  const b2 = ref<It[]>([]);
  onButton((b) => {
    a.value = b2.value.filter((t) => !t.done);
  });
  return (<><row y={0}>{a.value.length}</row></>);
};
`;
    const msg = compileErr(source);
    expect(msg).toContain("derive from the same list");
  });
});
