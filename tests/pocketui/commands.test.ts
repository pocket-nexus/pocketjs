import { describe, expect, test } from "bun:test";
import { bindCommands, legendOf, normalizeChord, searchCommands, type Command } from "../../framework/src/pocketui/core/commands.ts";

const run = () => {};
const app: Command[] = [
  { id: "new", title: "New Session", short: "New", button: "action", key: "Control+n", bar: true, run },
  { id: "menu", title: "Commands", short: "Menu", button: "option", run },
  { id: "settings", title: "Settings", key: "Control+,", run },
];
const session: Command[] = [
  { id: "stop", title: "Stop the Agent", short: "Stop", button: "action", bar: true, destructive: true, run },
  { id: "archive", title: "Archive", key: "Ctrl+Alt+A", run },
  { id: "info", title: "Session Info", bar: true, run },
];
const scopes = (stopDisabled = false) => [
  { id: "app", commands: () => app },
  { id: "session", commands: () => session.map((c) => (c.id === "stop" ? { ...c, disabled: stopDisabled } : c)) },
];

describe("bindCommands", () => {
  test("a gamepad: the inner scope takes the button, everything is in the menu", () => {
    const bound = bindCommands(scopes(), { buttons: true, bar: false, keys: false });
    expect(bound.buttons.action?.id).toBe("stop");
    expect(bound.buttons.option?.id).toBe("menu");
    expect(bound.bar).toEqual([]);
    expect(bound.menu.map((c) => c.id)).toEqual(["stop", "archive", "info", "new", "menu", "settings"]);
    expect(legendOf(bound, [{ intent: "confirm", label: "Open" }])).toEqual([
      { intent: "confirm", label: "Open" },
      { intent: "action", label: "Stop" },
      { intent: "option", label: "Menu" },
    ]);
  });
  test("a disabled command gives its button to the scope outside", () => {
    const bound = bindCommands(scopes(true), { buttons: true, bar: false, keys: false });
    expect(bound.buttons.action?.id).toBe("new");
    expect(bound.all.find((c) => c.id === "stop")?.disabled).toBe(true);
  });
  test("a touch surface: bar controls, the rest in the menu", () => {
    const bound = bindCommands(scopes(), { buttons: false, bar: true, keys: false });
    expect(bound.buttons).toEqual({});
    expect(bound.bar.map((c) => c.id)).toEqual(["stop", "info"]);
    expect(bound.menu.map((c) => c.id)).toEqual(["archive", "new", "menu", "settings"]);
  });
  test("a keyboard: chords, normalized", () => {
    const bound = bindCommands(scopes(), { buttons: false, bar: true, keys: true });
    expect([...bound.keys.keys()]).toEqual(["Control+Alt+a", "Control+n", "Control+,"]);
    expect(normalizeChord("Shift+Ctrl+K")).toBe("Control+Shift+k");
  });
});

test("searchCommands ranks word starts first and needs every word", () => {
  const items = [{ title: "Restart Session" }, { title: "New Session" }, { title: "Session Info" }, { title: "Archive" }];
  expect(searchCommands(items, "ses").map((i) => i.title)).toEqual(["Session Info", "New Session", "Restart Session"]);
  expect(searchCommands(items, "new ses").map((i) => i.title)).toEqual(["New Session"]);
  expect(searchCommands(items, "").length).toBe(4);
});
