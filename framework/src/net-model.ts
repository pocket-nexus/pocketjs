/** Typed model awaitables over the existing host network transport. */
import { fetch as hostFetch, netHost } from "./net-api.ts";
import { registerModelService, type Wait } from "./model-tasks.ts";

export type NetResult =
  | { kind: "ok"; status: number; body: string }
  | { kind: "failed"; message: string }
  | { kind: "unavailable" } | { kind: "busy" } | { kind: "malformed" };

export function validateNetResult(value: unknown): value is NetResult {
  if (!value || typeof value !== "object" || !("kind" in value)) return false;
  const result = value as Record<string, unknown>;
  if (result.kind === "ok") return typeof result.status === "number" && Number.isInteger(result.status) && result.status >= 100 && result.status <= 599 && typeof result.body === "string";
  if (result.kind === "failed") return typeof result.message === "string";
  return ["unavailable", "busy", "malformed"].includes(result.kind as string);
}
registerModelService("@pocketjs/framework/net/model", {
  capacity: 4,
  available: () => netHost() !== null,
  validate: validateNetResult,
  request(call, args, _request, deliver) {
    let cancelled = false;
    if (call !== "get" || typeof args[0] !== "string") { deliver({ kind: "malformed" }); return; }
    hostFetch(args[0]).then(async response => {
      const body = await response.text();
      if (!cancelled) deliver({ kind: "ok", status: response.status, body });
    }).catch(error => { if (!cancelled) deliver({ kind: "failed", message: String(error?.message ?? error) }); });
    // The adapter drops a result when the existing transport cannot cancel one request.
    return () => { cancelled = true; };
  },
});

export function get(url: string): PromiseLike<NetResult> {
  return { kind: "service", service: "@pocketjs/framework/net/model", call: "get", args: [url] } as Wait as unknown as PromiseLike<NetResult>;
}
export const net = { get };
