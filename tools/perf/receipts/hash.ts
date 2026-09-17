import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/** Serialize JSON with recursively sorted object keys and no implicit coercions. */
export function canonicalJson(value: unknown): string {
  return canonicalize(value, new Set<object>());
}

function canonicalize(value: unknown, ancestors: Set<object>): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical JSON cannot contain a non-finite number");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new TypeError(`canonical JSON cannot contain ${typeof value}`);
  }
  if (ancestors.has(value)) throw new TypeError("canonical JSON cannot contain a cycle");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) throw new TypeError("canonical JSON cannot contain array holes");
        items.push(canonicalize(value[index], ancestors));
      }
      return `[${items.join(",")}]`;
    }
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
      throw new TypeError("canonical JSON requires plain objects");
    }
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key], ancestors)}`)
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function sha256Bytes(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function sha256Json(value: unknown): string {
  return sha256Bytes(canonicalJson(value));
}

export function sha256File(path: string): string {
  return sha256Bytes(readFileSync(path));
}

/** Must remain byte-for-byte equivalent to tools/perf/guest/src/main.rs. */
export function scenarioPhaseId(scenarioId: string, phase: string): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(`${scenarioId}\0${phase}`)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/**
 * Receipt v1 stores SHA-256 values. The guest intentionally uses a cheap FNV
 * digest in the measured process, so the host hashes that tagged digest into
 * the receipt instead of mislabelling the 64-bit value as SHA-256.
 */
export function guestDigestToSha256(
  domain: "draw-list" | "state" | "effects",
  digest: string,
): string {
  if (!/^fnv1a64:[a-f0-9]{16}$/.test(digest)) {
    throw new TypeError(`invalid guest ${domain} digest: ${JSON.stringify(digest)}`);
  }
  return sha256Bytes(`pocketjs.perf.${domain}.fnv1a64\0${digest}`);
}
