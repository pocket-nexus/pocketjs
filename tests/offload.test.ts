import { describe, expect, test } from "bun:test";
import { createOffloadClient, OFFLOAD } from "../framework/src/offload.ts";
import { OffloadDecoder, encodeOffloadRecord } from "../tools/offload-wire.ts";
import { dispatchOffload } from "../tools/offload-provider.ts";
import { sqliteQueries, httpResources } from "../tools/offload-capabilities.ts";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
function rig() {
  let session = 1;
  const sent: string[] = [], replies: string[] = [];
  const client = createOffloadClient({ session: () => session, submit: record => { sent.push(record); return true; }, take: () => replies.shift() });
  return { client, sent, replies, disconnect: () => session = -1, reconnect: () => session = 2 };
}
describe("offload budgets and failure delivery", () => {
  test("native SPSC concurrency, wrap and coverage decoder pass sanitizers", () => {
    const scratch = mkdtempSync(join(tmpdir(), "pocket-offload-"));
    try {
      const binary = join(scratch, "queue");
      const compile = Bun.spawnSync(["cc", "-std=c11", "-O2", "-pthread", "-fsanitize=address,undefined", resolve(import.meta.dir, "fixtures/offload-queue.c"), "-o", binary]);
      if (compile.exitCode !== 0) throw new Error(`Native offload compile failed (exit ${compile.exitCode}, signal ${compile.signalCode}): ${compile.stderr.toString()}`);
      const run = Bun.spawnSync([binary]);
      if (run.exitCode !== 0) throw new Error(`Native offload harness failed (exit ${run.exitCode}, signal ${run.signalCode}): ${run.stderr.toString()}`);
      expect(run.stdout.toString()).toContain("100000 SPSC records verified");
    } finally { rmSync(scratch, { recursive: true }); }
  }, 30_000); // Includes sanitizer compilation on shared CI runners.
  test("limits tickets, submissions and deliveries independently", () => {
    const r = rig(); let delivered = 0;
    for (let i = 0; i < 8; i++) expect(r.client.request("db.page", "{}", () => delivered++)).toBeGreaterThan(0);
    expect(r.client.request("db.page", "{}", () => {})).toBe(0);
    r.client.step(); expect(r.sent.length).toBe(2);
    for (const s of r.sent) r.replies.push(JSON.stringify({ id: JSON.parse(s).id, payload: "[]" }));
    r.client.step(); expect(delivered).toBe(1); expect(r.sent.length).toBe(4);
    r.client.step(); expect(delivered).toBe(2);
  });
  test("does not replay sent mutations or deliver old connection results", () => {
    const r = rig(); const results: unknown[] = [];
    const id = r.client.request("file.save", "edit", p => results.push(p));
    r.client.step(); r.disconnect(); r.client.step();
    expect(results).toHaveLength(1); expect(results[0]).toMatchObject({ ok: false });
    r.reconnect(); r.replies.push(JSON.stringify({ id, payload: "saved" })); r.client.step();
    expect(r.client.session()).toBe(2);
    expect(results).toHaveLength(1); expect(r.sent).toHaveLength(1);
  });
  test("cancellation, timeout and malformed records leave bounded state", () => {
    const r = rig(); let delivered = 0;
    const id = r.client.request("slow.query", "{}", () => delivered++);
    r.client.cancel(id); r.client.step(); expect(r.sent).toHaveLength(0);
    r.client.request("slow.query", "{}", () => delivered++);
    r.replies.push("{bad");
    for (let i = 0; i <= OFFLOAD.timeoutFrames; i++) r.client.step();
    expect(delivered).toBe(1); expect(r.client.pending()).toBe(0);
    expect(() => r.client.request("db.page", "中".repeat(2500), () => {})).toThrow();
  });
  test("UTF-8 records survive every split and reject oversized length immediately", () => {
    const record = JSON.stringify({ text: "文档 😀" }), bytes = encodeOffloadRecord(record);
    for (let split = 0; split <= bytes.length; split++) {
      const decoder = new OffloadDecoder(), out: string[] = [];
      decoder.push(bytes.subarray(0, split), s => out.push(s)); decoder.push(bytes.subarray(split), s => out.push(s));
      expect(out).toEqual([record]);
    }
    expect(() => new OffloadDecoder().push(Buffer.from([0, 0, 16, 1]), () => {})).toThrow();
  });
  test("provider enforces grants and reply budgets", async () => {
    expect(await dispatchOffload({}, { v: 1, id: 1, method: "constructor", payload: "" })).toHaveProperty("error");
    expect(await dispatchOffload({ large: () => "x".repeat(3000) }, { v: 1, id: 2, method: "large", payload: "" })).toHaveProperty("error");
    expect(await dispatchOffload({ query: () => "[]" }, { v: 1, id: 3, method: "query", payload: "" })).toEqual({ id: 3, payload: "[]" });
  });
  test("SQLite query grants accept values and reject unbounded results", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE notes(id INTEGER, title TEXT); INSERT INTO notes VALUES(1,'hello'),(2,'world')");
    const methods = sqliteQueries(db, { find: "SELECT title FROM notes WHERE id=? LIMIT 1", large: "SELECT hex(zeroblob(2000))" });
    expect(methods.find("[2]")).toBe('[{"title":"world"}]');
    expect(() => methods.large("[]")).toThrow("bounded page");
    expect(() => methods.find('{"sql":"DROP TABLE notes"}')).toThrow();
    db.close();
  });
  test("HTTP grants reject redirects and stop oversized streams", async () => {
    const server = Bun.serve({ port: 0, fetch: r => new URL(r.url).pathname === "/redirect" ? Response.redirect("https://example.com") : new Response(new URL(r.url).pathname === "/big" ? "x".repeat(3000) : "remote data") });
    try {
      const m = httpResources({ small: `${server.url}small`, big: `${server.url}big`, redirect: `${server.url}redirect` });
      expect(await m.small("")).toBe("remote data");
      await expect(m.big("")).rejects.toThrow(); await expect(m.redirect("")).rejects.toThrow();
    } finally { server.stop(true); }
  });
});
