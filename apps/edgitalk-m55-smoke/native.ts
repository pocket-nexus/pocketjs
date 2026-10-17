// Typed wrapper around the firmware's `globalThis.__edgi` bridge.
//
// Every call has a fallback so the same package also runs in a simulator or
// browser host where the native bridge does not exist.

import { TICK_HZ } from "./theme.ts";

export const UNKNOWN_TEMP = -9999;
export const SONG_SLOTS = 8;

export interface DashboardStatus {
  cpu: number;
  ram: number;
  fps: number;
  temp: number;
  tempSource: number;
  wifi: boolean;
  /** True while the board is advertising as EdgiTalk. */
  bt: boolean;
  ssid: string;
  ip: string;
  token: string;
  ap: boolean;
  apSsid: string;
  apPassword: string;
  weather: string;
  weatherTemp: number;
  /** 0 until the board has learned the real date. */
  year: number;
  month: number;
  day: number;
  /** 0 = Sunday. */
  weekday: number;
}

/** Stats pushed by the PC console. `ageMs` is -1 until the first packet arrives. */
export interface PcStats {
  seen: boolean;
  ageMs: number;
  host: string;
  cpu: number;
  ram: number;
  ramUsedMb: number;
  ramTotalMb: number;
  disk: number;
  diskUsedGb: number;
  diskTotalGb: number;
  /** Degrees C, -1 when the PC has no readable sensor. */
  temp: number;
}

export interface MusicStatus {
  track: string;
  index: number;
  count: number;
  volume: number;
  state: number;
  sd: boolean;
}

export interface GameScores {
  best: number[];
  rank: string[];
}

interface NativeBridge {
  status?(): Partial<DashboardStatus>;
  pc?(): Partial<PcStats>;
  musicStatus?(): MusicStatus;
  musicCommand?(command: number): boolean;
  gameStart?(bpm: number, events: number[]): boolean;
  gameStop?(): void;
  gameClock?(): number;
  gameSfx?(id: number): void;
  gameScores?(): { best?: number[]; rank?: string };
  gameSave?(song: number, score: number, rank: number): boolean;
  gameOffset?(): number;
  gameSetOffset?(ms: number): void;
  customSong?(): string;
}

export const fallbackStatus: DashboardStatus = {
  cpu: 0,
  ram: 0,
  fps: TICK_HZ,
  temp: UNKNOWN_TEMP,
  tempSource: 0,
  wifi: false,
  bt: false,
  ssid: "OFFLINE",
  ip: "",
  token: "",
  ap: false,
  apSsid: "",
  apPassword: "",
  weather: "SYNCING",
  weatherTemp: UNKNOWN_TEMP,
  year: 0,
  month: 0,
  day: 0,
  weekday: 0,
};

export const fallbackMusic: MusicStatus = {
  track: "Demo melody", index: 0, count: 1, volume: 50, state: 0, sd: false,
};

function bridge(): NativeBridge | undefined {
  return (globalThis as { __edgi?: NativeBridge }).__edgi;
}

function num(value: unknown, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}

function str(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

export function readStatus(): DashboardStatus {
  const b = bridge();
  if (!b || typeof b.status !== "function") return fallbackStatus;
  const n = b.status();
  return {
    cpu: num(n.cpu, fallbackStatus.cpu),
    ram: num(n.ram, fallbackStatus.ram),
    fps: num(n.fps, fallbackStatus.fps),
    temp: num(n.temp, fallbackStatus.temp),
    tempSource: num(n.tempSource, fallbackStatus.tempSource),
    wifi: n.wifi === true,
    bt: n.bt === true,
    ssid: str(n.ssid, fallbackStatus.ssid),
    ip: str(n.ip, ""),
    token: str(n.token, ""),
    ap: n.ap === true,
    apSsid: str(n.apSsid, ""),
    apPassword: str(n.apPassword, ""),
    weather: str(n.weather, fallbackStatus.weather),
    weatherTemp: num(n.weatherTemp, fallbackStatus.weatherTemp),
    year: num(n.year, 0),
    month: num(n.month, 0),
    day: num(n.day, 0),
    weekday: num(n.weekday, 0),
  };
}

export const fallbackPc: PcStats = {
  seen: false, ageMs: -1, host: "", cpu: 0, ram: 0, ramUsedMb: 0, ramTotalMb: 0,
  disk: 0, diskUsedGb: 0, diskTotalGb: 0, temp: -1,
};

export function readPc(): PcStats {
  const n = bridge()?.pc?.();
  if (!n) return fallbackPc;
  return {
    seen: n.seen === true,
    ageMs: num(n.ageMs, -1),
    host: str(n.host, ""),
    cpu: num(n.cpu, 0),
    ram: num(n.ram, 0),
    ramUsedMb: num(n.ramUsedMb, 0),
    ramTotalMb: num(n.ramTotalMb, 0),
    disk: num(n.disk, 0),
    diskUsedGb: num(n.diskUsedGb, 0),
    diskTotalGb: num(n.diskTotalGb, 0),
    temp: num(n.temp, -1),
  };
}

export function readMusic(): MusicStatus {
  return bridge()?.musicStatus?.() ?? fallbackMusic;
}

export function musicCommand(command: number): void {
  bridge()?.musicCommand?.(command);
}

// -- Game bridge ---------------------------------------------------------------

let fallbackStartedAt = -1;
let fallbackScores: GameScores = {
  best: new Array<number>(SONG_SLOTS).fill(0),
  rank: new Array<string>(SONG_SLOTS).fill("-"),
};
let fallbackOffset = 0;

export const RANKS = ["-", "C", "B", "A", "S"] as const;

export const game = {
  /** Start the synthesizer. `events` is a flat [step, voice, note, len, vol] list. */
  start(bpm: number, events: number[]): boolean {
    const b = bridge();
    if (b?.gameStart) return b.gameStart(bpm, events) === true;
    fallbackStartedAt = Date.now();
    return true;
  },
  stop(): void {
    const b = bridge();
    if (b?.gameStop) b.gameStop();
    fallbackStartedAt = -1;
  },
  /** Audio clock in milliseconds since the song began; -1 while not running. */
  clock(): number {
    const b = bridge();
    if (b?.gameClock) return b.gameClock();
    return fallbackStartedAt < 0 ? -1 : Date.now() - fallbackStartedAt;
  },
  /** 0 perfect, 1 great, 2 miss. */
  sfx(id: number): void {
    bridge()?.gameSfx?.(id);
  },
  scores(): GameScores {
    const b = bridge();
    if (!b?.gameScores) return fallbackScores;
    const raw = b.gameScores();
    const best = new Array<number>(SONG_SLOTS).fill(0);
    const rank = new Array<string>(SONG_SLOTS).fill("-");
    const rawRank = typeof raw.rank === "string" ? raw.rank : "";
    for (let i = 0; i < SONG_SLOTS; i++) {
      best[i] = raw.best && typeof raw.best[i] === "number" ? raw.best[i] : 0;
      const code = rawRank.charAt(i);
      rank[i] = code === "" ? "-" : code;
    }
    return { best, rank };
  },
  save(song: number, score: number, rank: number): void {
    const b = bridge();
    if (b?.gameSave) {
      b.gameSave(song, score, rank);
      return;
    }
    if (score > fallbackScores.best[song]) {
      fallbackScores.best[song] = score;
      fallbackScores.rank[song] = RANKS[rank] ?? "-";
    }
  },
  offset(): number {
    const b = bridge();
    return b?.gameOffset ? b.gameOffset() : fallbackOffset;
  },
  setOffset(ms: number): void {
    const b = bridge();
    if (b?.gameSetOffset) b.gameSetOffset(ms);
    else fallbackOffset = ms;
  },
  customSong(): string {
    return bridge()?.customSong?.() ?? "";
  },
};
