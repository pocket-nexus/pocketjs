// vapor/test/compiler.test.ts — subset diagnostics + deterministic output.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadBoard } from "../compiler/boards.ts";
import { compileVaporApp, VAPOR_TARGETS, VaporCompileError } from "../compiler/compile.ts";
import { esp32BuildId } from "../compiler/esp32.ts";
import { FONT8 } from "../compiler/font.gen.ts";

const ENTRY = join(import.meta.dir, "..", "examples", "todo", "todo.tsx");
const SIX_BUTTON = join(
  import.meta.dir,
  "..",
  "examples",
  "playdate-six-button",
  "playdate-six-button.tsx",
);

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
    expect(a.c).toContain("vp_mark");
    expect(a.graph).toContain("visible: view(maxLen 12)");
    expect(a.plan).toContain("pools");
  });

  test("gb emits the font 1bpp and leaves the other targets' encodings alone", async () => {
    const source = await Bun.file(ENTRY).text();
    const fontOf = (target: "gb" | "gba" | "nes" | "esp32") => {
      const c = compileVaporApp(ENTRY, source, "VAPOR TODO", target).c;
      const m = c.match(/const u8 vp_font_tiles\[\] = \{ ([^}]*) \};/);
      return m === null ? null : m[1].split(",").map(Number);
    };

    // GB ships FONT8 itself; vapor_gb.c's upload_font builds the 2 styles x
    // 95 x 16 B of 2bpp VRAM from it (proven byte-for-byte in gb-font.test.ts).
    const gb = fontOf("gb");
    expect(gb).toHaveLength(95 * 8);
    expect(gb).toEqual(FONT8.flat());
    const gbC = compileVaporApp(ENTRY, source, "VAPOR TODO", "gb").c;
    expect(gbC).toContain("const u8 vp_pal_style[");
    expect(gbC).not.toContain("vp_palettes");
    expect(compileVaporApp(ENTRY, source, "VAPOR TODO", "gb").c).toBe(gbC);

    // GBA stays 4bpp, 95 x 32 B, pixels drawn from ink(1)/paper(2) only.
    const gba = fontOf("gba")!;
    expect(gba).toHaveLength(95 * 32);
    expect([...new Set(gba.flatMap((b) => [b & 0xf, b >> 4]))].sort()).toEqual([1, 2]);

    // NES ships its font as CHR-ROM, so it has no C font table at all.
    expect(fontOf("nes")).toBeNull();
    // esp32 and playdate were already 1bpp and must be untouched. (todo.tsx
    // has no playdate input mapping, so that target reads the six-button one.)
    expect(fontOf("esp32")).toEqual(FONT8.flat());
    const pdSource = await Bun.file(SIX_BUTTON).text();
    const pd = compileVaporApp(SIX_BUTTON, pdSource, "PLAYDATE SIX", "playdate").c.match(
      /const u8 vp_font_tiles\[\] = \{ ([^}]*) \};/,
    );
    expect(pd![1].split(",").map(Number)).toEqual(FONT8.flat());
  });

  test("the memory plan prices the gb font at its emitted 760 B", async () => {
    const source = await Bun.file(ENTRY).text();
    const planFont = (target: "gb" | "gba" | "nes") =>
      compileVaporApp(ENTRY, source, "VAPOR TODO", target).plan.match(/(\d+) B font/)![1];
    expect(planFont("gb")).toBe("760");
    // 4bpp GBA and CHR-ROM NES still carry the 3040 B figure.
    expect(planFont("gba")).toBe("3040");
    expect(planFont("nes")).toBe("3040");
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
