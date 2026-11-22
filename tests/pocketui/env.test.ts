import { describe, expect, test } from "bun:test";
import { deriveEnvironment, resolveIdioms } from "../../framework/src/pocketui/core/env.ts";

const thor = deriveEnvironment({ width: 618, height: 304, touch: true, buttons: true, pointer: false, keyboard: false, analog: 2, hostKeyboard: true, glyphs: "runtime" });
const psp = deriveEnvironment({ width: 480, height: 272, touch: false, buttons: true, pointer: false, keyboard: false, analog: 1 });
const ds = deriveEnvironment({ width: 320, height: 240, touch: true, buttons: true, pointer: false, keyboard: false, analog: 1 });
const uconsole = deriveEnvironment({ width: 640, height: 360, touch: true, buttons: true, pointer: true, keyboard: true, analog: 0 });
const paper = deriveEnvironment({ width: 480, height: 320, touch: true, buttons: false, pointer: false, keyboard: false, analog: 0, motion: "still" });
const desktop = deriveEnvironment({ width: 1100, height: 700, touch: true, buttons: false, pointer: true, keyboard: true, analog: 0 });

describe("the same application on six surfaces", () => {
  test("a Thor window: list beside detail, typed in place on the panel below, dragged", () => {
    const idioms = resolveIdioms(thor);
    expect(thor.size).toEqual({ width: "expanded", height: "regular" });
    expect(thor.text).toBe("host");
    expect(idioms).toMatchObject({ panes: "split", focus: true, compose: "inline", transfer: "drag", transition: "follow", density: "regular", content: "full" });
    expect(idioms.commands).toEqual({ legend: true, bar: true, shortcuts: false, menu: "sheet" });
  });
  test("a PSP: one pane, a legend, a keyboard it draws, things carried by a button", () => {
    const idioms = resolveIdioms(psp);
    expect(psp.tier).toBe("retro");
    expect(idioms).toMatchObject({ panes: "stack", focus: true, compose: "dock", transfer: "carry", transition: "animate", density: "compact" });
    expect(idioms.commands).toEqual({ legend: true, bar: false, shortcuts: false, menu: "sheet" });
  });
  test("a 3DS touch screen: one pane in tight rows, the bar's controls instead of a legend", () => {
    const idioms = resolveIdioms(ds);
    expect(idioms).toMatchObject({ panes: "stack", compose: "dock", transfer: "drag", density: "compact" });
    expect(idioms.commands.legend).toBe(false);
    expect(idioms.commands.bar).toBe(true);
  });
  test("a uConsole: split, shortcuts, popover menus", () => {
    const idioms = resolveIdioms(uconsole);
    expect(uconsole.text).toBe("keyboard");
    expect(idioms).toMatchObject({ panes: "split", compose: "inline" });
    expect(idioms.commands).toEqual({ legend: true, bar: true, shortcuts: true, menu: "popover" });
  });
  test("an e-paper panel: no motion, plain content", () => {
    const idioms = resolveIdioms(paper);
    expect(paper.tier).toBe("micro");
    expect(idioms).toMatchObject({ panes: "stack", focus: false, transition: "cut", content: "plain" });
  });
  test("a desktop window: three panes", () => {
    expect(resolveIdioms(desktop).panes).toBe("triple");
  });
});
