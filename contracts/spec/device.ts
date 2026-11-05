// PocketJS device spec — the board's own controls (`globalThis.device`,
// capability "system.device").
//
// The module reads and sets what the board itself owns: the display
// backlight, the speaker level, the power rails and the plugs it detects,
// the pins it leaves free on its headers, its removable card, and its power.
// A board lists the parts it has in DeviceStatus; an op naming a part the
// board lacks returns false. Every op is synchronous and bounded: a board
// reads its sensors and IO expanders inside the call or serves a value it
// refreshed at most DEVICE_STATUS_MAX_AGE_MS earlier.
//
//   status() -> string               JSON DeviceStatus, read this call
//   setBrightness(percent) -> bool   display backlight, 0..100
//   setVolume(percent) -> bool       speaker output level, 0..100
//   setSwitch(id, on) -> bool        turn one of DeviceStatus.switches on or off
//   setPin(pin, level) -> bool       drive one of DeviceStatus.pins as a
//                                    push-pull output at level 0 or 1
//   releasePin(pin) -> bool          return a pin to its reset state (input,
//                                    no pull)
//   listDirectory(path) -> string    JSON DeviceDirectory of a directory on the
//                                    removable card, "/" its root; "" when the
//                                    card is absent or the path is not a
//                                    directory
//   powerOff() -> bool               cut the board's power; false where the
//                                    board cannot. A board whose RTC or motion
//                                    sensor can wake it powers back on when
//                                    one was armed before the call.
//
// The module never names another app's files: listDirectory reads names and
// sizes, not contents, and the app's own tree stays behind data.fs.

export const DEVICE_STATUS_MAX_AGE_MS = 500;

/** Entries a listDirectory result holds at most; `truncated` marks more. */
export const DEVICE_DIRECTORY_MAX_ENTRIES = 64;

/** Bytes of a listDirectory path at most. */
export const DEVICE_PATH_MAX_BYTES = 128;

export interface DeviceDisplay {
  /** Backlight, 0..100. */
  brightness: number;
  /** The panel controller the board detected ("ST7123"); "" when unknown. */
  panel: string;
}

/** A power rail or routing switch the board lets software set. */
export interface DeviceSwitch {
  /** Stable id for setSwitch ("charge", "usb-5v", "antenna"). */
  id: string;
  label: string;
  on: boolean;
}

/** A plug or presence the board detects. */
export interface DevicePort {
  id: string;
  label: string;
  connected: boolean;
}

export interface DeviceCard {
  mounted: boolean;
  totalBytes: number;
  freeBytes: number;
}

export interface DeviceStatus {
  display: DeviceDisplay;
  /** Speaker output level, 0..100. */
  volume: number;
  /** The SoC's temperature in degrees Celsius; null without a sensor. */
  temperature: number | null;
  switches: DeviceSwitch[];
  ports: DevicePort[];
  /** Header pins setPin and releasePin accept, in header order. */
  pins: number[];
  card: DeviceCard;
  /** Human-readable reason for the last refused or failed op; "" after one
   *  that succeeded. */
  error: string;
}

export interface DeviceDirectoryEntry {
  name: string;
  directory: boolean;
  /** Bytes; 0 for a directory. */
  size: number;
}

export interface DeviceDirectory {
  path: string;
  entries: DeviceDirectoryEntry[];
  truncated: boolean;
}
