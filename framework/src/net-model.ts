/** Typed model awaitables over the existing host network transport. */
import { __requestNet, netHost } from "./net-api.ts";
import { NET_ERROR } from "../../contracts/spec/net.ts";
import { utf8ToString } from "./bytes.ts";
import { registerModelService, type Wait } from "./model-tasks.ts";
import type { i32 } from "./numeric-microts.ts";

export type NetResult =
  | { kind: "ok"; status: i32; body: string }
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
    if (call !== "get" || typeof args[0] !== "string") { deliver({ kind: "malformed" }); return; }
    return __requestNet(args[0],{},(status,_url,_headers,buffer)=>{
      try { deliver({kind:"ok",status,body:utf8ToString(new Uint8Array(buffer))}); }
      catch { deliver({kind:"malformed"}); }
    },error=>{
      if(error.code===NET_ERROR.protocol)deliver({kind:"malformed"});
      else if(error.code===NET_ERROR.unavailable)deliver({kind:"unavailable"});
      else if(error.code===NET_ERROR.busy)deliver({kind:"busy"});
      else deliver({kind:"failed",message:error.message});
    });
  },
});

export function get(url: string): PromiseLike<NetResult> {
  return { kind: "service", service: "@pocketjs/framework/net/model", call: "get", args: [url] } as Wait as unknown as PromiseLike<NetResult>;
}
export const net = { get };
