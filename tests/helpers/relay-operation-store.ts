/** Transaction fixture: receipts and effects use the same SQLite database. */
import { Database } from "bun:sqlite";
import type { RelayOperationNamespace, RelayOperationScope, RelayOperationStore } from "../../framework/src/relay/operation.ts";

export class SqliteOperationStore implements RelayOperationStore {
  readonly durable = true;
  readonly db: Database;
  constructor(path = ":memory:") {
    this.db = new Database(path);
    this.db.exec("CREATE TABLE IF NOT EXISTS operations (scope TEXT PRIMARY KEY, state TEXT NOT NULL)");
    this.db.exec("CREATE TABLE IF NOT EXISTS effects (id TEXT PRIMARY KEY, hits INTEGER NOT NULL)");
  }
  transact<T>(scope: Readonly<RelayOperationScope>,
    update: (current: Readonly<RelayOperationNamespace> | undefined) => { state: RelayOperationNamespace; value: T }): T {
    return this.db.transaction(() => {
      const key = JSON.stringify([scope.authority, scope.writer, scope.ns]);
      const row = this.db.query("SELECT state FROM operations WHERE scope = ?").get(key) as { state: string } | null;
      const result = update(row ? JSON.parse(row.state) : undefined);
      this.db.query("INSERT INTO operations VALUES (?, ?) ON CONFLICT(scope) DO UPDATE SET state = excluded.state").run(key, JSON.stringify(result.state));
      return result.value;
    }).immediate();
  }
  effect(id: string): void {
    this.db.query("INSERT INTO effects VALUES (?, 1) ON CONFLICT(id) DO UPDATE SET hits = hits + 1").run(id);
  }
  hits(id: string): number {
    return (this.db.query("SELECT hits FROM effects WHERE id = ?").get(id) as { hits: number } | null)?.hits ?? 0;
  }
}
