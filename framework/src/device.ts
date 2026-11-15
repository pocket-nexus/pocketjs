// @pocketjs/framework/device — the board's own controls
// (`globalThis.device`, contracts/spec/device.ts, capability system.device).

import {
  DEVICE_DIRECTORY_MAX_ENTRIES,
  DEVICE_PATH_MAX_BYTES,
  DEVICE_STATUS_MAX_AGE_MS,
  type DeviceCard,
  type DeviceDirectory,
  type DeviceDirectoryEntry,
  type DeviceDisplay,
  type DevicePort,
  type DeviceStatus,
  type DeviceSwitch,
} from "../../contracts/spec/device.ts";

export { DEVICE_DIRECTORY_MAX_ENTRIES, DEVICE_PATH_MAX_BYTES, DEVICE_STATUS_MAX_AGE_MS };
export type {
  DeviceCard,
  DeviceDirectory,
  DeviceDirectoryEntry,
  DeviceDisplay,
  DevicePort,
  DeviceStatus,
  DeviceSwitch,
};

export interface DeviceOps {
  status(): string;
  setBrightness(percent: number): boolean;
  setVolume(percent: number): boolean;
  setSwitch(id: string, on: boolean): boolean;
  setPin(pin: number, level: number): boolean;
  releasePin(pin: number): boolean;
  listDirectory(path: string): string;
  powerOff(): boolean;
}

/** The mounted namespace, or null on hosts without the module. */
export function deviceHost(): DeviceOps | null {
  const ns = (globalThis as { device?: unknown }).device;
  if (!ns || typeof ns !== "object") return null;
  const ops = ns as Partial<DeviceOps>;
  return typeof ops.status === "function" && typeof ops.setBrightness === "function"
    ? (ops as DeviceOps)
    : null;
}

/** The board's state, read on every call; null without the module. */
export function deviceStatus(): DeviceStatus | null {
  const ops = deviceHost();
  if (!ops) return null;
  try {
    return JSON.parse(ops.status()) as DeviceStatus;
  } catch {
    return null;
  }
}

function percent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function setBrightness(value: number): boolean {
  return deviceHost()?.setBrightness(percent(value)) ?? false;
}

export function setVolume(value: number): boolean {
  return deviceHost()?.setVolume(percent(value)) ?? false;
}

export function setSwitch(id: string, on: boolean): boolean {
  return deviceHost()?.setSwitch(id, on) ?? false;
}

export function setPin(pin: number, level: 0 | 1 | boolean): boolean {
  if (!Number.isInteger(pin) || pin < 0) return false;
  return deviceHost()?.setPin(pin, level ? 1 : 0) ?? false;
}

export function releasePin(pin: number): boolean {
  if (!Number.isInteger(pin) || pin < 0) return false;
  return deviceHost()?.releasePin(pin) ?? false;
}

/** A directory of the removable card, "/" its root; null when the card is
 *  absent, the path is not a directory or the module is missing. */
export function listDirectory(path = "/"): DeviceDirectory | null {
  if (path.length === 0 || path.length > DEVICE_PATH_MAX_BYTES || path[0] !== "/") return null;
  const text = deviceHost()?.listDirectory(path) ?? "";
  if (!text) return null;
  try {
    return JSON.parse(text) as DeviceDirectory;
  } catch {
    return null;
  }
}

export function powerOff(): boolean {
  return deviceHost()?.powerOff() ?? false;
}
