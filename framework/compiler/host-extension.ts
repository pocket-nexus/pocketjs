import { createHash } from "node:crypto";
import { canonicalJson } from "./plan.ts";

/** Opaque, versioned adapter input. Generic hosts validate identity, not
 * platform-specific payload fields. Payload travels with its hash. */
export interface HostExtension {
  readonly kind: string;
  readonly version: number;
  readonly payloadHash: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

function payloadHash(payload: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(payload)).digest("hex")}`;
}

export function isHostExtension(value: unknown): value is HostExtension {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const extension = value as HostExtension;
  if (typeof extension.kind !== "string" || !/^[a-z][a-z0-9-]*$/.test(extension.kind) ||
      !Number.isSafeInteger(extension.version) || extension.version < 1 ||
      !extension.payload || typeof extension.payload !== "object" || Array.isArray(extension.payload)) return false;
  try { return extension.payloadHash === payloadHash(extension.payload); }
  catch { return false; }
}

export function createHostExtension(kind: string, version: number, payload: HostExtension["payload"]): HostExtension {
  const extension = { kind, version, payload, payloadHash: payloadHash(payload) };
  if (!isHostExtension(extension)) throw new TypeError("invalid host extension");
  return extension;
}
