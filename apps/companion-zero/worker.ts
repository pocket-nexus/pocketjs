// The screen's worker: it performs the screen's control API calls with the
// program's `http` node (programs/cardputer-zero/src/http.rs) and returns
// each answer to the screen as response records (wire.ts). Each call is one
// task; the answers of every call share one queue toward the response ring,
// which retries every 15 ms while the ring is full.

import { io, FactKind, ResourceStatus, type HttpRequest } from "@pocketjs/framework/io";
import { settle, sleep } from "@pocketjs/framework/worker";
import { Answer, HEADER_BYTES, RECORD_BYTES, answer, decodeCall, text, utf8 } from "./wire.ts";

const RETRY_MICROS = 15_000;
const BODY_BYTES = RECORD_BYTES - HEADER_BYTES;

/** Why a call ended without its whole answer, by ResourceStatus. */
const ENDED: Record<number, string> = {
  [ResourceStatus.failed]: "The request did not reach its server.",
  [ResourceStatus.unknown]: "The request was sent, and no answer came back.",
  [ResourceStatus.busy]: "Too many requests at once.",
  [ResourceStatus.invalid]: "This screen does not make that request.",
};

const responses = io.channel("response");
const unsent: Uint8Array[] = [];
let flushing = false;

async function flush(): Promise<void> {
  if (flushing) return;
  flushing = true;
  while (unsent.length) {
    if (responses.publish(unsent[0]!)) unsent.shift();
    else await sleep(RETRY_MICROS);
  }
  flushing = false;
}
function send(record: Uint8Array): void {
  unsent.push(record);
  void flush();
}
function end(id: number, status: number): void {
  const reason = status === ResourceStatus.ok ? "" : (ENDED[status] ?? `The request ended with status ${status}.`);
  send(answer(id, Answer.end, utf8(reason)));
}

/** One call: the answer streams back as it arrives; the completion closes
 *  the resource, which ends the stream, and a request the node never
 *  started completes without an end. */
async function perform(record: Uint8Array): Promise<void> {
  const { id, call } = decodeCall(record);
  let resource: HttpRequest;
  try {
    resource = io.http("http").open(call);
  } catch {
    end(id, ResourceStatus.invalid);
    return;
  }
  const request = resource.submit();
  if (request < 0) {
    resource.close();
    end(id, ResourceStatus.busy);
    return;
  }
  const completion = settle(request);
  void completion.then(() => resource.close());
  let ended = false;
  for await (const fact of resource.observe()) {
    if (fact.kind === FactKind.headers) {
      const status = (JSON.parse(text(fact.data)) as { status: number }).status;
      const payload = new Uint8Array(2);
      new DataView(payload.buffer).setUint16(0, status, true);
      send(answer(id, Answer.head, payload));
    } else if (fact.kind === FactKind.data) {
      for (let at = 0; at < fact.data.length; at += BODY_BYTES) send(answer(id, Answer.body, fact.data.subarray(at, at + BODY_BYTES)));
    } else if (fact.kind === FactKind.end) {
      ended = true;
      end(id, fact.status);
    }
  }
  const outcome = await completion;
  if (!ended) end(id, outcome.status);
}

async function main(): Promise<void> {
  for await (const record of io.channel("request").observe()) void perform(record);
}
main();
