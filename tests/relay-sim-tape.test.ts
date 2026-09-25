// hosts/sim relay frame tape hook: default-off zero counters, enabled
// save -> replay round trip over P1 vectors, and first-divergent-seq
// reporting. Also pins the globalThis.relayTape bootWorld slot.

import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  createSimRelayTapeHook,
  loadSimRelayReplay,
} from "../hosts/sim/relay-tape.ts";
import type { RelayFrameTransport } from "../framework/src/relay/tape.ts";

const FIX = new URL("./fixtures/relay/", import.meta.url);

async function loadBin(name: string): Promise<Uint8Array> {
  const spec = await Bun.file(new URL(`vectors/${name}.json`, FIX)).json() as { file: string };
  return new Uint8Array(await Bun.file(new URL(spec.file, FIX)).arrayBuffer());
}

/** Scripted complete-record transport: queued inbound records, log sends. */
function scriptedTransport(inbound: Uint8Array[]): { inner: RelayFrameTransport; sent: Uint8Array[] } {
  const sent: Uint8Array[] = [];
  return {
    sent,
    inner: {
      send: (f) => sent.push(f),
      recv: () => inbound.shift() ?? null,
    },
  };
}

test("default off: wrap is identity and every counter is 0", () => {
  const { inner } = scriptedTransport([]);
  const hook = createSimRelayTapeHook();
  expect(hook.enabled).toBe(false);
  expect(hook.wrap(inner)).toBe(inner);
  expect(hook.framesRecorded).toBe(0);
  expect(hook.bytesRecorded).toBe(0);
  expect(() => hook.toJson()).toThrow(/never enabled/);
});

test("explicit off is identity too; no relayRecorder property leaks through", () => {
  const { inner } = scriptedTransport([]);
  const wrapped = createSimRelayTapeHook({ enabled: false }).wrap(inner);
  expect(wrapped).toBe(inner);
  expect("relayRecorder" in wrapped).toBe(false);
});

test("record a P1 vector sequence through the hook, then replay it OK", async () => {
  const ping = await loadBin("ping");
  const response = await loadBin("response-final");
  const get = await loadBin("get");
  const credit = await loadBin("credit");

  // Record pass.
  const { inner, sent } = scriptedTransport([response, credit]);
  const hook = createSimRelayTapeHook({ enabled: true, session: 0x0102030405060708n });
  const transport = hook.wrap(inner);
  expect(transport).not.toBe(inner);
  transport.send(ping);
  expect(transport.recv()).toBe(response);
  transport.send(get);
  expect(transport.recv()).toBe(credit);
  expect(hook.framesRecorded).toBe(4);
  expect(hook.bytesRecorded).toBe(ping.length + response.length + get.length + credit.length);
  expect(sent).toEqual([ping, get]);

  // One hook wraps one transport.
  expect(() => hook.wrap(inner)).toThrow(/one hook/);

  let json = "";
  hook.save((text) => { json = text; });
  const doc = JSON.parse(json) as { kind: string; v: number; session: string; frames: unknown[] };
  expect(doc.kind).toBe("relay-frame");
  expect(doc.session).toBe("0102030405060708");
  expect(doc.frames).toHaveLength(4);

  // Replay pass against a fresh fake transport.
  const { replay } = loadSimRelayReplay(json);
  replay.transport.send(ping);
  expect(Buffer.compare(Buffer.from(replay.transport.recv()!), Buffer.from(response))).toBe(0);
  replay.transport.send(get);
  expect(Buffer.compare(Buffer.from(replay.transport.recv()!), Buffer.from(credit))).toBe(0);
  const verdict = replay.result();
  expect(verdict.ok, verdict.divergence?.detail).toBe(true);
  expect(verdict.frames).toBe(4);
});

test("replay of a recording with one tampered frame names the first divergent seq", async () => {
  const ping = await loadBin("ping");
  const credit = await loadBin("credit");
  const hook = createSimRelayTapeHook({ enabled: true, session: 0x0102030405060708n });
  const transport = hook.wrap(scriptedTransport([credit]).inner);
  transport.send(ping);
  transport.recv();

  // Tamper the inbound tuple (index 1, credit): recv verifies the recorded
  // bytes against the stored digest and latches at that tuple's seq.
  const doc = JSON.parse(hook.toJson()) as {
    frames: [string, number, string, string][];
  };
  const hex = doc.frames[1][2];
  const at = 48 * 2; // first metadata byte
  doc.frames[1][2] = hex.slice(0, at) + (hex[at] === "0" ? "1" : "0") + hex.slice(at + 1);

  const { replay } = loadSimRelayReplay(JSON.stringify(doc));
  replay.transport.send(ping); // outbound entry still matches its digest
  expect(replay.transport.recv()).toBeNull(); // tampered inbound rejected
  const verdict = replay.result();
  expect(verdict.ok).toBe(false);
  expect(verdict.divergence!.index).toBe(1);
  expect(verdict.divergence!.seq).toBe(4); // credit seq
  expect(verdict.divergence!.code).toBe("digest");
});

const distHero = new URL("../dist/hero-main.js", import.meta.url).pathname;

const slotTest = existsSync(distHero) ? test : test.skip;

slotTest("bootWorld installs the relayTape global slot (undefined unless mounted)", async () => {
  const { bootWorld } = await import("../hosts/sim/sim.ts");
  const world = await bootWorld("hero-main", 60);
  expect((globalThis as Record<string, unknown>).relayTape).toBeUndefined();
  world.frame(0);
  const mounted = createSimRelayTapeHook({ enabled: false });
  const world2 = await bootWorld("hero-main", 60, { relayTape: mounted });
  expect((globalThis as Record<string, unknown>).relayTape).toBe(mounted);
  expect(mounted.framesRecorded).toBe(0);
  world2.frame(0);
});
