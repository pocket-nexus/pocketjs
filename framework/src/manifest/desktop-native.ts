// SPDX-License-Identifier: MIT
import { createHostExtension, type HostExtension } from "./host-extension.ts";

export interface DesktopNativeModule {
  /** Path within the installed System directory. The library's directory owns its resources. */
  readonly library: string;
  readonly sha256: string;
  readonly config?: unknown;
}

export function isDesktopNativeModule(value: unknown): value is DesktopNativeModule {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const m = value as DesktopNativeModule;
  try {
    return Object.keys(m).every(k => ["library", "sha256", "config"].includes(k)) &&
      typeof m.library === "string" && m.library.length <= 1024 &&
      m.library.split("/").every(p => !!p && p !== "." && p !== ".." && !p.includes("\\")) &&
      typeof m.sha256 === "string" && /^[a-f0-9]{64}$/.test(m.sha256) &&
      new TextEncoder().encode(JSON.stringify(m.config ?? null)).length <= 16384;
  } catch { return false; }
}

/** Installation-time metadata, never a guest-controlled dlopen request. */
export function desktopNativeExtension(module: DesktopNativeModule): HostExtension {
  if (!isDesktopNativeModule(module)) throw new TypeError("invalid desktop native module");
  return createHostExtension("desktop-native", 1, { ...module });
}
