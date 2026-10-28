// platforms/sim/wifi.ts — a deterministic console radio (`globalThis.wifi`,
// contracts/spec/wifi.ts): three saved connections, an on/off switch and a
// connection that completes a fixed number of virtual ticks after it starts.
// With `networks`, it is a console whose launcher is its settings: scan,
// join and forget, where a join with the passphrase "wrong" fails.

import { WIFI_SAVED_SLOTS, WIFI_STATE, type WifiNetwork, type WifiStatus } from "../../contracts/spec/wifi.ts";
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
  /** Networks a scan finds; present, the radio offers scan/join/forget. */
  networks?: WifiNetwork[];
  /** Ticks from scan() to its result. Default 30. */
  scanTicks?: number;
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
  let pending: { slot: number; at: number; passphrase?: string } | null = null;
  let scanAt: number | null = null;
  let found: WifiNetwork[] = [];
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
    ...(fixture.networks ? { scanning: scanAt !== null, networks: found } : {}),
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
  if (fixture.networks) {
    ns.scan = () => {
      log.push("scan");
      if (state === WIFI_STATE.off) {
        error = "Wi-Fi is off";
        return false;
      }
      scanAt = now + (fixture.scanTicks ?? 30);
      return true;
    };
    ns.join = (ssid, passphrase) => {
      log.push(`join ${ssid}`);
      if (state === WIFI_STATE.off) {
        error = "Wi-Fi is off";
        return false;
      }
      error = "";
      let target = saved.indexOf(ssid);
      if (target < 0) target = Math.max(0, saved.indexOf(""));
      saved[target] = ssid;
      begin(target);
      pending!.passphrase = passphrase;
      return true;
    };
    ns.forget = (target) => {
      log.push(`forget ${target}`);
      if (!saved[target]) return false;
      if (slot === target && state !== WIFI_STATE.off) state = WIFI_STATE.idle;
      saved[target] = "";
      return true;
    };
  }

  return {
    ns,
    tick() {
      now++;
      if (pending && pending.at <= now) {
        slot = pending.slot;
        if (pending.passphrase === "wrong") {
          saved[slot] = "";
          state = WIFI_STATE.idle;
          error = "Incorrect password";
        } else {
          state = WIFI_STATE.connected;
        }
        pending = null;
      }
      if (scanAt !== null && scanAt <= now) {
        found = fixture.networks ?? [];
        scanAt = null;
      }
    },
    log,
    status,
  };
}
