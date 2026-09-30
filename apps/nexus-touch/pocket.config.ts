// apps/nexus-touch — app-local Pocket config: the baked idle motion.
//
// Resting letters breathe like the homepage's: y = -0.018·FS·p and
// rotate = 0.8°·p with p = (1 - cos(1.65t + 0.68i)) / 2, a 3.8 s cycle whose
// phase steps 0.41 s per letter. Each letter gets its own delayed animation,
// which the core plays without per-frame JS. The pocket breathes and the
// hint's arrow nudges toward it.

import { definePocketConfig } from "@pocketjs/framework/config";
import { FS } from "./art.ts";
import { WORD } from "./scene.ts";

const PERIOD = Math.round((2 * Math.PI / 1.65) * 1000);
const STEP = Math.round((0.68 / 1.65) * 1000);
const rise = -(0.018 * FS).toFixed(2);

const animation: Record<string, { value: string }> = {};
for (let i = 0; i < WORD.length; i++) {
  animation[`bob-${i}`] = { value: `bob ${PERIOD}ms ease-in-out ${(i * STEP) % PERIOD}ms infinite both` };
}

export default definePocketConfig({
  theme: {
    keyframes: {
      bob: {
        from: { transform: "translateY(0px) rotate(0deg)" },
        "50%": { transform: `translateY(${rise}px) rotate(0.8deg)` },
        to: { transform: "translateY(0px) rotate(0deg)" },
      },
      // the pocket's resting breath: 1.4% taller, 0.7% narrower, 3.7 s
      breathe: {
        from: { transform: "scaleX(1) scaleY(1)" },
        "50%": { transform: "scaleX(0.993) scaleY(1.014)" },
        to: { transform: "scaleX(1) scaleY(1)" },
      },
      nudge: {
        from: { transform: "translateY(0px)" },
        "50%": { transform: "translateY(5px)" },
        to: { transform: "translateY(0px)" },
      },
    },
    animation: {
      ...animation,
      nudge: { value: "nudge 1300ms ease-in-out infinite both" },
      breathe: { value: "breathe 3700ms ease-in-out infinite both" },
    },
  },
});
