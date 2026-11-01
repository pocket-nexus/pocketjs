// @pocketjs/framework/wifi — the console's wireless radio and saved
// connections (`globalThis.wifi`, contracts/spec/wifi.ts).

import {
  WIFI_SAVED_SLOTS,
  WIFI_STATE,
  type WifiAccessPoint,
  type WifiNetwork,
  type WifiSavedNetwork,
  type WifiState,
  type WifiStatus,
} from "../../contracts/spec/wifi.ts";

export { WIFI_SAVED_SLOTS, WIFI_STATE };
export type { WifiAccessPoint, WifiNetwork, WifiSavedNetwork, WifiState, WifiStatus };

export interface WifiOps {
  status(): string;
  setEnabled(on: boolean): boolean;
  connect(slot: number): boolean;
  /** Consoles whose launcher is their settings (contracts/spec/wifi.ts). */
  scan?(): boolean;
  join?(ssid: string, passphrase: string): boolean;
  forget?(slot: number): boolean;
  /** Hosts that serve an access point (contracts/spec/wifi.ts). */
  startAccessPoint?(ssid: string): boolean;
  stopAccessPoint?(): boolean;
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

/** The host lets the launcher scan, join and forget networks itself. */
export function wifiCanJoin(): boolean {
  const ops = wifiHost();
  return typeof ops?.scan === "function" && typeof ops.join === "function" &&
    typeof ops.forget === "function";
}

/** Start a scan; the result shows in `wifiStatus().networks`. */
export function scanNetworks(): boolean {
  return wifiHost()?.scan?.() ?? false;
}

/** Connect to a network and save it once connected. */
export function joinNetwork(ssid: string, passphrase: string): boolean {
  if (ssid.length === 0 || ssid.length > 32 || passphrase.length > 63) return false;
  return wifiHost()?.join?.(ssid, passphrase) ?? false;
}

export function forgetNetwork(slot: number): boolean {
  if (!Number.isInteger(slot) || slot < 0 || slot >= WIFI_SAVED_SLOTS) return false;
  return wifiHost()?.forget?.(slot) ?? false;
}

/** The host can serve an access point beside the station connection. */
export function wifiCanServe(): boolean {
  const ops = wifiHost();
  return typeof ops?.startAccessPoint === "function" && typeof ops.stopAccessPoint === "function";
}

/** Serve an open access point named `ssid`; the state shows in
 *  `wifiStatus().accessPoint`. */
export function startAccessPoint(ssid: string): boolean {
  if (ssid.length === 0 || ssid.length > 32) return false;
  return wifiHost()?.startAccessPoint?.(ssid) ?? false;
}

export function stopAccessPoint(): boolean {
  return wifiHost()?.stopAccessPoint?.() ?? false;
}
