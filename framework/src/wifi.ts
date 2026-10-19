// @pocketjs/framework/wifi — the console's wireless radio and saved
// connections (`globalThis.wifi`, contracts/spec/wifi.ts).

import {
  WIFI_SAVED_SLOTS,
  WIFI_STATE,
  type WifiSavedNetwork,
  type WifiState,
  type WifiStatus,
} from "../../contracts/spec/wifi.ts";

export { WIFI_SAVED_SLOTS, WIFI_STATE };
export type { WifiSavedNetwork, WifiState, WifiStatus };

export interface WifiOps {
  status(): string;
  setEnabled(on: boolean): boolean;
  connect(slot: number): boolean;
}

export function wifiHost(): WifiOps | null {
  const ns = (globalThis as { wifi?: unknown }).wifi;
  if (!ns || typeof ns !== "object") return null;
  const ops = ns as Partial<WifiOps>;
  return typeof ops.status === "function" &&
      typeof ops.setEnabled === "function" &&
      typeof ops.connect === "function"
    ? (ops as WifiOps)
    : null;
}

/** The radio's state, read on every call; null on hosts without the module. */
export function wifiStatus(): WifiStatus | null {
  const ops = wifiHost();
  if (!ops) return null;
  try {
    return JSON.parse(ops.status()) as WifiStatus;
  } catch {
    return null;
  }
}

export function setWifiEnabled(on: boolean): boolean {
  return wifiHost()?.setEnabled(on) ?? false;
}

/** Connect through a saved connection (0..2). */
export function connectSavedNetwork(slot: number): boolean {
  if (!Number.isInteger(slot) || slot < 0 || slot >= WIFI_SAVED_SLOTS) return false;
  return wifiHost()?.connect(slot) ?? false;
}
