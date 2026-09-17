// @pocketjs/framework/launcher — the guest side of app switching
// (spec ops 39..41 and 51, docs/LAUNCHER.md).
//
// Embedded catalogs replace the guest on each switch. Native catalogs retain
// a process per installed app and foreground it on launch. Hosts without the
// optional operations return null/false/-1 from these accessors.

import { getOps } from "./host.ts";

/** One configured app, as the host reports it (registry order). */
export interface AppEntry {
  /** Native navigation lists configured apps even before installation. */
  installed?: boolean;
  /** dist output name — the appLaunch() key (e.g. "cafe-main"). */
  output: string;
  /** Manifest id (e.g. "dev.pocket-stack.cafe"). */
  id: string;
  /** Manifest title, for display. */
  title: string;
}

export interface AppTable {
  /** Native apps retain their process; embedded apps relaunch on every switch. */
  kind?: "native";
  apps: AppEntry[];
  /** Output name of the running bundle. */
  current: string;
  /** Embedded catalogs: the app interrupted by the last SELECT summon; null after a cold boot
   *  or an explicit launch. Resume = launchApp(resume) — a fresh relaunch,
   *  never a thaw (docs/LAUNCHER.md: there is no suspend in this protocol). */
  resume: string | null;
}

/** Whether the active host can switch apps at all. */
export function launcherActive(): boolean {
  return typeof getOps().appTable === "function";
}

/** The app table, or null on hosts without app switching. */
export function appTable(): AppTable | null {
  const raw = getOps().appTable?.();
  if (!raw) return null;
  const parsed = JSON.parse(raw) as AppTable;
  return { apps: parsed.apps ?? [], current: parsed.current ?? "", resume: parsed.resume ?? null,
    ...(parsed.kind === "native" ? { kind: parsed.kind } : {}) };
}

/** Request a switch after the current frame. Native apps foreground their
 * retained process; embedded catalogs replace the guest. False means rejected. */
export function launchApp(output: string): boolean {
  return (getOps().appLaunch?.(output) ?? 0) !== 0;
}

/** Close a native child app through its OS task. False means unsupported or refused. */
export function closeApp(output: string): boolean {
  return (getOps().appClose?.(output) ?? 0) !== 0;
}

/** Texture handle of the summon's frozen frame (256×128 PSM_8888), -1 when
 *  none was captured. Bind it under a name with the renderer's
 *  registerTexture(key, handle) and reference it as <Image src={key}>. */
export function frozenShot(): number {
  return getOps().appShot?.() ?? -1;
}

export interface NativeAppReturn {
  output: string;
  destination: "home" | "switcher";
  /** Host-owned last-frame texture, or -1. Replaced on the next return from this app. */
  shot: number;
  /** Zero on return; a native launch error otherwise. */
  error: number;
  pose: { x: number; y: number; scale: number };
}

type NativeGlobal = typeof globalThis & {
  __pocketjsNativeReturn?: (output: string, destination: "home" | "switcher", shot: number, error: number, x: number, y: number, scale: number) => void;
};
const nativeListeners = new Set<(event: NativeAppReturn) => void>();
let previousNativeReturn: NativeGlobal["__pocketjsNativeReturn"];
const dispatchNativeReturn: NonNullable<NativeGlobal["__pocketjsNativeReturn"]> = (output, destination, shot, error, x, y, scale) => {
  previousNativeReturn?.(output, destination, shot, error, x, y, scale);
  for (const listener of [...nativeListeners]) listener({ output, destination, shot, error, pose: { x, y, scale } });
};

/** Subscribe to native foreground handoffs. Unsubscribe before unmounting the shell.
 * The host calls this before the first resumed frame, never while JS is running. */
export function onNativeAppReturn(listener: (event: NativeAppReturn) => void): () => void {
  const target = globalThis as NativeGlobal;
  if (nativeListeners.size === 0) {
    previousNativeReturn = target.__pocketjsNativeReturn;
    target.__pocketjsNativeReturn = dispatchNativeReturn;
  }
  // Each subscription owns its entry, including repeated use of one callback.
  const entry = (event: NativeAppReturn) => listener(event);
  nativeListeners.add(entry);
  return () => {
    nativeListeners.delete(entry);
    if (nativeListeners.size === 0 && target.__pocketjsNativeReturn === dispatchNativeReturn) {
      target.__pocketjsNativeReturn = previousNativeReturn;
      previousNativeReturn = undefined;
    }
  };
}
