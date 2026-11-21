// The default activation recognizer (docs/TOUCH.md §0): a whole-screen,
// LOWEST-priority tap gesture that turns "tap on any focusable" into the
// same pressNode pipeline CIRCLE presses and cursor clicks enter — with the
// `active:` pressed look held from the down edge, exactly like a d-pad
// press. This is what makes a bare `<Focusable onPress={…}>` a button on
// touch hosts with zero component wiring.
//
// Priority: index.ts installs this FIRST at mount, and gesture priority is
// last-registered-first — so any component with a richer touch model
// (VirtualList rows, the OSK's key handling) registers later and wins taps
// outright; a pan claim anywhere cancels the pressed look through the
// standard onCancel path. During a modal touch block (the OSK) this
// recognizer is inert like every non-exempt one. On hosts without touch the
// pump never delivers a contact and the recognizer costs nothing.

import { createGesture, type GestureHandle } from "./gesture.ts";
import { pressNode, setActiveNode, touchFocusable } from "./input.ts";

export function installTouchActivation(): GestureHandle {
  const install = (surface: "primary" | "auxiliary") => createGesture({
    surface,
    onDown: (c) => {
      const target = touchFocusable(c.x, c.y, c.hit, c.surface);
      if (target) setActiveNode(target);
    },
    onTap: (c) => {
      setActiveNode(null);
      const target = touchFocusable(c.x, c.y, c.hit, c.surface);
      if (target) pressNode(target);
    },
    onUp: () => setActiveNode(null),
    onCancel: () => setActiveNode(null),
  });
  const primary = install("primary");
  const auxiliary = install("auxiliary");
  return {
    dispose() {
      primary.dispose();
      auxiliary.dispose();
    },
    cancel() {
      primary.cancel();
      auxiliary.cancel();
    },
    get panning() {
      return primary.panning || auxiliary.panning;
    },
    get pinching() {
      return primary.pinching || auxiliary.pinching;
    },
  };
}
