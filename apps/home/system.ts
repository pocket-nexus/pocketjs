// apps/home/system.ts — Home's view of the console: installed apps (the
// launcher's app table), the Pocket Link, the Wi-Fi radio, the linked Mac's
// catalog and installs in flight, and the clock.
//
// Host state is polled, never pushed: link and Wi-Fi status are re-read every
// POLL_FRAMES frames and on every link event, and each signal only changes
// when the JSON it was read from changed, so an idle console re-renders
// nothing.

import { createSignal, type Accessor } from "solid-js";
import { getOps } from "@pocketjs/framework/host";
import { launchApp } from "@pocketjs/framework/launcher";
import { onFrame } from "@pocketjs/framework/lifecycle";
import {
  forgetCompanion,
  installApp,
  LINK_PAIRING,
  LINK_STATE,
  linkHost,
  linkStatus,
  onLinkEvent,
  pairCompanion,
  removeApp,
  requestCatalog,
  type LinkCatalogApp,
  type LinkStatus,
} from "@pocketjs/framework/link";
import { connectSavedNetwork, setWifiEnabled, wifiHost, wifiStatus, type WifiStatus } from "@pocketjs/framework/wifi";
import { DEFAULT_OFFSET } from "./clock.ts";
import { toAscii } from "./ui/text.ts";

const POLL_FRAMES = 30;
/** While something is changing (a connection, a pairing), poll faster. */
const BUSY_POLL_FRAMES = 6;

export interface HomeApp {
  output: string;
  id: string;
  title: string;
  version: string;
  bytes: number;
}

export interface HomeTable {
  apps: HomeApp[];
  current: string;
  resume: string | null;
  launcher: string;
  lastError: { output: string; message: string } | null;
}

export interface Install {
  received: number;
  bytes: number;
  error: string;
  done: boolean;
}

export type CatalogState = "idle" | "loading" | "ready" | "error";

const sameJson = <T,>(a: T, b: T) => JSON.stringify(a) === JSON.stringify(b);

/** The 3DS app table as the host writes it, every field kept (the framework's
 *  appTable() keeps only apps/current/resume). Runtime strings fold to ASCII. */
export function readAppTable(): HomeTable {
  const empty: HomeTable = { apps: [], current: "", resume: null, launcher: "", lastError: null };
  const raw = getOps().appTable?.();
  if (!raw) return empty;
  try {
    const parsed = JSON.parse(raw) as Partial<HomeTable> & { apps?: Partial<HomeApp>[] };
    return {
      apps: (parsed.apps ?? [])
        .filter((app) => typeof app.output === "string" && app.output !== parsed.launcher)
        .map((app) => ({
          output: app.output!,
          id: app.id ?? app.output!,
          title: toAscii(app.title ?? app.output!),
          version: toAscii(app.version ?? ""),
          bytes: app.bytes ?? 0,
        })),
      current: parsed.current ?? "",
      resume: parsed.resume ?? null,
      launcher: parsed.launcher ?? "",
      lastError: parsed.lastError ? { output: parsed.lastError.output, message: toAscii(parsed.lastError.message) } : null,
    };
  } catch {
    return empty;
  }
}

function readLink(): LinkStatus {
  const status = linkStatus();
  return {
    ...status,
    companion: status.companion ? { ...status.companion, name: toAscii(status.companion.name) } : null,
    paired: status.paired.map((entry) => ({ ...entry, name: toAscii(entry.name) })),
    device: { ...status.device, name: toAscii(status.device.name), model: toAscii(status.device.model) },
    error: toAscii(status.error),
    // The clock moves on every read; Home keeps it apart as a skew (below) so
    // an unchanged link stays equal and nothing redraws for it.
    clock: null,
  };
}

/** The Mac's clock as a whole-second skew from Date.now(), and its offset. */
function readClock(): { skew: number; offset: number } | null {
  const clock = linkStatus().clock;
  if (!clock) return null;
  return { skew: Math.round((clock.utc - Date.now()) / 1000) * 1000, offset: clock.offsetMinutes };
}

function readWifi(): WifiStatus | null {
  const status = wifiStatus();
  if (!status) return null;
  return {
    ...status,
    ssid: toAscii(status.ssid),
    saved: status.saved.map((entry) => ({ ...entry, ssid: toAscii(entry.ssid) })),
    error: toAscii(status.error),
  };
}

export interface HomeSystem {
  now: Accessor<number>;
  offset: Accessor<number>;
  /** True while the time comes from the paired Mac's clock. */
  macClock: Accessor<boolean>;
  setOffset(minutes: number): void;
  table: Accessor<HomeTable>;
  link: Accessor<LinkStatus>;
  hasLink: boolean;
  wifi: Accessor<WifiStatus | null>;
  hasWifi: boolean;
  catalog: Accessor<LinkCatalogApp[]>;
  catalogState: Accessor<CatalogState>;
  catalogError: Accessor<string>;
  installs: Accessor<Record<string, Install>>;
  refresh(): void;
  loadCatalog(): void;
  install(app: LinkCatalogApp): void;
  remove(app: HomeApp): boolean;
  launch(output: string): boolean;
  pair(uri: string): boolean;
  forget(id: string): boolean;
  setWifi(on: boolean): void;
  connect(slot: number): void;
  /** True once since the link last became "linked". */
  linked: Accessor<boolean>;
}

export function createHomeSystem(): HomeSystem {
  // Wall time: the paired Mac's clock once one has linked (the 3DS clock is
  // often unset), otherwise the console's own clock, which reads local time
  // as if it were UTC; the Time Zone page shifts only that fallback.
  const [tick, setTick] = createSignal(Date.now());
  const [manualOffset, setOffset] = createSignal(DEFAULT_OFFSET);
  const [table, setTable] = createSignal(readAppTable(), { equals: sameJson });
  const [link, setLink] = createSignal(readLink(), { equals: sameJson });
  const [clock, setClock] = createSignal(readClock(), { equals: sameJson });
  const [wifi, setWifiStatus] = createSignal(readWifi(), { equals: sameJson });
  const [catalog, setCatalog] = createSignal<LinkCatalogApp[]>([], { equals: sameJson });
  const [catalogState, setCatalogState] = createSignal<CatalogState>("idle");
  const [catalogError, setCatalogError] = createSignal("");
  const [installs, setInstalls] = createSignal<Record<string, Install>>({});
  const hasLink = linkHost() !== null;
  const hasWifi = wifiHost() !== null;

  const refresh = () => {
    setLink(readLink());
    setClock(readClock());
    setWifiStatus(readWifi());
  };

  let catalogRequest = 0;
  const loadCatalog = () => {
    if (link().state !== LINK_STATE.linked) {
      setCatalogState("idle");
      return;
    }
    const request = ++catalogRequest;
    setCatalogState("loading");
    setCatalogError("");
    requestCatalog().then(
      (apps) => {
        if (request !== catalogRequest) return;
        setCatalog(apps.map((app) => ({ ...app, title: toAscii(app.title), version: toAscii(app.version), summary: toAscii(app.summary) })));
        setCatalogState("ready");
      },
      (error: Error) => {
        if (request !== catalogRequest) return;
        setCatalogError(toAscii(error.message));
        setCatalogState("error");
      },
    );
  };

  // The catalog follows the link: fetched when it comes up, refetched when
  // the companion says its offer changed.
  let wasLinked = link().state === LINK_STATE.linked;
  const [linked, setLinked] = createSignal(wasLinked);
  if (hasLink) {
    onLinkEvent((event) => {
      if (event.t === "catalog.changed") loadCatalog();
      refresh();
    });
  }

  let frames = 0;
  const busy = () =>
    wifi()?.state === "connecting" || link().state === LINK_STATE.connecting || link().pairing === LINK_PAIRING.connecting;
  onFrame(() => {
    frames++;
    if (frames % POLL_FRAMES === 0) {
      setTick(Date.now());
      refresh();
      if (frames % (POLL_FRAMES * 4) === 0) setTable(readAppTable());
    } else if (frames % BUSY_POLL_FRAMES === 0 && busy()) {
      refresh();
    }
    const isLinked = link().state === LINK_STATE.linked;
    if (isLinked !== wasLinked) {
      wasLinked = isLinked;
      setLinked(isLinked);
      if (isLinked) loadCatalog();
      else setCatalogState("idle");
    }
  });
  if (wasLinked) loadCatalog();

  const setInstall = (id: string, value: Install | null) => {
    const next = { ...installs() };
    if (value) next[id] = value;
    else delete next[id];
    setInstalls(next);
  };

  const now = () => {
    tick();
    return Date.now() + (clock()?.skew ?? 0);
  };
  const offset = () => clock()?.offset ?? manualOffset();

  return {
    now,
    offset,
    macClock: () => clock() !== null,
    setOffset,
    table,
    link,
    hasLink,
    wifi,
    hasWifi,
    catalog,
    catalogState,
    catalogError,
    installs,
    refresh() {
      refresh();
      setTable(readAppTable());
    },
    loadCatalog,
    install(app) {
      const current = installs()[app.id];
      if (current && !current.done && !current.error) return;
      setInstall(app.id, { received: 0, bytes: app.bytes, error: "", done: false });
      installApp(app.id, (progress) => setInstall(app.id, { received: progress.received, bytes: progress.bytes, error: "", done: false })).then(
        () => {
          setInstall(app.id, { received: app.bytes, bytes: app.bytes, error: "", done: true });
          setTable(readAppTable());
        },
        (error: Error) => setInstall(app.id, { received: 0, bytes: app.bytes, error: toAscii(error.message), done: false }),
      );
    },
    remove(app) {
      const ok = removeApp(app.id);
      setTable(readAppTable());
      setInstall(app.id, null);
      return ok;
    },
    launch: (output) => launchApp(output),
    pair(uri) {
      const ok = pairCompanion(uri);
      refresh();
      return ok;
    },
    forget(id) {
      const ok = forgetCompanion(id);
      refresh();
      return ok;
    },
    setWifi(on) {
      setWifiEnabled(on);
      refresh();
    },
    connect(slot) {
      connectSavedNetwork(slot);
      refresh();
    },
    linked,
  };
}

export { LINK_PAIRING, LINK_STATE };

/** "48 KB", "1.2 MB" */
export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
