// A host whose keyboard is somewhere else (HostOps.textSession) gets no
// docked panel (osk.tsx draws none and oskHeight() is 0); the session still
// opens and closes through the host op, so the host shows its own keyboard.

import { describe, expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { installHost, type HostOps } from "../framework/src/host.ts";
import { createOsk } from "../framework/src/osk-controller.ts";
import { keyboardElsewhere } from "../framework/src/osk-session.ts";

function host(ops: Partial<HostOps>) {
  installHost({ ops: ops as HostOps, kind: "injected", target: "test", strict: true });
}

describe("keyboard elsewhere", () => {
  test("a host without textSession keeps the docked panel", () => {
    host({});
    expect(keyboardElsewhere()).toBe(false);
  });

  test("a host with textSession draws no panel and is told when a session opens and closes", () => {
    const sessions: boolean[] = [];
    host({ textSession: (open) => sessions.push(open) });
    expect(keyboardElsewhere()).toBe(true);
    const [value, setValue] = createSignal("");
    const osk = createOsk({ value, setValue });
    osk.open();
    osk.insert("hi");
    expect(osk.display("|")).toBe("hi|");
    osk.commit();
    expect(sessions).toEqual([true, false]);
    expect(osk.isOpen()).toBe(false);
  });
});
