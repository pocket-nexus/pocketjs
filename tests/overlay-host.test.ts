// Overlay host contract: the service pump drains newline-batched state and
// pointer lines. One malformed line (bad JSON, or valid JSON with a shape the
// per-line dispatch dereferences) must be skipped without losing the rest of
// the batch, without throwing out of runServicePumps(), and without starving
// pumps registered after the overlay pump — the per-line isolation that
// service-client.ts has had since its mailbox reader.

import { afterEach, expect, test } from "bun:test";
import { installHost, type HostOps } from "../framework/src/host.ts";
import { connectOverlay, OVERLAY_SERVICE } from "../framework/src/overlay-host.ts";
import { resetInput, setInputRoot } from "../framework/src/input.ts";
import { registerServicePump, runServicePumps } from "../framework/src/services.ts";
import { NODE_TYPE, ROOT_ID } from "../contracts/spec/spec.ts";
import type { NodeMirror } from "../framework/src/renderer.ts";

function rig(batches: string[], options: { open?: boolean } = {}) {
  let index = 0;
  const polls: number[] = [];
  installHost({ kind: "injected", target: "test", strict: false, ops: {
    svcOpen: (name: string) => { expect(name).toBe(OVERLAY_SERVICE); return options.open ?? true; },
    svcPoll: () => { polls.push(index); return batches[Math.min(index++, batches.length - 1)]; },
  } as unknown as HostOps });
  return { polls };
}

function mk(id: number, parent: NodeMirror | null, focusable = false): NodeMirror {
  const n = { id, type: NODE_TYPE.view, parent, children: [], focusable } as unknown as NodeMirror;
  if (parent) parent.children.push(n);
  return n;
}

const state = (n: number) => JSON.stringify({ type: "state", value: n });
const pointer = (event: unknown) => JSON.stringify({ type: "pointer", event });
const active: unknown[] = [];
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); active.length = 0; resetInput(); });

/** A mock host whose setActive records which node the pointer authority owns. */
function pointerHost(batch: string) {
  installHost({ kind: "injected", target: "test", strict: false, ops: {
    svcOpen: () => true,
    svcPoll: () => batch,
    setFocus: () => {},
    setActive: (id: number, on: number) => active.push(on),
    hitTest: () => ROOT_ID,
  } as unknown as HostOps });
}

for (const [label, batch, expected] of [
  ["first", ["not json", state(2), state(3)].join("\n"), [2, 3]],
  ["middle", [state(1), "{bad", state(3)].join("\n"), [1, 3]],
  ["last", [state(1), state(2), "oops"].join("\n"), [1, 2]],
] as const) test(`a malformed line ${label} in the batch does not drop later state lines or throw`, () => {
  rig([batch]);
  const received: number[] = [];
  const overlay = connectOverlay<number, unknown>(value => received.push(value));
  cleanups.push(overlay.dispose);
  expect(() => runServicePumps()).not.toThrow();
  expect(received).toEqual([...expected]);
});

test("empty and whitespace-only lines are skipped without throwing", () => {
  rig([["", "   ", state(1), "\t", state(2), ""].join("\n")]);
  const received: number[] = [];
  const overlay = connectOverlay<number, unknown>(value => received.push(value));
  cleanups.push(overlay.dispose);
  expect(() => runServicePumps()).not.toThrow();
  expect(received).toEqual([1, 2]);
});

test("valid JSON with an invalid message shape is skipped and later lines still arrive", () => {
  rig([[state(1), "null", state(3)].join("\n")]);
  const received: number[] = [];
  const overlay = connectOverlay<number, unknown>(value => received.push(value));
  cleanups.push(overlay.dispose);
  // null parses fine; the dispatch dereferences message.type and must not
  // be allowed to throw that TypeError out of the frame.
  expect(() => runServicePumps()).not.toThrow();
  expect(received).toEqual([1, 3]);
});

test("a pointer line missing its event does not break the frame", () => {
  rig([[state(1), JSON.stringify({ type: "pointer" }), state(3)].join("\n")]);
  const received: number[] = [];
  const overlay = connectOverlay<number, unknown>(value => received.push(value));
  cleanups.push(overlay.dispose);
  expect(() => runServicePumps()).not.toThrow();
  expect(received).toEqual([1, 3]);
});

test("a pump registered after the overlay still runs in the malformed-line frame", () => {
  rig([[state(1), "broken", state(3)].join("\n")]);
  const overlay = connectOverlay<number, unknown>(() => {});
  cleanups.push(overlay.dispose);
  let laterPumpFrames = 0;
  const removeLater = registerServicePump(() => { laterPumpFrames++; });
  cleanups.push(removeLater);
  expect(() => runServicePumps()).not.toThrow();
  expect(laterPumpFrames).toBe(1);
});

test("well-formed multi-line state batches deliver in order", () => {
  rig([[state(1), state(2), state(3)].join("\n")]);
  const received: number[] = [];
  const overlay = connectOverlay<number, unknown>(value => received.push(value));
  cleanups.push(overlay.dispose);
  runServicePumps();
  expect(received).toEqual([1, 2, 3]);
});

test("a well-formed pointer line reaches the pointer controller", () => {
  pointerHost([pointer({ kind: "button", x: 1, y: 1, down: true }), pointer({ kind: "cancel" })].join("\n"));
  const root = mk(ROOT_ID, null, true);
  setInputRoot(root);
  const overlay = connectOverlay<number, unknown>(() => {});
  cleanups.push(overlay.dispose);
  // down on the focusable root owns the press (setActive 1); cancel clears
  // it (setActive 0). Both lines being observed proves pointer dispatch.
  runServicePumps();
  expect(active).toEqual([1, 0]);
});

test("a refused svcOpen still rejects connectOverlay", () => {
  rig([], { open: false });
  expect(() => connectOverlay<number, unknown>(() => {})).toThrow("PocketJS overlay host is unavailable");
});

test("dispose removes the pump: later frames never poll again", () => {
  const polls = rig([state(1), state(2)]);
  const overlay = connectOverlay<number, unknown>(() => {});
  runServicePumps();
  expect(polls.polls).toHaveLength(1);
  overlay.dispose();
  runServicePumps();
  expect(polls.polls).toHaveLength(1);
});
