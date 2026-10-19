// PocketJS wifi spec — the console's own wireless settings (`globalThis.wifi`,
// capability "system.wifi").
//
// The console owns the radio and its saved connections; this module reads
// them and asks the system to act on them. It never writes a saved
// connection: creating one (SSID + passphrase) stays in the console's own
// settings, so a guest can never leave the system configuration in a state
// the console's settings cannot repair.
//
//   status() -> string        JSON WifiStatus, read this call
//   setEnabled(on) -> bool    turn the radio on or off; false when refused
//   connect(slot) -> bool     connect through saved connection `slot` (0..2);
//                             the result shows in later status() reads
//
// Turning the radio off closes every connection, the Pocket Link and the dev
// wire included.

export const WIFI_SAVED_SLOTS = 3;

export const WIFI_STATE = {
  off: "off",
  /** Radio on, no access point. */
  idle: "idle",
  connecting: "connecting",
  connected: "connected",
} as const;
export type WifiState = (typeof WIFI_STATE)[keyof typeof WIFI_STATE];

export interface WifiSavedNetwork {
  slot: number;
  /** "" when the slot holds no connection. */
  ssid: string;
}

export interface WifiStatus {
  state: WifiState;
  /** The access point in use; "" when not connected. */
  ssid: string;
  /** 0..3 bars. */
  strength: number;
  /** The console's IPv4 address; "" when it has none. */
  address: string;
  saved: WifiSavedNetwork[];
  /** Human-readable reason for the last refused or failed action. */
  error: string;
}
