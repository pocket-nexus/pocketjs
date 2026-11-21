import type { createOffloadClient } from "./offload.ts";
import type { ResourceLoad } from "./resource-cache.ts";

/** An opt-in adapter for reproducible read capabilities. Already-serialized
 * payloads retain offload's wire bound. Mutating methods must use offload directly. */
export function offloadResource<I>(client: Pick<ReturnType<typeof createOffloadClient>, "request" | "cancel">,
  method: string, payload: (input: I) => string): ResourceLoad<I, string> {
  return (input, complete) => {
    const id = client.request(method, payload(input), result => complete(result));
    return id ? { cancel: () => client.cancel(id) } : false;
  };
}
