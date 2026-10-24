// PocketJS animation classes: what a changed frame costs on a target, read
// off its profile.
//
// A composited target (a GPU) draws every frame from retained geometry: a
// tween of `scale` over the whole page costs what a tween of `translateX`
// on one icon costs. A repaint target (a CPU rasterizer) pays for the pixels
// a change touches; its host moves the pixels of a translated opaque region
// and repaints the rest. A still target (electronic paper) shows one change
// per refresh. `deriveAnimationClass` is a pure function of the profile: the
// display's own class when it declares one, the platform's otherwise.
// Nothing registers a class.
//
// Applications read the class from `@pocketjs/framework/animation`
// (`animationClass`) and keep two sets of transitions where the costs
// differ. On a repaint target: translations of opaque regions and changes
// inside a small area at the tick rate; scale, opacity and rotation of a
// large subtree as a cut; no animation that runs while nothing happens.

import { ANIMATION_CLASSES, type AnimationClass, type TargetProfile } from "./platform-types.ts";

export { ANIMATION_CLASSES, type AnimationClass };

/** The class of each platform's stock renderer. */
export const ANIMATION_CLASS_BY_PLATFORM: Readonly<Record<string, AnimationClass>> = {
  psp: "composited", // GE
  vita: "composited", // GXM
  "3ds": "composited", // PICA
  ios: "composited", // Metal
  macos: "composited", // Metal
  web: "composited", // WebGPU/WebGL
  android: "composited", // GLES
  linux: "composited", // GLES
  "blackberry10-qnx": "composited", // GLES
  "esp-idf": "repaint", // software rasterizer with PPA fills and blits
  symbian: "repaint", // bitmap drawing
  wince: "repaint", // GDI bitmaps
  pocketbook: "still", // electronic paper
};

/** A platform the table does not list draws as a repaint target: its
 *  applications stay within what a CPU affords until the platform is
 *  listed. */
export const DEFAULT_ANIMATION_CLASS: AnimationClass = "repaint";

export function deriveAnimationClass(profile: TargetProfile): AnimationClass {
  return profile.display.animation ?? ANIMATION_CLASS_BY_PLATFORM[profile.platform] ?? DEFAULT_ANIMATION_CLASS;
}
