// apps/sortie — app-local Pocket config: the MV's whole motion vocabulary.
//
// The picture is cut at 150 BPM, so one beat is 400 ms and one bar 1600 ms.
// Every duration and delay below is a multiple or a clean subdivision of that
// beat, which is why the cuts land on the downbeats of ./gen-score.ts without
// either side knowing about the other: both are derived from the same grid.
//
// Nothing here is sampled by JavaScript. A cut mounts its nodes, the core
// starts their timelines at frame 0 (engine/core/src/lib.rs `restart_timelines`)
// and samples them once per tick until the next cut. The only per-frame guest
// work in the whole MV is the audio pump in ./app.tsx, and hosts without the
// audio module skip even that.

import { definePocketConfig } from "@pocketjs/framework/config";

/** The slam: a hard, slightly overshooting arrival. Used on every title card. */
const HIT = "cubic-bezier(0.16, 0.9, 0.24, 1)";
/** Mechanical: constant-speed readouts, sweeps and stripes. */
const LINEAR = "linear";

export default definePocketConfig({
  theme: {
    keyframes: {
      // ---- arrivals --------------------------------------------------------
      // A card lands from 45% oversize with the ink already at full strength
      // by the time it stops moving: the eye reads the shape, then the edges.
      "sv-slam": {
        from: { opacity: 0, transform: "scale(1.45)" },
        "55%": { opacity: 1 },
        to: { opacity: 1, transform: "scale(1)" },
      },
      "sv-in-left": {
        from: { opacity: 0, transform: "translateX(-40px)" },
        to: { opacity: 1, transform: "translateX(0px)" },
      },
      "sv-in-right": {
        from: { opacity: 0, transform: "translateX(40px)" },
        to: { opacity: 1, transform: "translateX(0px)" },
      },
      "sv-in-up": {
        from: { opacity: 0, transform: "translateY(12px)" },
        to: { opacity: 1, transform: "translateY(0px)" },
      },
      "sv-fade": { from: { opacity: 0 }, to: { opacity: 1 } },

      // ---- rules and gauges ------------------------------------------------
      // Rules grow on scaleX from an `origin-left` node, so a 320 px rule and a
      // 40 px tick share one timeline and neither one relayouts.
      "sv-draw": {
        from: { transform: "scaleX(0)" },
        to: { transform: "scaleX(1)" },
      },
      "sv-draw-y": {
        from: { transform: "scaleY(0)" },
        to: { transform: "scaleY(1)" },
      },

      // ---- light -----------------------------------------------------------
      "sv-flash": { from: { opacity: 0.55 }, to: { opacity: 0 } },
      // The fleet cuts once per beat; its flash stays well under the negations'.
      "sv-flash-soft": { from: { opacity: 0.3 }, to: { opacity: 0 } },
      // The zero beat is the one full-white frame in the whole MV.
      "sv-blowout-k": { from: { opacity: 1 }, "30%": { opacity: 1 }, to: { opacity: 0 } },
      // Two frames of white, then black: the cut itself, not a transition.
      "sv-strobe": {
        from: { opacity: 0.5 },
        "12%": { opacity: 0.08 },
        "24%": { opacity: 0.32 },
        "36%": { opacity: 0.08 },
        to: { opacity: 0.08 },
      },
      "sv-blink": {
        from: { opacity: 1 },
        "49%": { opacity: 1 },
        "50%": { opacity: 0 },
        to: { opacity: 0 },
      },
      // The field ring leaving: a shockwave out of the numeral.
      "sv-ping": {
        from: { opacity: 0.55, transform: "scale(0.4)" },
        "70%": { opacity: 0.16 },
        to: { opacity: 0, transform: "scale(2.6)" },
      },
      "sv-breathe": {
        from: { transform: "scale(1)", opacity: 0.1 },
        "50%": { transform: "scale(1.05)", opacity: 0.2 },
        to: { transform: "scale(1)", opacity: 0.1 },
      },

      // ---- continuous ------------------------------------------------------
      "sv-sweep": {
        from: { transform: "translateY(-16px)" },
        to: { transform: "translateY(284px)" },
      },
      // One hazard tile is 32 px of stripe pitch; travelling exactly one pitch
      // per iteration makes the belt seamless at any duration.
      "sv-stripe": {
        from: { transform: "translateX(0px)" },
        to: { transform: "translateX(-32px)" },
      },
      "sv-drift": {
        from: { transform: "translateY(0px)" },
        to: { transform: "translateY(-16px)" },
      },
      // Interference: three frames off the grid, then back, twice a beat.
      "sv-jitter": {
        from: { transform: "translateX(0px)" },
        "6%": { transform: "translateX(-4px)" },
        "9%": { transform: "translateX(5px)" },
        "12%": { transform: "translateX(0px)" },
        "58%": { transform: "translateX(0px)" },
        "61%": { transform: "translateX(3px)" },
        "64%": { transform: "translateX(0px)" },
        to: { transform: "translateX(0px)" },
      },
      // The reticle: a stroke arc drawn and released, the arc primitive doing
      // what an SVG dasharray does on the web (/docs/animation/#arcs).
      "sv-reticle": {
        from: { arcStart: -90, arcSweep: 0 },
        "60%": { arcSweep: 300 },
        to: { arcStart: 270, arcSweep: 300 },
      },
      "sv-spin": {
        from: { arcStart: 0, arcSweep: 70 },
        to: { arcStart: 360, arcSweep: 70 },
      },
    },

    animation: {
      // ---- title cards -----------------------------------------------------
      "sv-card": { value: `sv-slam 140ms ${HIT} both` },
      "sv-numeral": { value: `sv-slam 120ms ${HIT} both` },
      "sv-ping-out": { value: "sv-ping 700ms ease-out both" },

      // ---- staggered readouts ---------------------------------------------
      // One keyframe, eight delays: the HUD types itself in without a timer.
      "sv-line-1": { value: "sv-in-left 180ms ease-out 60ms both" },
      "sv-line-2": { value: "sv-in-left 180ms ease-out 200ms both" },
      "sv-line-3": { value: "sv-in-left 180ms ease-out 340ms both" },
      "sv-line-4": { value: "sv-in-left 180ms ease-out 480ms both" },
      "sv-line-5": { value: "sv-in-left 180ms ease-out 620ms both" },
      "sv-line-6": { value: "sv-in-left 180ms ease-out 760ms both" },
      "sv-line-7": { value: "sv-in-left 180ms ease-out 900ms both" },
      "sv-line-8": { value: "sv-in-left 180ms ease-out 1040ms both" },

      // The stack: four slabs, one per beat-quarter, alternating sides.
      "sv-slab-1": { value: `sv-in-left 200ms ${HIT} 100ms both` },
      "sv-slab-2": { value: `sv-in-right 200ms ${HIT} 300ms both` },
      "sv-slab-3": { value: `sv-in-left 200ms ${HIT} 500ms both` },
      "sv-slab-4": { value: `sv-in-right 200ms ${HIT} 700ms both` },
      "sv-rise-1": { value: "sv-in-up 200ms ease-out 200ms both" },
      "sv-rise-2": { value: "sv-in-up 200ms ease-out 400ms both" },
      "sv-rise-3": { value: "sv-in-up 200ms ease-out 600ms both" },
      "sv-late": { value: "sv-fade 200ms ease-out 900ms both" },
      "sv-quick": { value: "sv-fade 60ms ease-out both" },
      // A one-beat cut is 400 ms: a second line has to arrive inside it, which
      // `sv-late` (900 ms) cannot do. The fleet and the negations use this.
      "sv-mid": { value: "sv-fade 100ms ease-out 160ms both" },

      // ---- rules -----------------------------------------------------------
      "sv-rule": { value: `sv-draw 240ms ${HIT} 80ms both` },
      "sv-rule-late": { value: `sv-draw 240ms ${HIT} 420ms both` },
      // The sync gauge: two beats of travel, settling exactly on the downbeat.
      "sv-gauge": { value: "sv-draw 800ms ease-out 300ms both" },

      // ---- light -----------------------------------------------------------
      "sv-cut-flash": { value: `sv-flash 120ms ${LINEAR} both` },
      "sv-unit-flash": { value: `sv-flash-soft 80ms ${LINEAR} both` },
      "sv-blowout": { value: `sv-blowout-k 320ms ${LINEAR} 480ms forwards` },
      "sv-alarm": { value: `sv-strobe 800ms ${LINEAR} infinite` },
      "sv-warn": { value: `sv-blink 400ms ${LINEAR} infinite` },

      // ---- continuous ------------------------------------------------------
      "sv-scanline": { value: `sv-sweep 1600ms ${LINEAR} infinite` },
      "sv-belt": { value: `sv-stripe 800ms ${LINEAR} infinite` },
      "sv-parallax": { value: `sv-drift 3200ms ${LINEAR} infinite` },
      "sv-field": { value: "sv-breathe 1600ms ease-in-out infinite" },
      "sv-interference": { value: `sv-jitter 1600ms ${LINEAR} infinite` },
      "sv-lock": { value: "sv-reticle 900ms ease-in-out both" },
      "sv-radar": { value: `sv-spin 1600ms ${LINEAR} infinite` },

      // ---- cross -----------------------------------------------------------
      // The zero beat: a bar of light across, then up, then the blowout.
      "sv-cross-h": { value: `sv-draw 140ms ${HIT} 300ms both` },
      "sv-cross-v": { value: `sv-draw-y 180ms ${HIT} 360ms both` },
    },
  },
});
