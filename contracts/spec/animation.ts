// PocketJS animation classes: what a changed frame costs on a target.
//
// A composited target (a GPU) draws every frame from retained geometry: a
// tween of `scale` over the whole page costs what a tween of `translateX`
// on one icon costs. A repaint target (a CPU rasterizer) pays for the pixels
// a change touches; its host moves the pixels of a translated opaque region
// and repaints the rest. A still target (electronic paper) shows one change
// per refresh. Every host contract states its class in
// `display.animation`; the compiler copies it into the plan, and a device
// admits only packages compiled for its own class.
//
// Applications read the class from `@pocketjs/framework/animation`
// (`animationClass`) and keep two sets of transitions where the costs
// differ. On a repaint target: translations of opaque regions and changes
// inside a small area at the tick rate; scale, opacity and rotation of a
// large subtree as a cut; no animation that runs while nothing happens.
//
// Guest bundles import this module at run time (framework/src/anim.ts), so it
// imports nothing: the capability registry and the host contracts stay out
// of every bundle.

/**
 * What a changed frame costs a target — a semantic FIELD of its display:
 *
 * - "composited": a GPU composes every frame from retained geometry; a prop
 *                 change on any subtree costs the same at the tick rate.
 * - "repaint":    a CPU repaints the pixels a change touched; a frame costs
 *                 in proportion to that area, and the host moves the pixels
 *                 of a translated opaque region instead of repainting them.
 * - "still":      the display shows one change per refresh (electronic
 *                 paper); a tween is its end value.
 *
 * Every profile states its class (`display.animation`); the compiler bakes
 * it into the plan and devices admit packages compiled for their own class.
 */
export const ANIMATION_CLASSES = ["composited", "repaint", "still"] as const;
export type AnimationClass = (typeof ANIMATION_CLASSES)[number];
