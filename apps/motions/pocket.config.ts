// apps/motions — app-local Pocket config.
//
// Keyframes ported 1:1 from yui540's motion studies (motions/53, /56, /30 and
// /64): durations, delays, easings and keyframe percentages match the
// extracted @emotion CSS; geometry is rebaked into absolute px for 154x121
// tiles laid out six-per-page like the original 2x3 grid (ours is 3x2 for the
// PSP's landscape screen).
//
// Every animation on a page shares that page's `loop` period, so all six
// tiles replay together — the in-engine equivalent of the original page
// remount.

import { definePocketConfig } from "@pocketjs/framework/config";

const SNAP = "cubic-bezier(0.77, 0.02, 0.25, 0.97)"; // motion/30 signature ease
const FLING = "cubic-bezier(0.04, 0.91, 0.51, 0.97)"; // slide-in / page-flip fling

const LOOP53 = "4000ms";
const LOOP56 = "4400ms";
const LOOP30 = "3200ms";
const LOOP64 = "5000ms";

// ---------------------------------------------------------------------------
// Reload arcs — the original draws an SVG circle stroke (dasharray 0->110,
// dashoffset 0->-130 over 1s) inside a container rotating 45->220deg with
// ease-in over 1.2s. Sampled at 0.2s stops, the combination becomes two
// baked tracks: arcStart = rotation + dashoffset angle, arcSweep = dash
// length. The sampled stops already encode both easings, so segments are
// linear.
// ---------------------------------------------------------------------------
const ARC_PCTS = ["0%", "16.7%", "33.3%", "50%", "66.7%", "83.3%", "100%"];
const ARC_START = [45, 129, 221, 323, 435, 547, 637];
const ARC_SWEEP = [0, 63, 126, 189, 252, 315, 315];
const arcKeyframes = (values: number[], prop: "arcStart" | "arcSweep") =>
  Object.fromEntries(ARC_PCTS.map((pct, i) => [pct, { [prop]: values[i] }]));

export default definePocketConfig({
  theme: {
    keyframes: {
      // ---- shared ----------------------------------------------------------
      "fade-in": { from: { opacity: 0 }, to: { opacity: 1 } },
      "fade-out": { from: { opacity: 1 }, to: { opacity: 0 } },

      // ================= motions/53 =========================================
      // menu: 38px pill opens to 128px revealing T/B/I items.
      "m53-menu-open": { from: { width: 38 }, "60%": { width: 144 }, to: { width: 141 } },
      "m53-menu-close": { from: { width: 141 }, "60%": { width: 31 }, to: { width: 38 } },
      "m53-menu-x-left": {
        from: { left: 7, rotate: 0 },
        "40%": { left: 17, rotate: 45 },
        to: { left: 17, rotate: 45 },
      },
      "m53-menu-x-right": {
        from: { left: 27, rotate: 0 },
        "40%": { left: 17, rotate: -45 },
        to: { left: 17, rotate: -45 },
      },
      "m53-menu-x-grow": {
        from: { top: 17, height: 5, backgroundColor: "#777" },
        "40%": { top: 17, height: 5 },
        "50%": { backgroundColor: "#ccc" },
        "70%": { top: 8, height: 23 },
        to: { top: 9, height: 21, backgroundColor: "#ccc" },
      },
      "m53-menu-x-left-out": {
        from: { left: 17, rotate: 45 },
        "50%": { left: 17, rotate: 45 },
        to: { left: 7, rotate: 0 },
      },
      "m53-menu-x-right-out": {
        from: { left: 17, rotate: -45 },
        "50%": { left: 17, rotate: -45 },
        to: { left: 27, rotate: 0 },
      },
      "m53-menu-x-shrink": {
        from: { top: 9, height: 21, backgroundColor: "#ccc" },
        "50%": { top: 17, height: 5, backgroundColor: "#777" },
        to: { top: 17, height: 5, backgroundColor: "#777" },
      },
      "m53-menu-item-in": {
        from: { translateY: 38 },
        "50%": { translateY: -2 },
        "75%": { translateY: 1 },
        to: { translateY: 0 },
      },
      "m53-menu-item-out": { from: { translateY: 0 }, to: { translateY: 46 } },

      // d-pad: pentagon keys (cap + same-color trapezoid base);
      // caps stretch away from the center, inner edges pinned.
      "m53-dpad-up": {
        "from,to": { top: 13, height: 24 },
        "50%": { top: 4, height: 33 },
        "75%": { top: 15, height: 22 },
      },
      "m53-dpad-down": {
        "from,to": { top: 67, height: 24 },
        "50%": { height: 33 },
        "75%": { height: 22 },
      },
      "m53-dpad-right": {
        "from,to": { left: 92, width: 24 },
        "50%": { width: 33 },
        "75%": { width: 22 },
      },
      "m53-dpad-left": {
        "from,to": { left: 38, width: 24 },
        "50%": { left: 29, width: 33 },
        "75%": { left: 40, width: 22 },
      },

      // share: the white card inflates from its bottom edge; the icon
      // box is FIXED (original keeps the logo pinned while the card grows).
      "m53-share-grow-a": {
        from: { left: 33, top: 34, width: 38, height: 38 },
        "50%": { left: 21, top: 10, width: 62, height: 62 },
        "75%": { left: 23, top: 14, width: 58, height: 58 },
        to: { left: 22, top: 12, width: 60, height: 60 },
      },
      "m53-share-shrink-a": {
        from: { left: 22, top: 12, width: 60, height: 60 },
        "50%": { left: 34, top: 36, width: 36, height: 36 },
        "75%": { left: 32, top: 33, width: 39, height: 39 },
        to: { left: 33, top: 34, width: 38, height: 38 },
      },
      "m53-share-grow-b": {
        from: { left: 83, top: 34, width: 38, height: 38 },
        "50%": { left: 71, top: 10, width: 62, height: 62 },
        "75%": { left: 73, top: 14, width: 58, height: 58 },
        to: { left: 72, top: 12, width: 60, height: 60 },
      },
      "m53-share-shrink-b": {
        from: { left: 72, top: 12, width: 60, height: 60 },
        "50%": { left: 84, top: 36, width: 36, height: 36 },
        "75%": { left: 82, top: 33, width: 39, height: 39 },
        to: { left: 83, top: 34, width: 38, height: 38 },
      },
      "m53-share-label-in": {
        from: { translateY: 16, opacity: 0 },
        "60%": { translateY: -1, opacity: 1 },
        to: { translateY: 0, opacity: 1 },
      },
      "m53-share-label-out": {
        from: { translateY: 0, opacity: 1 },
        to: { translateY: 16, opacity: 0 },
      },

      // hover button
      "m53-hover-lift": { from: { translateY: 0 }, to: { translateY: -1 } },
      "m53-hover-drop": { from: { translateY: -1 }, to: { translateY: 0 } },
      "m53-hover-arrow-in": {
        from: { width: 0 },
        "50%": { width: 27 },
        "75%": { width: 25 },
        to: { width: 26 },
      },
      "m53-hover-arrow-out": {
        from: { width: 26 },
        "50%": { width: 0 },
        "75%": { width: 2 },
        to: { width: 0 },
      },

      // reload: the arc draws on while winding 45 -> 220deg.
      "m53-arc-start": arcKeyframes(ARC_START, "arcStart"),
      "m53-arc-sweep": arcKeyframes(ARC_SWEEP, "arcSweep"),
      "m53-reload-icon": { from: { rotate: 0 }, to: { rotate: 360 } },
      "m53-arc-fade": {
        from: { opacity: 0 },
        "25%": { opacity: 1 },
        "58.3%": { opacity: 1 },
        "83.3%": { opacity: 0 },
        to: { opacity: 0 },
      },

      // keypad: center-preserving squish + inset top shadow
      // (approximated by a top gradient overlay fading in with the squish).
      "m53-key-squish": {
        "from,to": { left: 0, top: 0, width: 34, height: 34, borderRadius: 10 },
        "50%": { left: -7, top: 2, width: 48, height: 30, borderRadius: 17 },
        "75%": { left: 2, top: 0, width: 31, height: 33, borderRadius: 10 },
      },
      "m53-key-digit": {
        "from,to": { translateY: 0 },
        "50%": { translateY: 2 },
        "75%": { translateY: -1 },
      },

      // ================= motions/56 =========================================
      "m56-applaunch-in": {
        from: { top: 31, left: 62, width: 31 },
        to: { top: 0, left: 0, width: 154 },
      },
      "m56-applaunch-grow": { from: { height: 31 }, to: { height: 105 } },
      "m56-applaunch-back": {
        from: { top: 0, left: 0, width: 154, height: 105 },
        "50%": { top: 33, left: 63, width: 28, height: 28 },
        "75%": { top: 31, left: 61, width: 32, height: 32 },
        to: { top: 31, left: 62, width: 31, height: 31 },
      },
      "m56-applaunch-press": { "from,to": { scale: 1 }, "50%": { scale: 0.85 } },

      "m56-layout-left": { from: { width: 58 }, "60%": { width: 49 }, to: { width: 52 } },
      "m56-layout-left-close": { from: { width: 52 }, to: { width: 58 } },
      "m56-layout-right": {
        from: { left: 55, width: 58 },
        "60%": { left: 62, width: 50 },
        to: { left: 60, width: 53 },
      },
      "m56-layout-right-close": {
        from: { left: 60, width: 53 },
        to: { left: 55, width: 58 },
      },
      "m56-layout-half-top": {
        from: { height: 37, borderRadius: 0 },
        "60%": { height: 30, borderRadius: 10 },
        to: { height: 32, borderRadius: 10 },
      },
      "m56-layout-half-top-close": {
        from: { height: 32, borderRadius: 10 },
        to: { height: 37, borderRadius: 0 },
      },
      "m56-layout-half-bottom": {
        from: { top: 36, height: 37, borderRadius: 0 },
        "60%": { top: 43, height: 30, borderRadius: 10 },
        to: { top: 41, height: 32, borderRadius: 10 },
      },
      "m56-layout-half-bottom-close": {
        from: { top: 41, height: 32, borderRadius: 10 },
        to: { top: 36, height: 37, borderRadius: 0 },
      },
      "m56-layout-row-top": {
        from: { height: 25, borderRadius: 0 },
        "60%": { height: 19, borderRadius: 10 },
        to: { height: 20, borderRadius: 10 },
      },
      "m56-layout-row-top-close": {
        from: { height: 20, borderRadius: 10 },
        to: { height: 25, borderRadius: 0 },
      },
      "m56-layout-row-mid": {
        from: { top: 24, height: 25, borderRadius: 0 },
        "60%": { top: 28, height: 19, borderRadius: 10 },
        to: { top: 26, height: 20, borderRadius: 10 },
      },
      "m56-layout-row-mid-close": {
        from: { top: 26, height: 20, borderRadius: 10 },
        to: { top: 24, height: 25, borderRadius: 0 },
      },
      "m56-layout-row-bottom": {
        from: { top: 48, height: 25, borderRadius: 0 },
        "60%": { top: 54, height: 19, borderRadius: 10 },
        to: { top: 53, height: 20, borderRadius: 10 },
      },
      "m56-layout-row-bottom-close": {
        from: { top: 53, height: 20, borderRadius: 10 },
        to: { top: 48, height: 25, borderRadius: 0 },
      },

      "m56-shutter-open": { from: { height: 5 }, "60%": { height: 17 }, to: { height: 16 } },
      "m56-shutter-close": { from: { height: 16 }, "60%": { height: 4 }, to: { height: 5 } },

      "m56-fan-l2": { from: { rotate: 0 }, "60%": { rotate: -55 }, to: { rotate: -50 } },
      "m56-fan-l1": { from: { rotate: 0 }, "60%": { rotate: -27.5 }, to: { rotate: -25 } },
      "m56-fan-r1": { from: { rotate: 0 }, "60%": { rotate: 27.5 }, to: { rotate: 25 } },
      "m56-fan-r2": { from: { rotate: 0 }, "60%": { rotate: 55 }, to: { rotate: 50 } },
      "m56-fan-l2-close": { from: { rotate: -50 }, to: { rotate: 0 } },
      "m56-fan-l1-close": { from: { rotate: -25 }, to: { rotate: 0 } },
      "m56-fan-r1-close": { from: { rotate: 25 }, to: { rotate: 0 } },
      "m56-fan-r2-close": { from: { rotate: 50 }, to: { rotate: 0 } },
      "m56-fan-pulse": { "from,to": { scale: 1 }, "60%": { scale: 1.06 } },

      "m56-heave-1": {
        from: { width: 34, height: 29, top: 0, translateX: 0, backgroundColor: "#bbb" },
        "50%": { width: 67, height: 17, top: 12, translateX: 0, backgroundColor: "#ccc" },
        to: { width: 34, height: 29, top: 0, translateX: 34, backgroundColor: "#bbb" },
      },
      "m56-heave-2": {
        from: { width: 34, height: 29, top: 0, translateX: 34, backgroundColor: "#bbb" },
        "50%": { width: 67, height: 17, top: 12, translateX: 34, backgroundColor: "#ccc" },
        to: { width: 34, height: 29, top: 0, translateX: 67, backgroundColor: "#bbb" },
      },

      "m56-focus-hop-right": { from: { left: 0 }, to: { left: 37 } },
      "m56-focus-hop-left": { from: { left: 37 }, to: { left: -37 } },
      "m56-focus-stretch": { from: { left: -37, width: 34 }, to: { left: -37, width: 108 } },
      "m56-focus-snap": { from: { left: -37, width: 108 }, to: { left: 0, width: 34 } },
      "m56-focus-pulse": { "from,to": { inset: -6 }, "50%": { inset: -4 } },

      // ================= motions/30 =========================================
      "m30-reveal": { from: { scale: 1 }, to: { scale: 18 } },
      "m30-pop": { from: { scale: 0.2, opacity: 0 }, to: { scale: 1, opacity: 1 } },
      "m30-cell": { from: { opacity: 0, scale: 0.3 }, to: { opacity: 1, scale: 1 } },
      "m30-slide-down": { from: { translateY: -17 }, to: { translateY: 0 } },
      "m30-slide-up": { from: { translateY: 14 }, to: { translateY: 0 } },
      "m30-expand-w": {
        from: { left: 77, width: 0 },
        "50%": { left: 18, width: 119 },
        to: { left: 20, width: 113 },
      },
      "m30-expand-h": {
        from: { top: 44, height: 16 },
        "50%": { top: 10, height: 76 },
        to: { top: 12, height: 71 },
      },
      "m30-modal-pop": {
        from: { scale: 0.5, opacity: 0 },
        "50%": { scale: 1.04, opacity: 1 },
        to: { scale: 1, opacity: 1 },
      },
      "m30-jelly": {
        from: { scale: 0.7, opacity: 0 },
        "40%": { scale: 1.2, opacity: 1 },
        "60%": { scale: 1, opacity: 1 },
        "80%": { scale: 1.05, opacity: 1 },
        to: { scale: 1, opacity: 1 },
      },
      "m30-line": { from: { translateX: 14 }, to: { translateX: -14 } },
      "m30-comment": {
        from: { scale: 0.4, opacity: 0 },
        "50%": { scale: 1.15, opacity: 1 },
        to: { scale: 1, opacity: 1 },
      },
      "m30-slidein": {
        from: { translateY: 73, scale: 1.25, rotate: 20 },
        to: { translateY: 0, scale: 1, rotate: 0 },
      },
      "m30-zoom-in": {
        from: { scale: 1.4, opacity: 0 },
        "50%": { scale: 0.94, opacity: 1 },
        to: { scale: 1, opacity: 1 },
      },

      // ================= motions/64 (3D) ====================================
      "m64-door-open": {
        from: { rotateY: 0 },
        "60%": { rotateY: 110 },
        to: { rotateY: 105 },
      },
      "m64-door-close": { from: { rotateY: 105 }, to: { rotateY: 0 } },
      "m64-knob-turn": {
        from: { rotate: 0 },
        "60%": { rotate: 28 },
        to: { rotate: 25 },
      },
      "m64-knob-back": {
        from: { rotate: 25 },
        "60%": { rotate: -2 },
        to: { rotate: 0 },
      },
      "m64-spin": { from: { rotateY: 0 }, to: { rotateY: 360 } },
      "m64-tumble": {
        from: { rotateX: -40 },
        "60%": { rotateX: -225 },
        to: { rotateX: -220 },
      },
      "m64-tumble-back": {
        from: { rotateX: -220 },
        "60%": { rotateX: -35 },
        to: { rotateX: -40 },
      },
      "m64-rise": {
        from: { top: 48, height: 0 },
        "50%": { top: 8, height: 40 },
        "75%": { top: 17, height: 31 },
        to: { top: 14, height: 34 },
      },
      "m64-sink": { from: { top: 14, height: 34 }, to: { top: 48, height: 0 } },
      "m64-cap-rise": {
        from: { top: 31 },
        "50%": { top: -9 },
        "75%": { top: 0 },
        to: { top: -3 },
      },
      "m64-cap-sink": { from: { top: -3 }, to: { top: 31 } },
      "m64-stretch": {
        from: { rotateY: 0, left: 60, width: 34 },
        "60%": { rotateY: 33, left: 26, width: 102 },
        to: { rotateY: 30, left: 32, width: 90 },
      },
      "m64-shrink": {
        from: { rotateY: 30, left: 32, width: 90 },
        "60%": { rotateY: 0, left: 63, width: 28 },
        to: { rotateY: 0, left: 60, width: 34 },
      },
      "m64-flip-1": {
        from: { translateX: 0, rotate: 0, rotateY: 110, opacity: 0 },
        "30%": { opacity: 1 },
        to: { translateX: -36, rotate: 8, rotateY: 0, opacity: 1 },
      },
      "m64-flip-2": {
        from: { translateX: 28, rotate: 0, rotateY: 110, opacity: 0 },
        "30%": { opacity: 1 },
        to: { translateX: -10, rotate: -4, rotateY: 0, opacity: 1 },
      },
      "m64-flip-3": {
        from: { translateX: 55, rotate: 0, rotateY: 110, opacity: 0 },
        "30%": { opacity: 1 },
        to: { translateX: 18, rotate: 10, rotateY: 0, opacity: 1 },
      },
      "m64-room-shrink-1": { from: { scale: 1 }, "60%": { scale: 0.78 }, to: { scale: 0.8 } },
      "m64-room-turn-1": {
        from: { rotateY: 0 },
        "60%": { rotateY: -93 },
        to: { rotateY: -90 },
      },
      "m64-room-grow-1": { from: { scale: 0.8 }, "60%": { scale: 1.02 }, to: { scale: 1 } },
      "m64-room-shrink-2": { from: { scale: 1 }, "60%": { scale: 0.78 }, to: { scale: 0.8 } },
      "m64-room-turn-2": {
        from: { rotateY: -90 },
        "60%": { rotateY: 3 },
        to: { rotateY: 0 },
      },
      "m64-room-grow-2": { from: { scale: 0.8 }, "60%": { scale: 1.02 }, to: { scale: 1 } },
    },

    animation: {
      // ================= motions/53 (loop 4000ms) ===========================
      "m53-menu-pill": {
        value:
          "m53-menu-open 0.6s ease-in-out 0.2s both, " +
          "m53-menu-close 0.6s ease-in-out 1.2s forwards",
        loop: LOOP53,
      },
      "m53-menu-x-left": {
        value:
          "m53-menu-x-left 0.6s ease-in-out 0.2s both, " +
          "m53-menu-x-grow 0.6s ease-in-out 0.2s both, " +
          "m53-menu-x-left-out 0.35s ease-in-out 1.2s forwards, " +
          "m53-menu-x-shrink 0.35s ease-in-out 1.2s forwards",
        loop: LOOP53,
      },
      "m53-menu-x-right": {
        value:
          "m53-menu-x-right 0.6s ease-in-out 0.2s both, " +
          "m53-menu-x-grow 0.6s ease-in-out 0.2s both, " +
          "m53-menu-x-right-out 0.35s ease-in-out 1.2s forwards, " +
          "m53-menu-x-shrink 0.35s ease-in-out 1.2s forwards",
        loop: LOOP53,
      },
      "m53-menu-item-1": {
        value:
          "m53-menu-item-in 0.6s ease-in-out 0.25s both, " +
          "m53-menu-item-out 0.25s ease-in-out 1.3s forwards",
        loop: LOOP53,
      },
      "m53-menu-item-2": {
        value:
          "m53-menu-item-in 0.6s ease-in-out 0.3s both, " +
          "m53-menu-item-out 0.25s ease-in-out 1.25s forwards",
        loop: LOOP53,
      },
      "m53-menu-item-3": {
        value:
          "m53-menu-item-in 0.6s ease-in-out 0.35s both, " +
          "m53-menu-item-out 0.25s ease-in-out 1.2s forwards",
        loop: LOOP53,
      },
      // Strictly uniform rhythm: 0.5s per press, 8 slots = exactly the 4s
      // page loop, so the cadence is seamless across the wrap with no idle.
      "m53-dpad-up": {
        value:
          "m53-dpad-up 0.5s ease-in-out both, m53-dpad-up 0.5s ease-in-out 2s forwards",
        loop: LOOP53,
      },
      "m53-dpad-right": {
        value:
          "m53-dpad-right 0.5s ease-in-out 0.5s both, m53-dpad-right 0.5s ease-in-out 2.5s forwards",
        loop: LOOP53,
      },
      "m53-dpad-down": {
        value:
          "m53-dpad-down 0.5s ease-in-out 1s both, m53-dpad-down 0.5s ease-in-out 3s forwards",
        loop: LOOP53,
      },
      "m53-dpad-left": {
        value:
          "m53-dpad-left 0.5s ease-in-out 1.5s both, m53-dpad-left 0.5s ease-in-out 3.5s forwards",
        loop: LOOP53,
      },
      "m53-share-a": {
        value:
          "m53-share-grow-a 0.6s ease-in-out 0.2s both, " +
          "m53-share-shrink-a 0.5s ease-in-out 1.4s forwards",
        loop: LOOP53,
      },
      "m53-share-b": {
        value:
          "m53-share-grow-b 0.6s ease-in-out 2s both, " +
          "m53-share-shrink-b 0.5s ease-in-out 3s forwards",
        loop: LOOP53,
      },
      "m53-share-label-a": {
        value:
          "m53-share-label-in 0.4s ease-in-out 0.2s both, " +
          "m53-share-label-out 0.3s ease-in-out 1.2s forwards",
        loop: LOOP53,
      },
      "m53-share-label-b": {
        value:
          "m53-share-label-in 0.4s ease-in-out 2s both, " +
          "m53-share-label-out 0.3s ease-in-out 3s forwards",
        loop: LOOP53,
      },
      "m53-hover-btn": {
        value:
          "m53-hover-lift 0.3s ease-in-out 0.2s both, " +
          "m53-hover-drop 0.3s ease-in-out 1.4s forwards",
        loop: LOOP53,
      },
      "m53-hover-arrow": {
        value:
          "m53-hover-arrow-in 0.5s ease-in-out 0.2s both, " +
          "m53-hover-arrow-out 0.5s ease-in-out 1.4s forwards",
        loop: LOOP53,
      },
      "m53-arc-a": {
        value:
          "m53-arc-start 1.2s linear 0.2s both, " +
          "m53-arc-sweep 1.2s linear 0.2s both, " +
          "m53-arc-fade 1.2s linear 0.2s both",
        loop: LOOP53,
      },
      "m53-reload-icon-a": { value: "m53-reload-icon 0.8s ease-in-out 0.2s both", loop: LOOP53 },
      "m53-reload-icon-b": { value: "m53-reload-icon 0.8s ease-in-out 1.4s both", loop: LOOP53 },
      "m53-arc-b": {
        value:
          "m53-arc-start 1.2s linear 1.4s both, " +
          "m53-arc-sweep 1.2s linear 1.4s both, " +
          "m53-arc-fade 1.2s linear 1.4s both",
        loop: LOOP53,
      },
      "m53-key-1": { value: "m53-key-squish 0.6s ease-in-out 0.2s both", loop: LOOP53 },
      "m53-key-2": { value: "m53-key-squish 0.6s ease-in-out 0.8s both", loop: LOOP53 },
      "m53-key-3": { value: "m53-key-squish 0.6s ease-in-out 1.4s both", loop: LOOP53 },
      "m53-key-digit-1": { value: "m53-key-digit 0.6s ease-in-out 0.2s both", loop: LOOP53 },
      "m53-key-digit-2": { value: "m53-key-digit 0.6s ease-in-out 0.8s both", loop: LOOP53 },
      "m53-key-digit-3": { value: "m53-key-digit 0.6s ease-in-out 1.4s both", loop: LOOP53 },

      // ================= motions/56 (loop 4400ms) ===========================
      "m56-applaunch-box": {
        value:
          "m56-applaunch-in 0.2s ease-in-out 0.2s both, " +
          "m56-applaunch-grow 0.4s ease-in-out 0.3s forwards, " +
          "m56-applaunch-back 0.6s ease-in-out 1.4s forwards",
        loop: LOOP56,
      },
      "m56-applaunch-press": { value: "m56-applaunch-press 0.3s ease-in-out both", loop: LOOP56 },
      "m56-layout-p1": { value: "fade-out 0.05s ease-in-out 2.2s forwards", loop: LOOP56 },
      "m56-layout-left": {
        value:
          "m56-layout-left 0.5s ease-in-out 0.2s both, " +
          "m56-layout-left-close 0.25s ease-in-out 1.8s forwards",
        loop: LOOP56,
      },
      "m56-layout-right": {
        value:
          "m56-layout-right 0.5s ease-in-out 0.2s both, " +
          "m56-layout-right-close 0.25s ease-in-out 1.8s forwards",
        loop: LOOP56,
      },
      "m56-layout-half-top": {
        value:
          "m56-layout-half-top 0.5s ease-in-out 0.8s both, " +
          "m56-layout-half-top-close 0.25s ease-in-out 1.6s forwards",
        loop: LOOP56,
      },
      "m56-layout-half-bottom": {
        value:
          "m56-layout-half-bottom 0.5s ease-in-out 0.8s both, " +
          "m56-layout-half-bottom-close 0.25s ease-in-out 1.6s forwards",
        loop: LOOP56,
      },
      "m56-layout-p2": { value: "fade-in 0.05s ease-in-out 2.1s both", loop: LOOP56 },
      "m56-layout-row-top": {
        value:
          "m56-layout-row-top 0.5s ease-in-out 2.2s both, " +
          "m56-layout-row-top-close 0.25s ease-in-out 3.2s forwards",
        loop: LOOP56,
      },
      "m56-layout-row-mid": {
        value:
          "m56-layout-row-mid 0.5s ease-in-out 2.25s both, " +
          "m56-layout-row-mid-close 0.25s ease-in-out 3.2s forwards",
        loop: LOOP56,
      },
      "m56-layout-row-bottom": {
        value:
          "m56-layout-row-bottom 0.5s ease-in-out 2.3s both, " +
          "m56-layout-row-bottom-close 0.25s ease-in-out 3.2s forwards",
        loop: LOOP56,
      },
      "m56-shutter-1": {
        value:
          "m56-shutter-open 0.5s ease-in-out 0.2s both, " +
          "m56-shutter-close 0.5s ease-in-out 1.3s forwards",
        loop: LOOP56,
      },
      "m56-shutter-2": {
        value:
          "m56-shutter-open 0.5s ease-in-out 0.25s both, " +
          "m56-shutter-close 0.5s ease-in-out 1.35s forwards",
        loop: LOOP56,
      },
      "m56-shutter-3": {
        value:
          "m56-shutter-open 0.5s ease-in-out 0.3s both, " +
          "m56-shutter-close 0.5s ease-in-out 1.4s forwards",
        loop: LOOP56,
      },
      "m56-shutter-4": {
        value:
          "m56-shutter-open 0.5s ease-in-out 0.35s both, " +
          "m56-shutter-close 0.5s ease-in-out 1.45s forwards",
        loop: LOOP56,
      },
      "m56-fan-l2": {
        value:
          "m56-fan-l2 0.6s ease-in-out 0.1s both, m56-fan-l2-close 0.3s ease-in-out 1.1s forwards",
        loop: LOOP56,
      },
      "m56-fan-l1": {
        value:
          "m56-fan-l1 0.6s ease-in-out 0.2s both, m56-fan-l1-close 0.3s ease-in-out 1.2s forwards",
        loop: LOOP56,
      },
      "m56-fan-r1": {
        value:
          "m56-fan-r1 0.6s ease-in-out 0.2s both, m56-fan-r1-close 0.3s ease-in-out 1.2s forwards",
        loop: LOOP56,
      },
      "m56-fan-r2": {
        value:
          "m56-fan-r2 0.6s ease-in-out 0.1s both, m56-fan-r2-close 0.3s ease-in-out 1.1s forwards",
        loop: LOOP56,
      },
      "m56-fan-pulse": {
        value:
          "m56-fan-pulse 0.6s ease-in-out both, m56-fan-pulse 0.6s ease-in-out 1s forwards",
        loop: LOOP56,
      },
      "m56-heave": {
        value: "m56-heave-1 1.5s ease-in-out both, m56-heave-2 1.5s ease-in-out 1.7s forwards",
        loop: LOOP56,
      },
      "m56-focus-ring": {
        value:
          "m56-focus-hop-right 0.2s ease-in-out 0.2s both, " +
          "m56-focus-hop-left 0.2s ease-in-out 1.2s forwards, " +
          "m56-focus-stretch 0.2s ease-in-out 2.2s forwards, " +
          "m56-focus-snap 0.2s ease-in-out 3.2s forwards",
        loop: LOOP56,
      },
      "m56-focus-pulse": {
        value:
          "m56-focus-pulse 0.3s ease-in-out 0.4s both, " +
          "m56-focus-pulse 0.3s ease-in-out 1.4s forwards, " +
          "m56-focus-pulse 0.3s ease-in-out 2.4s forwards, " +
          "m56-focus-pulse 0.3s ease-in-out 3.4s forwards",
        loop: LOOP56,
      },

      // ================= motions/30 (loop 3200ms) ===========================
      "m30-reveal": { value: `m30-reveal 1s ${SNAP} 0.2s both`, loop: LOOP30 },
      "m30-reveal-cap": { value: "fade-in 0.05s linear 1.2s both", loop: LOOP30 },
      "m30-reveal-logo": { value: `m30-pop 0.5s ${SNAP} 0.7s both`, loop: LOOP30 },
      "m30-reveal-btn": { value: `m30-pop 0.5s ${SNAP} 0.9s both`, loop: LOOP30 },
      "m30-cell-a": { value: `m30-cell 0.6s ${SNAP} both`, loop: LOOP30 },
      "m30-cell-b": { value: `m30-cell 0.6s ${SNAP} 0.18s both`, loop: LOOP30 },
      "m30-cell-c": { value: `m30-cell 0.6s ${SNAP} 0.36s both`, loop: LOOP30 },
      "m30-grid-header": { value: `m30-slide-down 0.7s ${SNAP} 0.9s both`, loop: LOOP30 },
      "m30-grid-button": { value: `m30-slide-up 0.7s ${SNAP} 0.9s both`, loop: LOOP30 },
      "m30-grid-text": { value: "fade-in 0.3s linear 1.2s both", loop: LOOP30 },
      "m30-expand": {
        value:
          "m30-expand-w 0.6s ease-in-out 0.2s both, m30-expand-h 0.7s ease-in-out 0.8s both",
        loop: LOOP30,
      },
      "m30-expand-body": { value: "fade-in 0.3s linear 1.4s both", loop: LOOP30 },
      "m30-modal": { value: "m30-modal-pop 0.45s ease-in-out 0.2s both", loop: LOOP30 },
      "m30-modal-btn": { value: "m30-jelly 0.8s ease-in-out 0.5s both", loop: LOOP30 },
      "m30-line-1": {
        value: "m30-line 0.8s cubic-bezier(0.76, 0, 0.25, 0.97) 0.35s both",
        loop: LOOP30,
      },
      "m30-line-2": {
        value: "m30-line 0.8s cubic-bezier(0.76, 0, 0.25, 0.97) 0.5s both",
        loop: LOOP30,
      },
      "m30-comment-1": { value: "m30-comment 0.45s ease-in-out 0.2s both", loop: LOOP30 },
      "m30-comment-2": { value: "m30-comment 0.45s ease-in-out 0.45s both", loop: LOOP30 },
      "m30-bubble": { value: "m30-comment 0.45s ease-in-out 0.7s both", loop: LOOP30 },
      "m30-slidein-back": {
        value: `m30-slidein 0.9s ${FLING} 0.2s both, fade-in 0.6s ease-out 0.2s both`,
        loop: LOOP30,
      },
      "m30-slidein-front": {
        value: `m30-slidein 0.9s ${FLING} 0.5s both, fade-in 0.6s ease-out 0.5s both`,
        loop: LOOP30,
      },
      "m30-slidein-btn": { value: "m30-zoom-in 0.8s ease-in-out 1.1s both", loop: LOOP30 },

      // ================= motions/64 (loop 5000ms) ===========================
      "m64-door": {
        value:
          "m64-door-open 1s ease-in-out 0.4s both, m64-door-close 0.6s ease-in-out 1.8s forwards",
        loop: LOOP64,
      },
      "m64-knob": {
        value:
          "m64-knob-turn 0.4s ease-in-out 0.2s both, m64-knob-back 0.6s ease-in-out 2.2s forwards",
        loop: LOOP64,
      },
      "m64-spin": { value: "m64-spin 5s linear infinite both", loop: LOOP64 },
      "m64-tumble": {
        value:
          "m64-tumble 0.8s ease-in-out both, m64-tumble-back 0.8s ease-in-out 1.2s forwards",
        loop: LOOP64,
      },
      "m64-rise": {
        value: "m64-rise 0.7s ease-in-out 0.2s both, m64-sink 0.4s ease-in 1.2s forwards",
        loop: LOOP64,
      },
      "m64-cap": {
        value: "m64-cap-rise 0.7s ease-in-out 0.2s both, m64-cap-sink 0.4s ease-in 1.2s forwards",
        loop: LOOP64,
      },
      "m64-stretch": {
        value:
          "m64-stretch 0.6s ease-in-out 0.2s both, m64-shrink 0.6s ease-in-out 1.2s forwards",
        loop: LOOP64,
      },
      "m64-flip-1": { value: `m64-flip-1 1.2s ${FLING} 0.2s both`, loop: LOOP64 },
      "m64-flip-2": { value: `m64-flip-2 1.2s ${FLING} 0.4s both`, loop: LOOP64 },
      "m64-flip-3": { value: `m64-flip-3 1.2s ${FLING} 0.6s both`, loop: LOOP64 },
      "m64-room": {
        value:
          "m64-room-shrink-1 0.4s ease-in-out 0.2s both, " +
          "m64-room-turn-1 0.55s ease-in-out 0.6s forwards, " +
          "m64-room-grow-1 0.4s ease-in-out 1.15s forwards, " +
          "m64-room-shrink-2 0.4s ease-in-out 2s forwards, " +
          "m64-room-turn-2 0.55s ease-in-out 2.4s forwards, " +
          "m64-room-grow-2 0.4s ease-in-out 2.95s forwards",
        loop: LOOP64,
      },
    },
  },
});
