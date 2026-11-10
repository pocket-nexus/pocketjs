// Pocket Link 2 paged row lists (docs/POCKET-LINK.md §6.2 `runtime.apps`,
// §6.4 `catalog`): cutting a list into pages of whole rows that fit the
// connection's payload limit, Hub's assembly of a `runtime.apps` report, and
// Hub's catalog snapshot with its 30 s life on an injected clock.

import {
  LINK2_APPS_MAX_ROWS,
  LINK2_APP_ID_BYTES,
  LINK2_APP_OUTPUT_BYTES,
  LINK2_APP_VERSION_BYTES,
  LINK2_CATALOG_MAX_APPS,
  LINK2_CATALOG_SNAPSHOT_MS,
  LINK2_CATALOG_SUMMARY_BYTES,
  LINK2_CATALOG_TITLE_BYTES,
  type Link2CatalogApp,
  type Link2CatalogReply,
  type Link2InstalledApp,
  type Link2RuntimeAppsEvent,
} from "../../../contracts/spec/link2.ts";
import { LinkCloseError, encodedBytes, encodedPrefix, jsonBytes } from "./protocol.ts";

/** Fills a page with as many whole rows as `fits` allows, at least one. */
function fill<Row>(rows: readonly Row[], from: number, fits: (page: Row[]) => boolean): Row[] {
  const page: Row[] = [];
  for (let i = from; i < rows.length; i++) {
    page.push(rows[i]);
    if (page.length > 1 && !fits(page)) {
      page.pop();
      break;
    }
  }
  if (page.length > 0 && !fits(page)) throw new RangeError("one row does not fit the payload limit");
  return page;
}

// ---------------------------------------------------------------------------
// §6.2 runtime.apps
// ---------------------------------------------------------------------------

/** The device's report as pages: one event when the rows fit one frame of
 *  `payloadLimit`, several otherwise. Rows keep their order, a row never
 *  spans two pages, and `at` is the count of rows in the pages before. */
export function pageRuntimeApps(rows: readonly Link2InstalledApp[], set: number, payloadLimit: number): Link2RuntimeAppsEvent[] {
  if (rows.length > LINK2_APPS_MAX_ROWS) throw new RangeError("a report holds at most 64 rows");
  const event = (at: number, apps: Link2InstalledApp[], more: boolean): Link2RuntimeAppsEvent => ({ t: "runtime.apps", set, at, apps, more });
  if (rows.length === 0) return [event(0, [], false)];
  const pages: Link2RuntimeAppsEvent[] = [];
  let at = 0;
  while (at < rows.length) {
    // `more: false` is one byte longer than `more: true`; size a page for it.
    const apps = fill(rows, at, (page) => jsonBytes(event(at, page, false)) <= payloadLimit);
    pages.push(event(at, apps, at + apps.length < rows.length));
    at += apps.length;
  }
  return pages;
}

/** Hub's side: it replaces the set it holds when the page with `more: false`
 *  arrives and every page of that `set` from `at` 0 arrived before it in
 *  order. One rule for every page that does not continue the set; the link
 *  closes only for a report of more than 64 rows. */
export class RuntimeAppsAssembler {
  /** The last complete set. */
  apps: Link2InstalledApp[] = [];
  private highest = 0;
  private partial: Link2InstalledApp[] | null = null;
  private dropped = false;

  /** Returns the new complete set, or null while the earlier one stands. */
  page(page: Link2RuntimeAppsEvent): Link2InstalledApp[] | null {
    if (page.set < this.highest) return null;
    if (page.set === this.highest && (this.dropped || this.partial === null)) return null;
    if (page.set > this.highest) {
      this.highest = page.set;
      this.partial = [];
      this.dropped = false;
    }
    const partial = this.partial as Link2InstalledApp[];
    if (page.at !== partial.length) {
      this.partial = null;
      this.dropped = true;
      return null;
    }
    partial.push(...page.apps);
    if (partial.length > LINK2_APPS_MAX_ROWS) throw new LinkCloseError("protocol", "runtime.apps: more than 64 rows");
    if (page.more) return null;
    this.apps = partial;
    this.partial = null;
    return this.apps;
  }
}

// ---------------------------------------------------------------------------
// §6.4 catalog
// ---------------------------------------------------------------------------

const utf8 = new TextEncoder();
/** Ascending by the bytes of the UTF-8 form. */
export function compareIdBytes(a: string, b: string): number {
  return Buffer.compare(utf8.encode(a), utf8.encode(b));
}

/** Hub's offer as rows (§6.4): one per app id, `title` and `summary` cut to
 *  their limits on a code point, an app whose `id`, `output` or `version` is
 *  over its limit left out, ordered by `id` in byte order, the first 64. */
export function catalogRows(offer: readonly Link2CatalogApp[]): Link2CatalogApp[] {
  const seen = new Set<string>();
  const rows: Link2CatalogApp[] = [];
  for (const app of offer) {
    if (seen.has(app.id)) continue;
    seen.add(app.id);
    if (app.id.length === 0 || encodedBytes(app.id) > LINK2_APP_ID_BYTES) continue;
    if (encodedBytes(app.output) > LINK2_APP_OUTPUT_BYTES || encodedBytes(app.version) > LINK2_APP_VERSION_BYTES) continue;
    rows.push({
      id: app.id,
      title: encodedPrefix(app.title, LINK2_CATALOG_TITLE_BYTES),
      version: app.version,
      summary: encodedPrefix(app.summary, LINK2_CATALOG_SUMMARY_BYTES),
      output: app.output,
      hash: app.hash,
      bytes: app.bytes,
    });
  }
  rows.sort((a, b) => compareIdBytes(a.id, b.id));
  return rows.slice(0, LINK2_CATALOG_MAX_APPS);
}

export type CatalogAnswer = { reply: Link2CatalogReply } | { error: "changed" | "malformed" };

/**
 * Hub's catalog for one connection. `changed()` raises the offer's revision
 * (and is when Hub sends `catalog.changed`). A first page takes a snapshot of
 * the offer's rows at that revision; later pages with that `rev` are served
 * from it whether or not the offer changed since, and each extends its life
 * to 30 s. One snapshot per connection: a newer first page replaces it.
 */
export class CatalogPager {
  private rev = 1;
  private snapshot: { rev: number; rows: Link2CatalogApp[]; until: number } | null = null;
  constructor(private offer: () => readonly Link2CatalogApp[], private readonly now: () => number) {}

  /** The offer changed. Returns the new revision. */
  changed(): number {
    this.rev = (this.rev + 1) >>> 0;
    return this.rev;
  }
  get revision(): number {
    return this.rev;
  }

  request(request: { after?: unknown; rev?: unknown }, payloadLimit: number): CatalogAnswer {
    const now = this.now();
    if (request.after === undefined && request.rev === undefined) {
      this.snapshot = { rev: this.rev, rows: catalogRows(this.offer()), until: now + LINK2_CATALOG_SNAPSHOT_MS };
      return { reply: this.cut(0, payloadLimit) };
    }
    if (typeof request.after !== "string" || encodedBytes(request.after) > LINK2_APP_ID_BYTES) return { error: "malformed" };
    if (typeof request.rev !== "number" || !Number.isInteger(request.rev)) return { error: "malformed" };
    if (this.snapshot !== null && now >= this.snapshot.until) this.snapshot = null;
    if (this.snapshot === null || this.snapshot.rev !== request.rev) return { error: "changed" };
    const index = this.snapshot.rows.findIndex((row) => row.id === request.after);
    if (index < 0) return { error: "malformed" };
    this.snapshot.until = now + LINK2_CATALOG_SNAPSHOT_MS;
    return { reply: this.cut(index + 1, payloadLimit) };
  }

  private cut(from: number, payloadLimit: number): Link2CatalogReply {
    const { rows, rev } = this.snapshot!;
    const apps = fill(rows, from, (page) => jsonBytes({ apps: page, rev, more: false }) <= payloadLimit);
    return { apps, rev, more: from + apps.length < rows.length };
  }
}

export type CatalogFetchStep =
  | { send: { t: "catalog"; after?: string; rev?: number } }
  | { done: Link2CatalogApp[] }
  | { failed: string };

/**
 * The device's catalog fetch (§6.4): one at a time on a connection, each page
 * asked for after the one before was consumed. A `changed` answer discards
 * the pages held and starts again from the first page. A fetch asked for
 * while one runs starts after it.
 */
export class CatalogFetch {
  private rows: Link2CatalogApp[] | null = null;
  private again = false;

  get running(): boolean {
    return this.rows !== null;
  }
  /** `link.catalog`, or a `catalog.changed` event. Null while a fetch runs:
   *  the next one starts when it ends. */
  start(): CatalogFetchStep | null {
    if (this.rows !== null) {
      this.again = true;
      return null;
    }
    this.rows = [];
    return { send: { t: "catalog" } };
  }
  reply(reply: Link2CatalogReply): CatalogFetchStep {
    if (this.rows === null) return { failed: "no fetch is running" };
    this.rows.push(...reply.apps);
    if (reply.more && reply.apps.length > 0) return { send: { t: "catalog", after: reply.apps[reply.apps.length - 1].id, rev: reply.rev } };
    const done = this.rows;
    this.rows = null;
    return { done };
  }
  error(code: string): CatalogFetchStep {
    if (this.rows === null) return { failed: "no fetch is running" };
    if (code === "changed") {
      this.rows = [];
      return { send: { t: "catalog" } };
    }
    this.rows = null;
    return { failed: code };
  }
  /** After a fetch ended: the next one, when one was asked for meanwhile. */
  next(): CatalogFetchStep | null {
    if (this.rows !== null || !this.again) return null;
    this.again = false;
    return this.start();
  }
}
