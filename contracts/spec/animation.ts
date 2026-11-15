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

export { ANIMATION_CLASSES, type AnimationClass } from "./platform-types.ts";
