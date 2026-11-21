import type { Database, SQLQueryBindings } from "bun:sqlite";
import { OFFLOAD } from "../contracts/spec/offload.ts";
export type OffloadMethods = Record<string, (payload: string) => string | Promise<string>>;

/** Provider-owned SQL, parameter values only from the device. Install on a
 * Worker, with a DB confined to the provider's granted application directory. */
export function sqliteQueries(db: Database, queries: Record<string, string>): OffloadMethods {
  return Object.fromEntries(Object.entries(queries).map(([name, sql]) => [name, (payload: string) => {
    const params = JSON.parse(payload) as SQLQueryBindings[];
    if (!Array.isArray(params) || params.length > 16 || params.some(p => p !== null && typeof p !== "string" && typeof p !== "number")) throw new Error("Invalid SQL parameters");
    const rows = db.query(sql).all(...params);
    const result = JSON.stringify(rows);
    if (rows.length > 32 || result.length > OFFLOAD.payloadChars) throw new Error("Query must return a bounded page");
    return result;
  }]));
}

/** Exact URLs are granted by the provider. No device-supplied destination,
 * redirects, headers, credentials, or unbounded whole-response allocation. */
export function httpResources(resources: Record<string, string>): OffloadMethods {
  return Object.fromEntries(Object.entries(resources).map(([name, url]) => [name, async () => {
    const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(5000) });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let bytes = 0;
    try {
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        bytes += value.length;
        if (bytes > 2000) throw new Error("HTTP resource exceeds page budget");
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
    const out = new Uint8Array(bytes); let offset = 0;
    for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
    return new TextDecoder("utf-8", { fatal: true }).decode(out);
  }]));
}
