import { io, type HttpRequest } from "@pocketjs/framework/io";
import { FactKind, ResourceStatus, type Inbox, type TurnContext } from "@pocketjs/framework/worker";

const progress = io.channel("progress");
const record = new Uint8Array(12);
const fields = new DataView(record.buffer);
let resource: HttpRequest | undefined;
let request = -1;
let total = 0;

function publish(phase: number, status = 0): void {
  fields.setUint32(0, phase, true);
  fields.setUint32(4, total, true);
  fields.setInt32(8, status, true);
  progress.publish(record);
}

export function turn(_context: TurnContext, inbox: Inbox): void {
  if (inbox.channel("request").length && !resource) {
    total = 0;
    resource = io.http("http").open({ url: "https://example.com/", maxBytes: 262144, timeoutMs: 30000 });
    request = resource.submit();
    publish(request < 0 ? 5 : 1, request < 0 ? ResourceStatus.busy : 0);
    if (request < 0) { resource.close(); resource = undefined; }
  }
  if (!resource) return;
  for (const fact of resource.observe(inbox)) {
    if (fact.kind === FactKind.headers) publish(2);
    if (fact.kind === FactKind.data) { total = fact.offset + fact.data.length; publish(3); }
    if (fact.kind === FactKind.end) { total = fact.offset; publish(fact.status === ResourceStatus.ok ? 4 : 5, fact.status); }
  }
  if (inbox.completion(request)) { resource.close(); resource = undefined; }
}
