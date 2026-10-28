import { io, FactKind, ResourceStatus } from "@pocketjs/framework/io";
import { settle } from "@pocketjs/framework/worker";

const progress = io.channel("progress");
const record = new Uint8Array(12);
const fields = new DataView(record.buffer);

function publish(phase: number, total: number, status = 0): void {
  fields.setUint32(0, phase, true);
  fields.setUint32(4, total, true);
  fields.setInt32(8, status, true);
  progress.publish(record);
}

/** One request. The response streams through observe(); the completion
 *  closes the resource, which ends the stream whether or not an end fact
 *  arrived, and its status reports a request that ended without one. */
async function fetchOnce(): Promise<void> {
  const resource = io.http("http").open({ url: "https://example.com/", maxBytes: 262144, timeoutMs: 30000 });
  const request = resource.submit();
  if (request < 0) { publish(5, 0, ResourceStatus.busy); resource.close(); return; }
  publish(1, 0);
  const completion = settle(request);
  void completion.then(() => resource.close());
  let total = 0, ended = false;
  for await (const fact of resource.observe()) {
    if (fact.kind === FactKind.headers) publish(2, total);
    if (fact.kind === FactKind.data) { total = fact.offset + fact.data.length; publish(3, total); }
    if (fact.kind === FactKind.end) { ended = true; total = fact.offset; publish(fact.status === ResourceStatus.ok ? 4 : 5, total, fact.status); }
  }
  const outcome = await completion;
  if (!ended) publish(5, total, outcome.status);
}

async function main(): Promise<void> {
  for await (const _ of io.channel("request").observe()) await fetchOnce();
}
main();
