// @pocketjs/framework/wifi over a fake `globalThis.wifi`: a console's three
// slots, and a general-OS host's longer saved list with disconnect and its
// own settings (contracts/spec/wifi.ts).
import { afterEach, describe, expect, test } from "bun:test";
import {
  connectSavedNetwork,
  disconnectNetwork,
  forgetNetwork,
  openWifiSettings,
  savedSlotOf,
  wifiCanDisconnect,
  wifiHasSettings,
  wifiHost,
  wifiStatus,
  type WifiStatus,
} from "../framework/src/wifi.ts";

const g = globalThis as { wifi?: unknown };
const before = g.wifi;
afterEach(() => {
  g.wifi = before;
});

function host(saved: string[], extra: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const status: WifiStatus = {
    state: "idle",
    ssid: "",
    strength: 0,
    address: "",
    saved: saved.map((ssid, slot) => ({ slot, ssid })),
    error: "",
    networks: [{ ssid: saved[0] ?? "Cafe", strength: 2, secure: true, signal: 61, saved: saved.length > 0 }],
  };
  g.wifi = {
    status: () => JSON.stringify(status),
    setEnabled: () => true,
    connect: (slot: number) => (calls.push(`connect ${slot}`), slot < saved.length),
    forget: (slot: number) => (calls.push(`forget ${slot}`), slot < saved.length),
    ...extra,
  };
  return calls;
}

describe("framework/wifi", () => {
  test("a console's host offers neither disconnect nor settings", () => {
    host(["Home", "Office", ""]);
    expect(wifiHost()).not.toBeNull();
    expect(wifiCanDisconnect()).toBe(false);
    expect(disconnectNetwork()).toBe(false);
    expect(wifiHasSettings()).toBe(false);
    expect(openWifiSettings()).toBe(false);
  });

  test("a general OS's saved list reaches past the console's three slots", () => {
    const names = ["A", "B", "C", "D", "E"];
    const calls = host(names);
    const status = wifiStatus()!;
    expect(status.networks?.[0]).toEqual({ ssid: "A", strength: 2, secure: true, signal: 61, saved: true });
    expect(savedSlotOf(status, "E")).toBe(4);
    expect(savedSlotOf(status, "Cafe")).toBe(-1);
    expect(connectSavedNetwork(4)).toBe(true);
    expect(forgetNetwork(3)).toBe(true);
    // the host refuses a slot it does not hold
    expect(connectSavedNetwork(9)).toBe(false);
    expect(calls).toEqual(["connect 4", "forget 3", "connect 9"]);
  });

  test("slots that are no index never reach the host", () => {
    const calls = host(["A"]);
    for (const slot of [-1, 1.5, Number.NaN, 0x10000]) {
      expect(connectSavedNetwork(slot)).toBe(false);
      expect(forgetNetwork(slot)).toBe(false);
    }
    expect(calls).toEqual([]);
  });

  test("disconnect and the system's settings go to a host that has them", () => {
    const calls: string[] = [];
    host(["A"], {
      disconnect: () => (calls.push("disconnect"), true),
      openSettings: () => (calls.push("settings"), true),
    });
    expect(wifiCanDisconnect()).toBe(true);
    expect(wifiHasSettings()).toBe(true);
    expect(disconnectNetwork()).toBe(true);
    expect(openWifiSettings()).toBe(true);
    expect(calls).toEqual(["disconnect", "settings"]);
  });
});
