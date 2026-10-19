// apps/home/clock.ts — wall-clock fields from Date.now() arithmetic alone.
//
// The 3DS host's QuickJS breaks down local time incorrectly
// (Date.prototype.getHours/getMinutes/getDay), and the console reports no
// time zone, so Home never asks Date for fields: it adds its own UTC offset
// to the epoch and converts days to a civil date with Howard Hinnant's
// days-to-civil algorithm (proleptic Gregorian, exact for every int day).

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
export const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

export interface CivilTime {
  year: number;
  /** 1..12 */
  month: number;
  /** 1..31 */
  day: number;
  hour: number;
  minute: number;
  /** 0 = Sunday */
  weekday: number;
}

/** Year, month and day of `days` since 1970-01-01. */
export function civilFromDays(days: number): { year: number; month: number; day: number } {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  return { year: yoe + era * 400 + (month <= 2 ? 1 : 0), month, day };
}

/** The civil time at `epochMs` in a zone `offsetMinutes` east of UTC. */
export function civilFromEpoch(epochMs: number, offsetMinutes: number): CivilTime {
  const minutes = Math.floor(epochMs / 60000) + offsetMinutes;
  const days = Math.floor(minutes / 1440);
  const inDay = minutes - days * 1440;
  return {
    ...civilFromDays(days),
    hour: Math.floor(inDay / 60),
    minute: inDay % 60,
    // 1970-01-01 was a Thursday.
    weekday: (((days + 4) % 7) + 7) % 7,
  };
}

/** "9:41" — the lock-screen clock, 12-hour without a meridiem. */
export function clockText(time: CivilTime): string {
  const hour = time.hour % 12 === 0 ? 12 : time.hour % 12;
  return `${hour}:${String(time.minute).padStart(2, "0")}`;
}

/** "9:41 AM" — the status bar. */
export function statusTime(time: CivilTime): string {
  return `${clockText(time)} ${time.hour < 12 ? "AM" : "PM"}`;
}

/** "Monday, October 19" */
export function dateText(time: CivilTime): string {
  return `${WEEKDAYS[time.weekday]}, ${MONTHS[time.month - 1]} ${time.day}`;
}

/** "UTC+8", "UTC-3:30", "UTC" */
export function offsetText(offsetMinutes: number): string {
  if (offsetMinutes === 0) return "UTC";
  const sign = offsetMinutes > 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const minutes = abs % 60;
  return `UTC${sign}${Math.floor(abs / 60)}${minutes ? `:${String(minutes).padStart(2, "0")}` : ""}`;
}

/** The offsets Settings > General > Time Zone offers, with a place for each. */
export const TIME_ZONES: readonly { offset: number; place: string }[] = [
  { offset: -600, place: "Honolulu" },
  { offset: -480, place: "Los Angeles" },
  { offset: -420, place: "Denver" },
  { offset: -360, place: "Chicago" },
  { offset: -300, place: "New York" },
  { offset: -180, place: "Sao Paulo" },
  { offset: 0, place: "London" },
  { offset: 60, place: "Paris, Berlin" },
  { offset: 120, place: "Athens, Cairo" },
  { offset: 180, place: "Moscow" },
  { offset: 240, place: "Dubai" },
  { offset: 330, place: "Mumbai" },
  { offset: 420, place: "Bangkok" },
  { offset: 480, place: "Beijing, Singapore" },
  { offset: 540, place: "Tokyo, Seoul" },
  { offset: 600, place: "Sydney" },
  { offset: 720, place: "Auckland" },
];

/** The console's clock already reads local time, so its fallback offset is 0. */
export const DEFAULT_OFFSET = 0;
