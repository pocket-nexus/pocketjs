// @pocketjs/framework/applet — the surface a Pocket Applet draws on
// (docs/APPLETS.md). On a dual-screen host the applet surface is the auxiliary
// touch screen (the 3DS bottom screen, the Tab5 panel); on a single-screen
// device without touch, the applet's full-screen presentation draws on the
// one screen (the PSP's 480x272). One program serves both: it mounts its UI in
// <AppletSurface> and lays out from appletViewport().
//
// The surface is fixed once the app mounts, so callers read the size inside
// mount() (or later), never at module load: the auxiliary surface is mounted
// by then and absent before.

import type { JSX as SolidJSX } from "solid-js";
import { SCREEN_H, SCREEN_W } from "../../contracts/spec/spec.ts";
import { AuxiliarySurface, View } from "./components.ts";
import { auxiliaryViewport, hasAuxiliarySurface } from "./display.ts";
import { getOps, hostViewport } from "./host.ts";
import { surfaceHasTouch } from "./modality.ts";

export interface AppletViewport {
  readonly width: number;
  readonly height: number;
}

/** Whether the applet draws on the auxiliary surface (false: the full screen). */
export function appletOnAuxiliary(): boolean {
  return hasAuxiliarySurface();
}

/** The logical size of the applet surface. */
export function appletViewport(): AppletViewport {
  const auxiliary = auxiliaryViewport();
  if (auxiliary) return auxiliary;
  const viewport = hostViewport(getOps());
  return { width: viewport?.w ?? SCREEN_W, height: viewport?.h ?? SCREEN_H };
}

/** Whether the applet surface reports contacts. Without touch, every control
 *  the applet offers answers a button. */
export function appletTouch(): boolean {
  return surfaceHasTouch(hasAuxiliarySurface() ? "auxiliary" : "primary");
}

export interface AppletSurfaceProps {
  children?: SolidJSX.Element | (() => SolidJSX.Element);
}

/** Mount the applet's UI on its surface: the auxiliary output when the plan
 *  has one, else in place on the primary display at its full size. */
export function AppletSurface(props: AppletSurfaceProps): SolidJSX.Element {
  if (hasAuxiliarySurface()) return <AuxiliarySurface>{props.children}</AuxiliarySurface>;
  const { width, height } = appletViewport();
  const children = props.children;
  return (
    <View class="relative overflow-hidden" style={{ width, height }}>
      {typeof children === "function" ? (children as () => SolidJSX.Element)() : children}
    </View>
  );
}
