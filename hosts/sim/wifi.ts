// hosts/sim/wifi.ts — a deterministic console radio (`globalThis.wifi`,
// contracts/spec/wifi.ts): three saved connections, an on/off switch and a
// connection that completes a fixed number of virtual ticks after it starts.

import { WIFI_SAVED_SLOTS, WIFI_STATE, type WifiStatus } from "../../contracts/spec/wifi.ts";
import type { WifiOps } from "../../framework/src/wifi.ts";

export interface SimWifiFixture {
  /** SSIDs of the three saved slots; "" for an empty slot. */
  saved?: [string, string, string];
  /** Saved slot connected at boot; null boots with the radio idle. */
  connected?: number | null;
  /** Radio off at boot. */
  off?: boolean;
  strength?: number;
  address?: string;
  /** Ticks from connect()/setEnabled(true) to connected. Default 20. */
  connectTicks?: number;
}

export interface SimWifiHost {
  readonly ns: WifiOps;
  tick(): void;
  readonly log: string[];
  status(): WifiStatus;
}

export function createSimWifiHost(fixture: SimWifiFixture = {}): SimWifiHost {
  const saved = fixture.saved ?? ["PocketNet", "", ""];
  let state: WifiStatus["state"] = fixture.off ? WIFI_STATE.off : fixture.connected == null ? WIFI_STATE.idle : WIFI_STATE.connected;
  let slot = fixture.off ? -1 : fixture.connected ?? -1;
  let pending: { slot: number; at: number } | null = null;
  let error = "";
  let now = 0;
  const log: string[] = [];

  const status = (): WifiStatus => ({
    state,
    ssid: state === WIFI_STATE.connected || state === WIFI_STATE.connecting ? saved[slot] ?? "" : "",
    strength: state === WIFI_STATE.connected ? fixture.strength ?? 3 : 0,
    address: state === WIFI_STATE.connected ? fixture.address ?? "192.168.8.143" : "",
    saved: Array.from({ length: WIFI_SAVED_SLOTS }, (_, index) => ({ slot: index, ssid: saved[index] ?? "" })),
    error,
  });

  const begin = (target: number) => {
    slot = target;
    state = WIFI_STATE.connecting;
    pending = { slot: target, at: now + (fixture.connectTicks ?? 20) };
  };

  const ns: WifiOps = {
    status: () => JSON.stringify(status()),
    setEnabled(on) {
      log.push(`setEnabled ${on}`);
      error = "";
      if (!on) {
        state = WIFI_STATE.off;
        slot = -1;
        pending = null;
        return true;
      }
      if (state !== WIFI_STATE.off) return true;
      const first = saved.findIndex((ssid) => ssid !== "");
      if (first < 0) state = WIFI_STATE.idle;
      else begin(first);
      return true;
    },
    connect(target) {
      log.push(`connect ${target}`);
      if (state === WIFI_STATE.off || !saved[target]) {
        error = state === WIFI_STATE.off ? "Wi-Fi is off" : "That slot holds no connection";
        return false;
      }
      error = "";
      begin(target);
      return true;
    },
  };

  return {
    ns,
    tick() {
      now++;
      if (pending && pending.at <= now) {
        slot = pending.slot;
        state = WIFI_STATE.connected;
        pending = null;
      }
    },
    log,
    status,
  };
}
