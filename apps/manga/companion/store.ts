import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { LibraryIndex, SeriesSummary } from "../model.ts";
import { publishCatalog } from "./packs.ts";
import type { Source } from "./sources.ts";

export interface ImportRequest { source?: string; book?: string; url?: string; title?: string; language: string; from?: number; to?: number }
export interface Job { id: string; input: ImportRequest; status: string; done: number; total: number; message: string; created: number }
export class MangaStore {
  readonly db: Database;
  constructor(readonly root: string) {
    mkdirSync(join(root, "packs"), { recursive: true });
    this.db = new Database(join(root, "manga.sqlite"));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS books (id TEXT PRIMARY KEY, data TEXT NOT NULL, imported INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, input TEXT NOT NULL, status TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0, message TEXT NOT NULL DEFAULT '', created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS progress_parts (device TEXT NOT NULL, slug TEXT NOT NULL, updated INTEGER NOT NULL, part INTEGER NOT NULL, total INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(device,slug,updated,part));
      CREATE TABLE IF NOT EXISTS progress (device TEXT NOT NULL, slug TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(device, slug));`);
  }
  sources(): Source[] { return (this.db.query("SELECT data FROM sources ORDER BY id").all() as { data: string }[]).map(r => JSON.parse(r.data)); }
  source(id: string): Source {
    const row = this.db.query("SELECT data FROM sources WHERE id = ?").get(id) as { data: string } | null;
    if (!row) throw Error("Source not found"); return JSON.parse(row.data);
  }
  addSource(source: Source) { this.db.query("INSERT OR REPLACE INTO sources VALUES (?, ?)").run(source.id, JSON.stringify(source)); }
  removeSource(id: string) { this.db.query("DELETE FROM sources WHERE id = ?").run(id); }
  index(): LibraryIndex { return { v: 3, series: (this.db.query("SELECT data FROM books ORDER BY id").all() as { data: string }[]).map(r => JSON.parse(r.data)) }; }
  publish(book?: SeriesSummary) {
    // Only the companion main process publishes catalogs. Workers send completed
    // summaries; publication and SQLite mutation share the same serial queue.
    return this.db.transaction(() => {
      if (book) this.db.query("INSERT OR REPLACE INTO books VALUES (?, ?, ?)").run(book.slug, JSON.stringify(book), Date.now());
      return publishCatalog(this.root, this.index());
    })();
  }
  removeBook(id: string) { return this.db.transaction(() => { this.db.query("DELETE FROM books WHERE id = ?").run(id); return this.publish(); })(); }
  enqueue(input: ImportRequest): Job {
    if ((!input.source || !input.book) && !input.url) throw Error("Select a source series or supply a CBZ / MangaDex URL");
    if (!/^[a-z]{2}(-[a-z]{2})?$/.test(input.language)) throw Error("Invalid language code");
    if (input.url && input.url.length > 4096 || input.title && input.title.length > 240) throw Error("Import input too long");
    for (const value of [input.from, input.to]) if (value !== undefined && (!Number.isInteger(value) || value < 1 || value > 10000)) throw Error("Invalid chapter range");
    if (input.from && input.to && input.from > input.to) throw Error("Chapter range is reversed");
    const raw = JSON.stringify(input);
    const existing = this.db.query("SELECT id FROM jobs WHERE input = ? AND status IN ('queued','running')").get(raw) as { id: string } | null;
    if (existing) return this.job(existing.id)!;
    const id = crypto.randomUUID();
    this.db.query("INSERT INTO jobs(id,input,status,created) VALUES(?,?,'queued',?)").run(id, raw, Date.now());
    return this.job(id)!;
  }
  job(id: string): Job | undefined {
    const row = this.db.query("SELECT * FROM jobs WHERE id = ?").get(id) as any;
    return row ? { ...row, input: JSON.parse(row.input) } : undefined;
  }
  jobs(): Job[] { return (this.db.query("SELECT * FROM jobs ORDER BY created DESC LIMIT 100").all() as any[]).map(r => ({ ...r, input: JSON.parse(r.input) })); }
  update(id: string, status: string, message = "", done = 0, total = 0) {
    this.db.query("UPDATE jobs SET status=?,message=?,done=?,total=? WHERE id=?").run(status, message.slice(0, 500), done, total, id);
  }
  close() { this.db.close(); }
}
