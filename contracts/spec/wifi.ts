// PocketJS wifi spec — the console's own wireless settings (`globalThis.wifi`,
// capability "system.wifi").
//
// The console owns the radio and its saved connections; this module reads
// them and asks the system to act on them. On a console with its own
// settings (the 3DS) it never writes a saved connection: creating one stays
// in those settings, so a guest can never leave the system configuration in
// a state the console's settings cannot repair. A console whose launcher is
// its only settings (the M5Stack Tab5) also offers scan, join and forget;
// they are absent elsewhere.
//
// A host on a general operating system (Linux with NetworkManager, Android)
// adapts the same module to it: the system keeps any number of saved
// connections and reports them all in `saved` (WIFI_SAVED_SLOTS bounds the
// consoles' own), marks the scanned networks it holds a connection for, and
// may offer disconnect and its own settings. An op the system refuses its
// apps returns false with the reason in `error`; openSettings shows the
// system's own Wi-Fi settings, where that action is done.
//
//   status() -> string        JSON WifiStatus, read this call
//   setEnabled(on) -> bool    turn the radio on or off; false when refused
//   connect(slot) -> bool     connect through saved connection `slot`
//                             (WifiSavedNetwork.slot);
//                             the result shows in later status() reads
//   scan() -> bool            start a scan; WifiStatus.networks holds the
//                             result once WifiStatus.scanning is false
//   join(ssid, passphrase) -> bool
//                             connect to `ssid` ("" passphrase for an open
//                             network) and save it in a slot once connected,
//                             replacing the least recently used slot
//   forget(slot) -> bool      clear saved connection `slot`
//   disconnect() -> bool      leave the network in use; the radio stays on
//                             and its saved connection stays
//   openSettings() -> bool    show the system's own Wi-Fi settings; hosts
//                             on a system that has them
//   startAccessPoint(ssid) -> bool
//                             also serve an open access point named `ssid`
//                             (1..32 bytes) beside the station connection,
//                             with an HTTP page at its address; hosts that
//                             can, the M5Stack Tab5 among them
//   stopAccessPoint() -> bool stop serving it
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
  /** The index connect(slot) and forget(slot) take: 0..2 on a console,
   *  0..saved.length - 1 on a host whose system keeps more. */
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
  /** Hosts with scan(): a scan is running. */
  scanning?: boolean;
  /** Hosts with scan(): the last scan's networks, strongest first, one entry
   *  per SSID. */
  networks?: WifiNetwork[];
  /** Hosts with startAccessPoint(): the access point the console serves. */
  accessPoint?: WifiAccessPoint;
}

export interface WifiAccessPoint {
  on: boolean;
  /** "" while off. */
  ssid: string;
  /** The access point's IPv4 address, where its page is served. */
  address: string;
  /** Stations associated now. */
  stations: number;
}

export interface WifiNetwork {
  ssid: string;
  /** 0..3 bars. */
  strength: number;
  /** A passphrase is required. */
  secure: boolean;
  /** Hosts that measure it: the signal, 0..100. */
  signal?: number;
  /** Hosts that report it: the system holds a saved connection for this
   *  network, so connect(slot) reaches it with no passphrase. */
  saved?: boolean;
}
