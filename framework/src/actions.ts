// Declared intents (@pocketjs/framework/actions).
//
// A presentation declares what a screen can do, not which button does it.
// The buttons modality binds each intent to the device's face buttons and
// spells a legend with the shell's own glyphs (docs/HIG.md §1, §2.3); a
// touch presentation reads the same entries to render its tiles.
//
//   const actions = useActions(() => ({
//     confirm: { label: "play" },                       // legend only: the focused row's onPress is the confirm
//     action:  { label: "search", run: () => osk.open() },
//     option:  { label: "save", run: save, hold: { label: "delete", run: remove } },
//     back:    { run: () => store.stopPlayback() },
//   }));
//   <ClassicFooter text={actions.legend()} />
//
// `run` is optional: an intent with a label and no `run` appears in the
// legend while the focus system delivers the press (CIRCLE on a Focusable).
// A `hold` variant fires after 0.4 s of holding the button; the tap variant
// then fires on release only when the hold did not.

import type { Accessor } from "solid-js";
import { BTN } from "../../contracts/spec/spec.ts";
import type { ButtonName } from "../../contracts/spec/modality.ts";
import { simulationHz } from "./clock.ts";
import { onFrame } from "./frame.ts";
import { glyph, modality } from "./modality.ts";

export const ACTION_INTENTS = ["confirm", "back", "action", "option", "sectionPrev", "sectionNext", "media"] as const;
export type ActionIntent = (typeof ACTION_INTENTS)[number];

export interface ActionSpec {
  /** Legend text; an intent without a label stays out of the legend. */
  label?: string;
  run?: () => void;
  /** Fires after holding the button HOLD_SECONDS; the tap `run` then stays silent. */
  hold?: { label: string; run: () => void };
  /** Gate the binding (and the legend entry) on live state. Default on. */
  when?: () => boolean;
}

export type ActionMap = Partial<Record<ActionIntent, ActionSpec>>;

export interface ActionEntry {
  intent: ActionIntent;
  /** The device's label for the button ("○" on a PSP, "A" on a 3DS). */
  glyph: string;
  label: string;
  run?: () => void;
  hold?: { label: string; run: () => void };
}

export interface ActionsHandle {
  /** "○ play · △ search", in ACTION_INTENTS order, with the device's glyphs. */
  legend: Accessor<string>;
  /** The bound intents, for a touch presentation's tiles. */
  entries: Accessor<readonly ActionEntry[]>;
  run(intent: ActionIntent): void;
}

/** The buttons modality's binding: intent -> BTN mask and shell glyph. */
export const ACTION_BUTTONS: Readonly<Record<ActionIntent, { readonly mask: number; readonly button: ButtonName }>> = {
  confirm: { mask: BTN.CIRCLE, button: "circle" },
  back: { mask: BTN.CROSS, button: "cross" },
  action: { mask: BTN.TRIANGLE, button: "triangle" },
  option: { mask: BTN.SQUARE, button: "square" },
  sectionPrev: { mask: BTN.LTRIGGER, button: "ltrigger" },
  sectionNext: { mask: BTN.RTRIGGER, button: "rtrigger" },
  media: { mask: BTN.START, button: "start" },
};

/** Holding a button this long fires the intent's `hold` variant (virtual seconds). */
export const HOLD_SECONDS = 0.4;

export interface UseActionsOptions {
  /** Keep binding while a modal owns input (system handlers only). */
  allowWhenBlocked?: boolean;
}

export function useActions(actions: ActionMap | Accessor<ActionMap>, options: UseActionsOptions = {}): ActionsHandle {
  const map = (): ActionMap => (typeof actions === "function" ? actions() : actions);
  const live = (spec: ActionSpec | undefined): spec is ActionSpec => !!spec && (spec.when ? spec.when() : true);

  // Plain accessors, not memos: a `when` that reads live state (a signal,
  // or a value the caller flips) must be re-read wherever the legend is
  // rendered, and seven intents cost nothing to walk.
  const entries = (): readonly ActionEntry[] => {
    const current = map();
    const out: ActionEntry[] = [];
    for (const intent of ACTION_INTENTS) {
      const spec = current[intent];
      if (!live(spec) || !spec.label) continue;
      out.push({ intent, glyph: glyph(ACTION_BUTTONS[intent].button), label: spec.label, run: spec.run, hold: spec.hold });
    }
    return out;
  };

  const legend = (): string => {
    if (!modality.buttons) return "";
    const parts: string[] = [];
    const current = entries();
    // L and R with the same label read as one "L/R label" entry.
    const prev = current.find((entry) => entry.intent === "sectionPrev");
    const next = current.find((entry) => entry.intent === "sectionNext");
    for (const entry of current) {
      if (entry.intent === "sectionNext" && prev && prev.label === entry.label) continue;
      if (entry.intent === "sectionPrev" && next && next.label === entry.label) {
        parts.push(`${entry.glyph}/${next.glyph} ${entry.label}`);
        continue;
      }
      parts.push(entry.hold ? `${entry.glyph} ${entry.label} · hold ${entry.hold.label}` : `${entry.glyph} ${entry.label}`);
    }
    return parts.join(" · ");
  };

  // One frame hook binds every intent: press edges, and the hold timer for
  // intents that declare a hold variant. Blocked handlers stay silent while
  // a modal (the keyboard, a sheet) owns input, like onButtonPress.
  const held = new Map<ActionIntent, number>();
  let previous = 0;
  if (modality.buttons) {
    onFrame((buttons) => {
      const pressed = buttons & ~previous;
      const released = previous & ~buttons;
      previous = buttons;
      const blocked = !options.allowWhenBlocked && isButtonHandlerBlocked();
      const current = map();
      const holdFrames = Math.max(1, Math.round(HOLD_SECONDS * simulationHz()));
      for (const intent of ACTION_INTENTS) {
        const { mask } = ACTION_BUTTONS[intent];
        const spec = current[intent];
        if (pressed & mask) {
          if (blocked || !live(spec)) continue;
          if (spec.hold) held.set(intent, 0);
          else spec.run?.();
        }
        if (held.has(intent)) {
          if (buttons & mask) {
            const frames = held.get(intent)! + 1;
            held.set(intent, frames);
            if (frames === holdFrames) {
              held.delete(intent);
              if (!blocked && live(spec)) spec.hold?.run();
            }
          } else if (released & mask) {
            held.delete(intent);
            if (!blocked && live(spec)) spec.run?.();
          }
        }
      }
    });
  }

  return {
    legend,
    entries,
    run(intent) {
      const spec = map()[intent];
      if (live(spec)) spec.run?.();
    },
  };
}

// The button-handler block is owned by frame.ts; read it through the same
// module so a keyboard or sheet mutes declared intents the way it mutes
// onButtonPress handlers.
import { isButtonHandlerBlocked } from "./frame.ts";
