import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { analyzeModel } from "../microts/compiler/aot-model-frontend.ts";
import { interpretModel, type ModelFrameInput } from "../microts/compiler/model-interp.ts";
import { assertModelObservations, executeModelJavaScript, executeModelRust, observeModelFrames } from "../microts/compiler/model-harness.ts";

const service = "@pocketjs/framework/net/model";
function fixture(timeoutFirst: boolean, deliveryClock?: number) {
  const source = `
import {createSignal} from "solid-js";
import {any,after} from "@pocketjs/framework/solid/std";
import {net} from "@pocketjs/framework/net/model";
export const [body,setBody]=createSignal("");
export const [winner,setWinner]=createSignal("");
export async function run():Promise<void>{
  const result=await any([${timeoutFirst ? 'after(1000),net.get("https://example.test")' : 'net.get("https://example.test"),after(1000)'}]);
  if(result!==undefined && result.kind==="ok")setBody(result.body);
  setWinner(result===undefined?"timeout":"request");
}`;
  const program = analyzeModel(resolve("tests/fixtures/aot-model/mixed-any/App.ts"), { source });
  const task = program.modules[0]!.functions.find(fn => fn.name === "run")!;
  const request = { task: { region: 1, fn: task.id, generation: 1 }, generation: 1, member: timeoutFirst ? 1 : 0 };
  const delivery = { request, value: { kind: "ok", status: 200, body: "response" } };
  const tape: ModelFrameInput[] = [{ clock: 0, dispatch: [{ fn: "run" }] }, { clock: deliveryClock ?? 1000, ...(deliveryClock === undefined ? {} : { deliveries: [delivery] }) }, { clock: 1001, ...(deliveryClock === undefined ? { deliveries: [delivery] } : {}) }];
  return { name: `mixed-any-${timeoutFirst ? "timeout-first" : "request-first"}-${deliveryClock ?? "timeout"}`, program, tape, services: { [service]: { available: true, capacity: 4 } } };
}

test("mixed any infers Option and preserves request, timeout and same-boundary member-order winners", async () => {
  const fixtures = [fixture(false), fixture(false, 500), fixture(false, 1000), fixture(true, 1000)];
  const native = await executeModelRust(fixtures);
  for (const row of fixtures) {
    const resumed = row.program.modules[0]!.tasks[0]!.states.find(state => state.resume)!.resume!;
    expect(resumed.type).toMatchObject({ kind: "option", value: { kind: "named" } });
    const expected = observeModelFrames(interpretModel(row.program, row.tape, { services: row.services }));
    const timeout = row.name.endsWith("timeout") || row.name.includes("timeout-first");
    expect(expected[1]!.state).toEqual({ body: timeout ? "" : "response", winner: timeout ? "timeout" : "request" });
    assertModelObservations(row.name, expected, await executeModelJavaScript(row), row.tape);
    assertModelObservations(row.name, expected, await executeModelJavaScript(row, true), row.tape);
    assertModelObservations(row.name, expected, native.get(row.name)!, row.tape);
    if (row.name.endsWith("timeout")) expect(expected[2]!.trace.some(event => event.kind === "delivery-drop")).toBe(true);
  }
}, 120_000);
