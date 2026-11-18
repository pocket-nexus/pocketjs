// @pocketjs/framework/system-layers — what a system layer builds on.
//
// A system layer is guest code a product adds to an application's bundle
// (`tools/build.ts --layer=<module>`): the module is imported ahead of the
// application's entry, registers itself here, and render() mounts it after
// the application. A layer may rewrite the frame's input before the
// application reads it, pump a host namespace once per frame, hold the
// application's frame hooks while its own interface is open, and mount its
// handlers so they keep running then.
//
//   registerSystemLayer((ops) => { …mount…; return dispose; });
//
// The application imports nothing from this module.

export {
  registerSystemLayer,
  setFrameInputFilter,
  type FrameInput,
  type FrameInputFilter,
  type SystemLayer,
} from "./system-layers.ts";
/** A module pumped once per frame, before the application's frame hooks. */
export { registerServicePump } from "./services.ts";
/** `suspendApp(true)` holds the application's frame hooks; handlers mounted
 *  under `SystemFrameContext.Provider value={true}` keep running. */
export { isAppSuspended, suspendApp, SystemFrameContext } from "./frame.ts";
/** One contact as the host packs it into a frame's touch words: what a
 *  filter writes to play input. */
export { __packTouch as packTouch } from "./touch.ts";
/** The on-screen keyboard that is open, if any. */
export { openOsk, type OskController } from "./osk-controller.ts";
/** Spec values a layer needs to build nodes through the operations. */
export { ENUMS, SCREEN_H, SCREEN_W } from "../../contracts/spec/spec.ts";
