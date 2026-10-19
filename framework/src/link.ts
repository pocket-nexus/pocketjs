// @pocketjs/framework/link — the console's system link to a paired companion
// (`globalThis.link`, contracts/spec/link.ts). Framework neutral: callers read
// status() when they draw and subscribe to events with onLinkEvent().
//
// HTTP does not go through this module: on hosts whose net transport is the
// link, `fetch` from @pocketjs/framework/net already rides it.

import {
  LINK_PAIR_SCHEME,
  LINK_PAIRING,
  LINK_STATE,
  type LinkCatalogApp,
  type LinkCompanion,
  type LinkEvent,
  type LinkStatus,
} from "../../contracts/spec/link.ts";
import { registerServicePump } from "./services.ts";

export { LINK_PAIR_SCHEME, LINK_PAIRING, LINK_STATE };
export type { LinkCatalogApp, LinkCompanion, LinkEvent, LinkStatus };

export interface LinkOps {
  status(): string;
  pair(uri: string): boolean;
  forget(companion: string): boolean;
  catalog(): number;
  install(appId: string): number;
  remove(appId: string): boolean;
  /** One JSON array with every event visible this tick. */
  poll(): string | undefined;
}

export function linkHost(): LinkOps | null {
  const ns = (globalThis as { link?: unknown }).link;
  if (!ns || typeof ns !== "object") return null;
  const ops = ns as Partial<LinkOps>;
  return typeof ops.status === "function" &&
      typeof ops.pair === "function" &&
      typeof ops.forget === "function" &&
      typeof ops.catalog === "function" &&
      typeof ops.install === "function" &&
      typeof ops.remove === "function" &&
      typeof ops.poll === "function"
    ? (ops as LinkOps)
    : null;
}

const UNAVAILABLE: LinkStatus = {
  state: LINK_STATE.unpaired,
  companion: null,
  paired: [],
  device: { id: "", name: "", model: "", address: "" },
  pairing: LINK_PAIRING.idle,
  error: "this console has no Pocket Link",
  features: [],
  clock: null,
};

/** A snapshot of the link, read from the host on every call. */
export function linkStatus(): LinkStatus {
  const ops = linkHost();
  if (!ops) return UNAVAILABLE;
  try {
    const parsed = JSON.parse(ops.status()) as Partial<LinkStatus>;
    return {
      state: parsed.state ?? LINK_STATE.unpaired,
      companion: parsed.companion ?? null,
      paired: parsed.paired ?? [],
      device: parsed.device ?? UNAVAILABLE.device,
      pairing: parsed.pairing ?? LINK_PAIRING.idle,
      error: parsed.error ?? "",
      features: parsed.features ?? [],
      clock: parsed.clock ?? null,
    };
  } catch {
    return { ...UNAVAILABLE, error: "link: malformed status" };
  }
}

/** Epoch milliseconds by the linked companion's clock, or the console's own
 *  when no companion has linked since boot (a 3DS clock is often unset). */
export function companionNow(): number {
  return linkHost() ? linkStatus().clock?.utc ?? Date.now() : Date.now();
}

/** Whether a scanned code is a Pocket Link pairing URI. */
export function isPairingUri(text: string): boolean {
  return text.startsWith(`${LINK_PAIR_SCHEME}?`);
}

/** Start pairing from a scanned URI. Progress shows in linkStatus().pairing. */
export function pairCompanion(uri: string): boolean {
  return linkHost()?.pair(uri) ?? false;
}

export function forgetCompanion(id: string): boolean {
  return linkHost()?.forget(id) ?? false;
}

/** Delete an installed app. The host refuses the running app and the launcher. */
export function removeApp(appId: string): boolean {
  return linkHost()?.remove(appId) ?? false;
}

// ---- events -------------------------------------------------------------------

type Listener = (event: LinkEvent) => void;
const listeners = new Set<Listener>();
let stopPump: (() => void) | null = null;

function pump(): void {
  const raw = linkHost()?.poll();
  if (raw === undefined) return;
  let events: unknown;
  try {
    events = JSON.parse(raw);
  } catch {
    return;
  }
  if (!Array.isArray(events)) return;
  for (const event of events) {
    if (!event || typeof event !== "object" || typeof (event as LinkEvent).t !== "string") continue;
    for (const listener of [...listeners]) listener(event as LinkEvent);
  }
}

/** Receive link events every tick until the returned function is called. */
export function onLinkEvent(listener: Listener): () => void {
  listeners.add(listener);
  if (!stopPump) stopPump = registerServicePump(pump);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && stopPump) {
      stopPump();
      stopPump = null;
    }
  };
}

// ---- requests -----------------------------------------------------------------

/** The linked companion's catalog for this console. */
export function requestCatalog(): Promise<LinkCatalogApp[]> {
  const ops = linkHost();
  if (!ops) return Promise.reject(new Error("link: unavailable"));
  const id = ops.catalog();
  if (id < 0) return Promise.reject(new Error("link: not linked"));
  return new Promise((resolve, reject) => {
    const stop = onLinkEvent((event) => {
      if (event.t === "catalog" && event.id === id) {
        stop();
        resolve(event.apps);
      } else if (event.t === "error" && event.id === id) {
        stop();
        reject(new Error(event.message));
      }
    });
  });
}

export interface InstallProgress {
  received: number;
  bytes: number;
}

/** Install one app from the linked companion. Resolves with its output name. */
export function installApp(
  appId: string,
  onProgress?: (progress: InstallProgress) => void,
): Promise<string> {
  const ops = linkHost();
  if (!ops) return Promise.reject(new Error("link: unavailable"));
  const id = ops.install(appId);
  if (id < 0) return Promise.reject(new Error("link: not linked"));
  return new Promise((resolve, reject) => {
    const stop = onLinkEvent((event) => {
      if (event.t === "install.progress" && event.id === id) {
        onProgress?.({ received: event.received, bytes: event.bytes });
      } else if (event.t === "install.done" && event.id === id) {
        stop();
        resolve(event.output);
      } else if (event.t === "error" && event.id === id) {
        stop();
        reject(new Error(event.message));
      }
    });
  });
}
