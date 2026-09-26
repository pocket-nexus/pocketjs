import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { MangaStore } from "./store.ts";

export function runJobs(store: MangaStore, allowPrivate = false) {
  store.db.query("UPDATE jobs SET status='failed',message='Relay stopped during import; retry the import' WHERE status='running'").run();
  let active: { id: string; child: ReturnType<typeof Bun.spawn> } | undefined, stopped = false;
  const pump = () => {
    if (stopped || active) return;
    const job = store.db.query("SELECT id FROM jobs WHERE status='queued' ORDER BY created LIMIT 1").get() as { id: string } | null;
    if (!job) return;
    const item = store.job(job.id)!;
    let stage: string | undefined;
    try {
      const source = item.input.source ? store.source(item.input.source) : undefined;
      stage = mkdtempSync(join(store.root, "import-"));
      const child = Bun.spawn([process.execPath, fileURLToPath(new URL("./job-worker.ts", import.meta.url))], {
        stdin: "ignore", stdout: "ignore", stderr: "inherit", serialization: "advanced",
        ipc(data) {
          if (active?.child !== child) return;
          if (data.error) finish(String(data.error));
          else if (data.book) {
            try { store.publish(data.book); finish(); }
            catch (error) { finish(String(error)); }
          } else store.update(job.id, "running", data.message, data.done, data.total);
        },
        onExit(_child, code) {
          if (stage) rmSync(stage, { recursive: true, force: true });
          if (active?.child === child) finish(`Import process stopped (exit ${code})`);
        },
      });
      active = { id: job.id, child };
      function finish(error?: string) {
        if (active?.child !== child) return;
        store.update(job!.id, error ? "failed" : "completed", error ?? "Ready to read");
        active = undefined; child.kill(); queueMicrotask(pump);
      }
      store.update(job.id, "running", "Resolving source");
      child.send({ root: store.root, input: item.input, source, allowPrivate, stage });
    } catch (error) {
      if (active?.id === job.id) { const child = active.child; active = undefined; child.kill(); }
      if (stage) rmSync(stage, { recursive: true, force: true });
      store.update(job.id, "failed", String(error)); queueMicrotask(pump);
    }
  };
  const timer = setInterval(pump, 500);
  return {
    pump,
    cancel(id: string) {
      const job = store.job(id);
      if (!job || !["queued", "running"].includes(job.status)) return;
      store.update(id, "cancelled", "Cancelled");
      if (active?.id === id) { const child = active.child; active = undefined; child.kill(); }
      pump();
    },
    retry(id: string) {
      const job = store.job(id);
      if (!job || !["failed", "cancelled"].includes(job.status)) throw Error("Only failed or cancelled imports can be retried");
      store.update(id, "queued"); pump();
    },
    close() {
      stopped = true; clearInterval(timer);
      if (active) { const { child, id } = active; active = undefined; store.update(id, "failed", "Relay stopped during import; retry"); child.kill(); }
    },
  };
}
