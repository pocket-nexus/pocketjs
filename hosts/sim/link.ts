// hosts/sim/link.ts — a deterministic Pocket Link (`globalThis.link`,
// contracts/spec/link.ts) for simulation tests of console system apps.
//
// Nothing here touches a socket. Pairing, catalog replies and install
// streams are fixtures that complete after a fixed number of virtual ticks;
// the caller advances them with tick() once per frame, so every event lands
// on the same frame in every run.

import {
  LINK_FEATURE,
  LINK_PAIR_SCHEME,
  LINK_PAIRING,
  LINK_STATE,
  type LinkCatalogApp,
  type LinkCompanion,
  type LinkEvent,
  type LinkStatus,
} from "../../contracts/spec/link.ts";
import type { LinkOps } from "../../framework/src/link.ts";

export interface SimLinkFixture {
  device?: LinkStatus["device"];
  /** Companions the console already holds keys for. */
  paired?: LinkCompanion[];
  /** Id of a paired companion that is linked at boot. */
  linked?: string | null;
  /** What the linked companion offers. */
  catalog?: LinkCatalogApp[];
  /** Ticks from pair() to the paired state. Default 30. */
  pairTicks?: number;
  /** Ticks from catalog() to its reply. Default 6. */
  catalogTicks?: number;
  /** Ticks between install progress events. Default 5. */
  installStepTicks?: number;
  /** Progress events before install.done. Default 4. */
  installSteps?: number;
  /** pair() of a parseable URI fails with this reason instead of pairing. */
  refusePairing?: string;
  /** install(appId) fails with this message. */
  installErrors?: Record<string, string>;
  /** The companion's UTC offset in the status clock. Default 480. */
  clockOffsetMinutes?: number;
}

/** What install.done hands the console's app table. */
export interface SimInstalledApp {
  output: string;
  id: string;
  title: string;
  version: string;
  bytes: number;
}

export interface SimLinkHooks {
  /** install.done committed a package. */
  onInstalled?(app: SimInstalledApp): void;
  /** remove(appId) — return false to refuse (running app, launcher). */
  onRemove?(appId: string): boolean;
}

export interface SimLinkHost {
  readonly ns: LinkOps;
  /** Advance one virtual tick: due events become visible to poll(). */
  tick(): void;
  /** Every guest call, in order ("pair <uri>", "catalog 1", …). */
  readonly log: string[];
  /** Replace the offered catalog and send catalog.changed. */
  setCatalog(apps: LinkCatalogApp[]): void;
  /** Drop the connection (state "searching") or bring it back ("linked"). */
  setLinked(linked: boolean): void;
  status(): LinkStatus;
}

interface Scheduled {
  at: number;
  run: () => void;
}

/** Parse a pocketlink://pair URI into the companion it names; null when malformed. */
export function parsePairingUri(uri: string): LinkCompanion | null {
  if (!uri.startsWith(`${LINK_PAIR_SCHEME}?`)) return null;
  const query = new URLSearchParams(uri.slice(LINK_PAIR_SCHEME.length + 1));
  const id = query.get("c") ?? "";
  const hosts = (query.get("h") ?? "").split(",").filter(Boolean);
  const port = Number(query.get("p"));
  const secret = query.get("s") ?? "";
  if (!/^[0-9a-f]{16}$/.test(id) || hosts.length === 0 || !Number.isInteger(port) || !/^[0-9a-f]{32}$/.test(secret)) return null;
  return { id, name: query.get("n") ?? "Mac", address: hosts[0]!, port };
}

export function createSimLinkHost(fixture: SimLinkFixture = {}, hooks: SimLinkHooks = {}): SimLinkHost {
  const device = fixture.device ?? { id: "3d50000000000001", name: "Evan's 3DS", model: "New Nintendo 3DS XL", address: "192.168.8.143" };
  const paired: LinkCompanion[] = [...(fixture.paired ?? [])];
  let companion: LinkCompanion | null = paired.find((entry) => entry.id === fixture.linked) ?? null;
  let state: LinkStatus["state"] = companion ? LINK_STATE.linked : paired.length ? LINK_STATE.searching : LINK_STATE.unpaired;
  let pairing: LinkStatus["pairing"] = LINK_PAIRING.idle;
  let error = "";
  let catalog = [...(fixture.catalog ?? [])];
  let now = 0;
  let nextId = 1;
  const queue: Scheduled[] = [];
  const visible: LinkEvent[] = [];
  const log: string[] = [];

  const schedule = (ticks: number, run: () => void) => queue.push({ at: now + Math.max(1, ticks), run });
  // The console keeps the companion's clock once one has linked (link.ts).
  let everLinked = state === LINK_STATE.linked;
  const features = () => (state === LINK_STATE.linked ? [LINK_FEATURE.net, LINK_FEATURE.catalog, LINK_FEATURE.install] : []);

  const status = (): LinkStatus => ({
    state,
    companion,
    paired: paired.map((entry) => ({ ...entry })),
    device: { ...device },
    pairing,
    error,
    features: features(),
    clock: everLinked ? { utc: Date.now(), offsetMinutes: fixture.clockOffsetMinutes ?? 480 } : null,
  });

  const ns: LinkOps = {
    status: () => JSON.stringify(status()),
    pair(uri) {
      log.push(`pair ${uri}`);
      const target = parsePairingUri(uri);
      if (!target) return false;
      pairing = LINK_PAIRING.connecting;
      error = "";
      schedule(fixture.pairTicks ?? 30, () => {
        if (fixture.refusePairing) {
          pairing = LINK_PAIRING.failed;
          error = fixture.refusePairing;
          return;
        }
        if (!paired.some((entry) => entry.id === target.id)) paired.push(target);
        pairing = LINK_PAIRING.paired;
        companion = target;
        state = LINK_STATE.linked;
        everLinked = true;
      });
      return true;
    },
    forget(id) {
      log.push(`forget ${id}`);
      const index = paired.findIndex((entry) => entry.id === id);
      if (index < 0) return false;
      paired.splice(index, 1);
      if (companion?.id === id) companion = null;
      state = companion ? LINK_STATE.linked : paired.length ? LINK_STATE.searching : LINK_STATE.unpaired;
      return true;
    },
    catalog() {
      if (state !== LINK_STATE.linked) return -1;
      const id = nextId++;
      log.push(`catalog ${id}`);
      schedule(fixture.catalogTicks ?? 6, () => visible.push({ t: "catalog", id, apps: catalog.map((app) => ({ ...app })) }));
      return id;
    },
    install(appId) {
      if (state !== LINK_STATE.linked) return -1;
      const id = nextId++;
      log.push(`install ${id} ${appId}`);
      const app = catalog.find((entry) => entry.id === appId);
      const failure = fixture.installErrors?.[appId] ?? (app ? null : `${appId} is not offered`);
      if (failure || !app) {
        schedule(2, () => visible.push({ t: "error", id, message: failure ?? "not offered" }));
        return id;
      }
      const steps = fixture.installSteps ?? 4;
      const stepTicks = fixture.installStepTicks ?? 5;
      for (let step = 1; step <= steps; step++) {
        const received = Math.round((app.bytes * step) / steps);
        schedule(step * stepTicks, () =>
          visible.push({ t: "install.progress", id, app: appId, received, bytes: app.bytes }));
      }
      schedule((steps + 1) * stepTicks, () => {
        hooks.onInstalled?.({ output: app.output, id: app.id, title: app.title, version: app.version, bytes: app.bytes });
        visible.push({ t: "install.done", id, app: appId, output: app.output, hash: app.hash });
      });
      return id;
    },
    remove(appId) {
      log.push(`remove ${appId}`);
      return hooks.onRemove ? hooks.onRemove(appId) : false;
    },
    poll() {
      if (visible.length === 0) return undefined;
      return JSON.stringify(visible.splice(0));
    },
  };

  return {
    ns,
    tick() {
      now++;
      // Due work runs in schedule order, so two events due on one tick keep it.
      for (let index = 0; index < queue.length; ) {
        if (queue[index]!.at <= now) queue.splice(index, 1)[0]!.run();
        else index++;
      }
    },
    log,
    setCatalog(apps) {
      catalog = [...apps];
      if (state === LINK_STATE.linked) visible.push({ t: "catalog.changed" });
    },
    setLinked(linked) {
      if (linked) {
        companion = companion ?? paired[0] ?? null;
        state = companion ? LINK_STATE.linked : LINK_STATE.unpaired;
      } else {
        state = paired.length ? LINK_STATE.searching : LINK_STATE.unpaired;
      }
    },
    status,
  };
}
