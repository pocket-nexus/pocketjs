import { describe, test, expect } from "bun:test";
import { createPointerController } from "../framework/src/desktop-pointer.ts";
import { compileClasses } from "../framework/compiler/tailwind.ts";
import { XP_THEME } from "../framework/src/themes/desktop.ts";

function harness() {
  const a = { id: 1 }, b = { id: 2 }, title = { id: 3 };
  const pressed: number[] = [], moved: number[] = [];
  let active: number | null = null;
  const pointer = createPointerController({
    hit: (x: number) => x < 0 ? null : x < 100 ? a : x < 200 ? b : null,
    rawHit: (x: number) => x >= 200 ? title : null,
    parent: () => null,
    focus: () => {}, active: n => { active = n?.id ?? null; },
    press: n => { pressed.push(n.id); },
  });
  pointer.registerDrag(title, p => { if (!p.started) moved.push(p.dx); });
  const down = (x: number) => pointer.update({kind:"button",x,y:10,down:true});
  const up = (x: number) => pointer.update({kind:"button",x,y:10,down:false});
  const move = (x: number) => pointer.update({kind:"move",x,y:10});
  return { pointer, pressed, moved, down, up, move, active: () => active };
}

describe("desktop pointer ownership", () => {
  test("fast click fires once on release; moving onto a second button never fires it", () => {
    const h = harness(); h.down(20); expect(h.active()).toBe(1); h.up(20);
    expect(h.pressed).toEqual([1]);
    h.down(20); h.move(140); expect(h.active()).toBeNull(); h.up(140);
    h.up(140); expect(h.pressed).toEqual([1]);
  });
  test("focus loss, closing and pointer leaving cancel without activation", () => {
    const h = harness(); h.down(20); h.pointer.update({kind:"cancel"}); h.up(20);
    h.down(20); h.pointer.update({kind:"move",x:null,y:null}); h.up(-1);
    expect(h.pressed).toEqual([]); expect(h.active()).toBeNull();
    h.down(140); h.up(140); expect(h.pressed).toEqual([2]);
  });
  test("caption drag keeps its owner and does not click a button underneath", () => {
    const h = harness(); h.down(220); h.move(250); h.move(20); h.up(20);
    expect(h.moved).toEqual([30, -200]); expect(h.pressed).toEqual([]);
    h.down(20); h.move(220); h.up(220); expect(h.moved).toEqual([30, -200]);
  });
  test("theme exposes distinct control states and a complete shared chrome palette", () => {
    expect(XP_THEME.tab(true)).not.toBe(XP_THEME.tab(false));
    expect(XP_THEME.check(true)).not.toBe(XP_THEME.check(false));
    const classes = Object.values(XP_THEME).flatMap(part => typeof part === "string" ? [part] : [part(true), part(false)]);
    const compiled = compileClasses(classes);
    for (const part of classes) expect(compiled.ids[part]).toBeDefined();
  });
});
