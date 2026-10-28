// The screen's worker: it performs the screen's control API calls with the
// program's `http` node (programs/cardputer-zero/src/http.rs) and returns
// each answer to the screen as response records (wire.ts). A record the
// response ring has no room for waits for the next turn, which a timer
// schedules while records wait.

import { io, type HttpRequest } from "@pocketjs/framework/io";
import { FactKind, ResourceStatus, type Inbox, type TurnContext } from "@pocketjs/framework/worker";
import { Answer, HEADER_BYTES, RECORD_BYTES, answer, decodeCall, text, utf8 } from "./wire.ts";

const RETRY_TIMER = 1;
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
const calls = new Map<number, { resource: HttpRequest; request: number; ended: boolean }>();
const unsent: Uint8Array[] = [];

function end(id: number, status: number): void {
  const reason = status === ResourceStatus.ok ? "" : (ENDED[status] ?? `The request ended with status ${status}.`);
  unsent.push(answer(id, Answer.end, utf8(reason)));
}

function start(record: Uint8Array): void {
  const { id, call } = decodeCall(record);
  try {
    const resource = io.http("http").open(call);
    const request = resource.submit();
    if (request < 0) {
      resource.close();
      end(id, ResourceStatus.busy);
    } else calls.set(id, { resource, request, ended: false });
  } catch {
    end(id, ResourceStatus.invalid);
  }
}

function forward(id: number, call: { resource: HttpRequest; request: number; ended: boolean }, inbox: Inbox): void {
  for (const fact of call.resource.observe(inbox)) {
    if (fact.kind === FactKind.headers) {
      const status = (JSON.parse(text(fact.data.copy())) as { status: number }).status;
      const payload = new Uint8Array(2);
      new DataView(payload.buffer).setUint16(0, status, true);
      unsent.push(answer(id, Answer.head, payload));
    } else if (fact.kind === FactKind.data) {
      const bytes = fact.data.copy();
      for (let at = 0; at < bytes.length; at += BODY_BYTES) unsent.push(answer(id, Answer.body, bytes.subarray(at, at + BODY_BYTES)));
    } else if (fact.kind === FactKind.end) {
      call.ended = true;
      end(id, fact.status);
    }
  }
  // A request the node never started completes without an end.
  const completion = inbox.completion(call.request);
  if (!completion) return;
  if (!call.ended) end(id, completion.status);
  call.resource.close();
  calls.delete(id);
}

export function turn(context: TurnContext, inbox: Inbox): void {
  for (const record of inbox.channel("request")) start(record.data.copy());
  for (const [id, call] of calls) forward(id, call, inbox);
  while (unsent.length && responses.publish(unsent[0]!)) unsent.shift();
  if (unsent.length) io.timer(RETRY_TIMER, context.nowMicros + RETRY_MICROS);
}
