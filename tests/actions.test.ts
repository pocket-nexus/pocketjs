// tests/actions.test.ts — declared intents: the legend a presentation gets
// for free and the button table behind it. Binding runs through onFrame,
// which the sim journeys in pocket-youtube exercise; this file pins the
// pure surface.

import { describe, expect, test } from "bun:test";
import { createRoot } from "solid-js";
import { BTN } from "../contracts/spec/spec.ts";
import { ACTION_BUTTONS, ACTION_INTENTS, useActions } from "../framework/src/actions.ts";

describe("useActions", () => {
  test("binds every intent to one face button", () => {
    expect(Object.keys(ACTION_BUTTONS).sort()).toEqual([...ACTION_INTENTS].sort());
    expect(ACTION_BUTTONS.confirm.mask).toBe(BTN.CIRCLE);
    expect(ACTION_BUTTONS.back.mask).toBe(BTN.CROSS);
    expect(ACTION_BUTTONS.action.mask).toBe(BTN.TRIANGLE);
    expect(ACTION_BUTTONS.option.mask).toBe(BTN.SQUARE);
    expect(ACTION_BUTTONS.media.mask).toBe(BTN.START);
  });

  test("the legend lists labelled intents in intent order with the device's glyphs", () => {
    createRoot((dispose) => {
      const actions = useActions({
        back: { label: "back", run: () => {} },
        action: { label: "search", run: () => {} },
        confirm: { label: "play" },
        option: { label: "save", run: () => {}, hold: { label: "delete", run: () => {} } },
      });
      // The portable modality is a PSP: PlayStation glyphs.
      expect(actions.legend()).toBe("○ play · × back · △ search · □ save · hold delete");
      expect(actions.entries().map((entry) => entry.intent)).toEqual(["confirm", "back", "action", "option"]);
      dispose();
    });
  });

  test("L and R with one label read as one entry; unlabelled and gated intents stay out", () => {
    createRoot((dispose) => {
      let on = false;
      const actions = useActions(() => ({
        sectionPrev: { label: "±10 s", run: () => {} },
        sectionNext: { label: "±10 s", run: () => {} },
        media: { run: () => {} },
        back: { label: "back", run: () => {}, when: () => on },
      }));
      expect(actions.legend()).toBe("L/R ±10 s");
      on = true;
      expect(actions.legend()).toBe("× back · L/R ±10 s");
      dispose();
    });
  });

  test("run() fires the intent's tap variant when it is live", () => {
    createRoot((dispose) => {
      let fired = 0;
      const actions = useActions({ action: { label: "search", run: () => fired++ }, back: { run: () => fired += 10, when: () => false } });
      actions.run("action");
      actions.run("back");
      expect(fired).toBe(1);
      dispose();
    });
  });
});
